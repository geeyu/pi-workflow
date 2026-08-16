/**
 * observe/monitor.ts — 监听与批次推进(设计 §4.5 崩溃恢复 / §5.5 监听 / §7.2 合并)
 *
 * - pollOnce:tab 存活检测(ghostctl layout 按 tab_id=terminal id 匹配),
 *   running/dispatched 步骤的 tab 消失且未回报 → step_tab_closed → aborted
 * - recoverStaleSteps:崩溃恢复(编排者 session_start 时调用)
 * - getReadySteps:就绪集(pending 且依赖全 done/skipped,wave 推进用)
 * - mergeWave:wave 全部终态后按 sort_order 串行 gittree merge --delete,
 *   冲突 → 步骤 conflict(事件 merge_conflict),wave → merged(事件 wave_merged)
 */
import type { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	ATTEMPT_STATUS,
	DB_PATH,
	EVT,
	STEP_STATUS,
	WORKFLOW_STATUS,
	type StepRow,
	addEvent,
	buildUpdate,
	getLatestAttempt,
	getRunningSteps,
	getStepMeta,
	getStepsByWave,
	getStepsByWorkflow,
	getWorkflowMeta,
	listActiveWorkflows,
	listWaves,
	setStepMeta,
	setWorkflowMeta,
	updateStepStatus,
} from "../core/db.ts";
import { depsDone } from "../exec/dispatch.ts";
import { resolveBin, run } from "../exec/shell.ts";

// ────────────────────────────────────────────────────────────
// tab 存活检测
// ────────────────────────────────────────────────────────────

/**
 * poll 达成判定纯函数(wf poll 与编排脚本共用,可单测):
 * - 达成集 = {until} ∪ {skipped}(skipped 是人工终态,任何目标都视为已达成);
 * - pending/ready 视为「未启动」,不参与达成判定(只计数 notStarted);
 * - 参与判定的步骤 ∈ 达成集 → reached;
 * - 任一参与判定步骤 ∈ {failed, aborted, conflict, needs-fix} 且 ∉ 达成集 → unreachable
 *   (until=failed 时 failed ∈ 达成集,正常达成,不触发不可达)。
 */
export function pollTargetReached(
	steps: StepRow[],
	until: string,
): { reached: boolean; unreachable: string[]; notStarted: number } {
	const goal = new Set([until, "skipped"]);
	const unreachable: string[] = [];
	let notStarted = 0;
	let participating = 0;
	let allInGoal = true;
	for (const s of steps) {
		if (s.status === "pending" || s.status === "ready") {
			notStarted++;
			continue;
		}
		participating++;
		if (goal.has(s.status)) continue;
		if (["failed", "aborted", "conflict", "needs-fix"].includes(s.status)) {
			unreachable.push(s.id);
			continue;
		}
		// 仍在推进中(dispatched/running/reported/waiting-verify 等)
		allInGoal = false;
	}
	// 至少一个参与判定的步骤,且全部 ∈ 达成集,且无不可达
	return {
		reached: participating > 0 && allInGoal && unreachable.length === 0,
		unreachable,
		notStarted,
	};
}

/** 一次 layout 查询,返回所有存活 terminal id(按 tab_id 匹配) */
export async function fetchLiveTabIds(
	ghostctlBin: string,
	cwd: string,
): Promise<Set<string> | null> {
	// 查询失败返回 null:调用方必须跳过本轮,绝不把"查询失败"误判为"所有 tab 消失"
	const res = await run(ghostctlBin, ["layout", "--json"], cwd);
	if (res.code !== 0) return null;
	try {
		const layout = JSON.parse(res.stdout) as {
			windows: Array<{ tabs: Array<{ terminals: Array<{ id: string }> }> }>;
		};
		const ids = new Set<string>();
		for (const w of layout.windows) {
			for (const t of w.tabs) {
				for (const term of t.terminals) ids.add(term.id);
			}
		}
		return ids;
	} catch {
		return null;
	}
}

export interface PollResult {
	closed: string[]; // 本次检测到 tab 消失的步骤 id
	timedOut: string[]; // 本次检测到超时的步骤 id
}

/** 连续未命中轮询次数达到该值才判 tab 关闭(抗 Ghostty layout 瞬时抖动) */
export const TAB_MISS_LIMIT = 2;
/** 未命中计数存 workflow_step_metadata 的 key */
export const TAB_MISS_KEY = "tab_miss_count";

/**
 * 存活检测一轮:running/dispatched 且记录了 tab_id 的步骤,
 * 其 terminal 不在布局中 → 事件 step_tab_closed → 步骤/attempt 标 aborted。
 * 无 tab_id 的步骤跳过(无法判定,交给人工)。
 * 另检查 timeout_min 超时(设计 §10 护栏):running 超时 → aborted。
 */
export async function pollOnce(
	db: DatabaseSync,
	opts: { ghostctlBin?: string; repoPath?: string } = {},
): Promise<PollResult> {
	let running = getRunningSteps(db);
	if (opts.repoPath) {
		// 会话隔离:只轮询 cwd 所在仓库的步骤(谁发起谁看)
		const mine = new Set(listActiveWorkflows(db, opts.repoPath).map((w) => w.id));
		running = running.filter((s) => mine.has(s.workflow_id));
	}
	if (running.length === 0) return { closed: [], timedOut: [] };

	const ghostctlBin = opts.ghostctlBin ?? resolveBin("ghostctl");
	// 按仓库分组,每个仓库一次 layout
	const byRepo = new Map<string, StepRow[]>();
	for (const s of running) {
		const repo = getRepoOfStep(db, s.id);
		if (!repo) continue;
		if (!byRepo.has(repo)) byRepo.set(repo, []);
		byRepo.get(repo)!.push(s);
	}

	const closed: string[] = [];
	const timedOut: string[] = [];
	const nowMs = Date.now();
	// 超时检查(不依赖 ghostctl)
	for (const s of running) {
		if (
			s.status === "running" &&
			s.started_at &&
			s.timeout_min > 0 &&
			nowMs - s.started_at > s.timeout_min * 60_000
		) {
			const reason = `超时(${s.timeout_min}min 未完成)`;
			updateStepStatus(
				db,
				s.id,
				STEP_STATUS.aborted,
				{ error: reason },
				{ strict: true },
			);
			const attempt = getLatestAttempt(db, s.id);
			if (attempt && attempt.status === ATTEMPT_STATUS.running) {
				buildUpdate(
					db,
					"workflow_attempts",
					{ status: "aborted", error: reason, finished_at: Date.now() },
					{ id: attempt.id },
				);
			}
			addEvent(db, {
				workflowId: s.workflow_id,
				stepId: s.id,
				attemptId: attempt?.id,
				type: EVT.stepAborted,
				payload: { reason },
			});
			timedOut.push(s.id);
		}
	}

	for (const [repo, steps] of byRepo) {
		const live = await fetchLiveTabIds(ghostctlBin, repo);
		if (!live) continue; // 查询失败 → 本轮跳过,不误标 aborted
		for (const s of steps) {
			if (!s.tab_id) continue;
			if (live.has(s.tab_id)) {
				// 存活 → 清零未命中计数(Ghostty layout 偶发缺项,单次未命中不判死)
				const miss = getStepMeta(db, s.id, TAB_MISS_KEY);
				if (miss !== undefined && miss !== null) {
					setStepMeta(db, s.id, TAB_MISS_KEY, 0);
				}
				continue;
			}
			// 未命中 → 计数,连续 TAB_MISS_LIMIT 次才判关闭
			const prev = (getStepMeta(db, s.id, TAB_MISS_KEY) as number | null) ?? 0;
			const next = prev + 1;
			if (next < TAB_MISS_LIMIT) {
				setStepMeta(db, s.id, TAB_MISS_KEY, next);
				continue;
			}
			setStepMeta(db, s.id, TAB_MISS_KEY, 0);
			// tab 消失且未回报 → aborted
			updateStepStatus(
				db,
				s.id,
				STEP_STATUS.aborted,
				{ error: "tab 已关闭(未回报)" },
				{ strict: true },
			);
			const attempt = getLatestAttempt(db, s.id);
			if (attempt && attempt.status === ATTEMPT_STATUS.running) {
				buildUpdate(
					db,
					"workflow_attempts",
					{
						status: "aborted",
						error: "tab 已关闭(未回报)",
						finished_at: Date.now(),
					},
					{ id: attempt.id },
				);
			}
			addEvent(db, {
				workflowId: s.workflow_id,
				stepId: s.id,
				attemptId: attempt?.id,
				type: EVT.stepTabClosed,
				payload: { tabId: s.tab_id },
			});
			closed.push(s.id);
		}
	}
	return { closed, timedOut };
}

/** 步骤所属仓库根(workflow.repo_path) */
function getRepoOfStep(db: DatabaseSync, stepId: string): string | null {
	const stmt = db.prepare(
		"SELECT w.repo_path FROM workflow_steps s JOIN workflow w ON w.id = s.workflow_id WHERE s.id = ?",
	);
	const row = stmt.get(stepId) as { repo_path: string } | undefined;
	return row?.repo_path ?? null;
}

/** 崩溃恢复:编排者启动时立即检测一轮(等价 pollOnce,tab 还在的保持 running) */
export function recoverStaleSteps(
	db: DatabaseSync,
	opts: { ghostctlBin?: string } = {},
): Promise<PollResult> {
	return pollOnce(db, opts);
}

export interface MonitorOptions {
	/** 轮询间隔,默认 5000ms(设计决策 12);fs.watch 事件驱动为毫秒级主通道 */
	intervalMs?: number;
	/** fs.watch 触发后的 debounce 合并窗口,默认 300ms(高频写合并) */
	watchDebounceMs?: number;
	ghostctlBin?: string;
	/** 会话隔离:只轮询/通知 cwd 所在仓库的 workflow(谁发起谁看);缺省 = 全量 */
	cwd?: string;
	/** 本轮检测到 tab 消失的步骤 */
	onClosed?: (closed: string[]) => void;
	/** 本轮检测到的关键状态事件(主控自主编排通知,已按 attempt 去重) */
	onState?: (items: NotifyItem[]) => void | Promise<void>;
	/** 每轮结束回调(如刷新 widget) */
	onTick?: () => void;
}

/**
 * 启动存活轮询。编排者侧调用;返回 stop 函数(session_shutdown 时调用)。
 * 幂等:已 aborted 的步骤不会重复标记。
 */
export function startMonitor(
	db: DatabaseSync,
	opts: MonitorOptions = {},
): () => void {
	const intervalMs = opts.intervalMs ?? 5000;
	let timer: ReturnType<typeof setInterval> | null = null;
	let ticking = false;
	// ── fs.watch 事件驱动(WAL 模式写 .db-wal,故监听 DB 目录)──
	// 任何进程(子 agent / CLI)写入 DB → 目录事件 → debounce 后立即检测通知,
	// 毫秒级送达(非 5s 轮询);5s 轮询保留为兜底(防 watch 漏事件/文件替换)。
	let watchDebounce: ReturnType<typeof setTimeout> | null = null;
	let watcher: fs.FSWatcher | null = null;
	const dbBase = path.basename(DB_PATH); // workflow.db / 测试库 test.db
	try {
		watcher = fs.watch(path.dirname(DB_PATH), (_ev, filename) => {
			if (filename && !String(filename).startsWith(dbBase)) return;
			if (watchDebounce) return; // 已排程,合并高频写
			watchDebounce = setTimeout(() => {
				watchDebounce = null;
				void tick();
			}, opts.watchDebounceMs ?? 300);
		});
	} catch {
		/* fs.watch 不可用(网络盘等)则纯轮询兜底 */
	}
	const tick = async (): Promise<void> => {
		if (ticking) return;
		ticking = true;
		try {
			const { closed } = await pollOnce(db, {
				ghostctlBin: opts.ghostctlBin,
				repoPath: opts.cwd,
			});
			if (closed.length > 0) opts.onClosed?.(closed);
			// 状态事件检测(主控自主编排):扫描 DB 快照,产出未通知的关键事件
			const items = detectStateChanges(db, { repoPath: opts.cwd });
			if (items.length > 0) await opts.onState?.(items);
			opts.onTick?.();
		} catch {
			/* 轮询异常不中断后续 */
		} finally {
			ticking = false;
		}
	};
	timer = setInterval(() => void tick(), intervalMs);
	return () => {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
		if (watchDebounce) {
			clearTimeout(watchDebounce);
			watchDebounce = null;
		}
		watcher?.close();
		watcher = null;
	};
}

// ────────────────────────────────────────────────────────────
// 状态事件检测(设计增强①:主控自主编排通知)
// ────────────────────────────────────────────────────────────
export type NotifyKind =
	| "reported"
	| "waiting-verify"
	| "failed"
	| "aborted"
	| "conflict"
	| "needs-fix"
	| "wave-done"
	| "workflow-done";

/** 关键状态事件(步骤级;stepId 缺省时按 kind 区分 wave/workflow 级) */
export interface NotifyItem {
	workflowId: string;
	stepId?: string;
	/** wave 级事件携带 wave 序号(去重 key 与文案用) */
	waveSeq?: number;
	kind: NotifyKind;
	text: string;
}

export interface DetectOptions {
	/** 测试用:标记时间戳 */
	now?: number;
	/** 会话隔离:只检测 cwd 所在仓库的 workflow(谁发起谁看) */
	repoPath?: string;
}

/** 步骤状态 → 事件 kind(仅关键状态,其余不通知) */
const KIND_BY_STATUS: Record<string, NotifyKind> = {
	[STEP_STATUS.reported]: "reported",
	[STEP_STATUS.waitingVerify]: "waiting-verify",
	[STEP_STATUS.failed]: "failed",
	[STEP_STATUS.aborted]: "aborted",
	[STEP_STATUS.conflict]: "conflict",
	[STEP_STATUS.needsFix]: "needs-fix",
};

/** 步骤级事件文案(必含具体可执行的 /wf 命令) */
function stepNotifyText(kind: NotifyKind, stepId: string): string {
	switch (kind) {
		case "reported":
			return `步骤 ${stepId} 已回报 → 请执行 /wf verify ${stepId} approve(或 /wf status 查看)`;
		case "waiting-verify":
			return `gate 步骤 ${stepId} 待核对 → 请执行 /wf verify ${stepId} approve 或 /wf verify ${stepId} reject <原因>`;
		case "failed":
			return `步骤 ${stepId} 失败 → 请执行 /wf step ${stepId} 查看错误,再 /wf retry ${stepId}`;
		case "aborted":
			return `步骤 ${stepId} 中止(超时/tab 关闭)→ 请执行 /wf step ${stepId} 查看原因,再 /wf retry ${stepId}`;
		case "conflict":
			return `步骤 ${stepId} 合并冲突 → 解决后 /wf resolve-conflict ${stepId},再 /wf merge`;
		case "needs-fix":
			return `步骤 ${stepId} 被驳回待修复 → 请执行 /wf step ${stepId} 查看原因,再 /wf retry ${stepId}`;
		default:
			return stepId;
	}
}

const NOTIFY_WF_DONE_KEY = "notify:workflow:done";

function waveDoneKey(seq: number): string {
	return `notify:wave:${seq}:done`;
}

/**
 * 状态事件检测(纯 DB 扫描,无外部副作用):
 * 在 monitor tick 内对 DB 全量快照检测「新发生」的关键状态,返回尚未通知的事件。
 * 去重采用 workflow_step_metadata / workflow_metadata KV(调用方发送成功后 markNotified 落标记):
 * - 步骤级:key=notify:<kind>,value={attemptId,at};同 attempt 只通知一次,attemptId 变化(重试后)重新通知;
 * - wave 级:key=notify:wave:<seq>:done;workflow 级:key=notify:workflow:done。
 * 事件集:reported(非 gate)/ waiting-verify(gate)/ failed / aborted / conflict / needs-fix /
 * wave 全部终态 / 全流程所有 wave 已合并。
 */
export function detectStateChanges(
	db: DatabaseSync,
	opts: DetectOptions = {},
): NotifyItem[] {
	const items: NotifyItem[] = [];
	for (const wf of listActiveWorkflows(db, opts.repoPath)) {
		// 1) 步骤级:关键状态且未通知(同 attempt)
		for (const s of getStepsByWorkflow(db, wf.id)) {
			const kind = KIND_BY_STATUS[s.status];
			if (!kind) continue;
			const attemptId = getLatestAttempt(db, s.id)?.id ?? null;
			const meta = getStepMeta(db, s.id, `notify:${kind}`) as
				| { attemptId?: number | null }
				| undefined;
			if (meta && (meta.attemptId ?? null) === attemptId) continue;
			items.push({
				workflowId: wf.id,
				stepId: s.id,
				kind,
				text: stepNotifyText(kind, s.id),
			});
		}
		// 2) wave 级:未合并 wave 且全部步骤终态(done/skipped)→ 提示合并
		const waves = listWaves(db, wf.id);
		for (const wave of waves) {
			if (wave.status === "merged") continue;
			const steps = getStepsByWave(db, wave.id);
			if (steps.length === 0) continue;
			if (
				!steps.every(
					(s) => s.status === STEP_STATUS.done || s.status === STEP_STATUS.skipped,
				)
			) {
				continue;
			}
			if (getWorkflowMeta(db, wf.id, waveDoneKey(wave.seq)) !== undefined) {
				continue;
			}
			const mergeCmd =
				wave.seq === wf.current_wave ? "/wf merge" : `/wf merge --wave ${wave.seq}`;
			items.push({
				workflowId: wf.id,
				waveSeq: wave.seq,
				kind: "wave-done",
				text: `wave ${wave.seq} 全部完成 → 请执行 ${mergeCmd}(前置可先 wf cleanup)`,
			});
		}
		// 3) workflow 级:所有 wave 已合并且未完成目标把关 → 提示目标把关
		// (已 completed / 已 reject 进入 gap wave 后不再补发过时提醒)
		if (
			wf.status !== WORKFLOW_STATUS.completed &&
			waves.length > 0 &&
			waves.every((w) => w.status === "merged") &&
			getWorkflowMeta(db, wf.id, NOTIFY_WF_DONE_KEY) === undefined
		) {
			items.push({
				workflowId: wf.id,
				kind: "workflow-done",
				text: `workflow ${wf.id} 所有 wave 已合并 → 请执行 /wf goal-check approve`,
			});
		}
	}
	return items;
}

/**
 * 落去重标记(发送成功后调用;失败不标记,下轮重试):
 * 步骤级记 {attemptId, at}(attemptId 变化后重新通知);wave/workflow 级记 {at}。
 */
export function markNotified(
	db: DatabaseSync,
	item: NotifyItem,
	opts: DetectOptions = {},
): void {
	const at = opts.now ?? Date.now();
	if (item.stepId) {
		const attempt = getLatestAttempt(db, item.stepId);
		setStepMeta(db, item.stepId, `notify:${item.kind}`, {
			attemptId: attempt?.id ?? null,
			at,
		});
		return;
	}
	if (item.kind === "wave-done" && item.waveSeq !== undefined) {
		setWorkflowMeta(db, item.workflowId, waveDoneKey(item.waveSeq), { at });
		return;
	}
	if (item.kind === "workflow-done") {
		setWorkflowMeta(db, item.workflowId, NOTIFY_WF_DONE_KEY, { at });
	}
}

// ────────────────────────────────────────────────────────────
// 就绪集(wave 推进)
// ────────────────────────────────────────────────────────────
/** 就绪集:status=pending 且依赖全部 done/skipped */
export function getReadySteps(
	db: DatabaseSync,
	workflowId: string,
	waveId?: number,
): StepRow[] {
	const steps = waveId
		? getStepsByWave(db, waveId)
		: getStepsByWorkflow(db, workflowId);
	return steps.filter(
		(s) => s.status === STEP_STATUS.pending && depsDone(db, s),
	);
}

// ────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────
// 兼容再导出壳(arch-refactor §3.9)
// mergeWave/mergePreview 已移至 observe/wave.ts,同名再导出保持外部调用面不变。
// ────────────────────────────────────────────────────────────
export { mergeWave, mergePreview } from "./wave.ts";
export type { MergeResult } from "./wave.ts";
