/**
 * exec/dispatch.ts — 子任务派发核心(设计文档 §5.3 / §6.1 / §7)
 *
 * 1.2 模块拆分后:保留派发主流程(dispatchStep)与去重复用(isTerminalAlive);
 * 进程执行/worktree 路径 → exec/shell.ts,窗口操作 → exec/window.ts,
 * 任务模板 → exec/template.ts;文件末尾为兼容再导出壳(arch-refactor §3.9)。
 *
 * 派发一个子任务:
 *   1. gittree create wf-<workflow>-<dotted>(冻结 base_sha,事件 worktree_created)
 *   2. 渲染 task_md(目标 + 本步任务 + 期望 + 输出契约 + worktree 约束,模板注入依赖结果)
 *      → 写入 workflow_steps.task_md;事件 step_dispatched
 *   3. 组装短指引 pointer → 写入 workflow_attempts.pointer
 *   4. ghostctl new-tab --cwd <worktree> --command "env PI_WF_* pi '<pointer>'"
 *      (pointer 为 pi 位置参数,由 pi 自身在 UI 就绪后自动发送,无注入/盲等/回车)
 *      (事件 step_tab_opened,记录 tab_id)
 *
 * 任务正文存库(pointer 只带短指引经位置参数交付,杜绝长文本/中文粘贴错乱)。
 */

import type { DatabaseSync } from "node:sqlite";
import {
	EVT,
	type StepRow,
	type WorkflowRow,
	addEvent,
	buildUpdate,
	createAttempt,
	getStep,
	getStepDeps,
} from "../core/db.ts";
import { resolveBin, run, worktreeName, worktreePath } from "./shell.ts";
import { openStepTab } from "./window.ts";
import { buildPointer, renderTaskMd } from "./template.ts";

export interface DispatchResult {
	ok: boolean;
	stepId: string;
	worktree?: string;
	worktreePath?: string;
	attemptNo?: number;
	tabId?: string | null;
	pointer?: string;
	error?: string;
	dryRun?: boolean;
	/** 去重复用:重派时原 tab 仍存活,未开新 tab,已恢复 running */
	reused?: boolean;
}

export async function isTerminalAlive(
	ghostctlBin: string,
	cwd: string,
	terminalId: string,
): Promise<boolean | undefined> {
	const res = await run(ghostctlBin, ["layout", "--json"], cwd);
	if (res.code !== 0) return undefined;
	try {
		const layout = JSON.parse(res.stdout) as {
			windows: Array<{ tabs: Array<{ terminals: Array<{ id: string }> }> }>;
		};
		for (const w of layout.windows) {
			for (const t of w.tabs) {
				for (const term of t.terminals) {
					if (term.id === terminalId) return true;
				}
			}
		}
		return false;
	} catch {
		return undefined;
	}
}

/**
 * workflow 绑定窗口(设计:一次 workflow 一个完整窗口流程):
 * 首次派发把当前焦点窗口记为绑定窗口(存 workflow_metadata.ghostty_window_id),
 * 之后所有子任务 tab 固定开进该窗口 —— 按窗口 id 定位(ghostctl new-tab --window-id),
 * 不依赖窗口序号/焦点,窗口开合不会漂移;
 * 绑定窗口已关闭则返回错误,绝不静默回退焦点窗口。
 */

function abortDispatch(
	db: DatabaseSync,
	attemptId: number,
	step: StepRow,
	workflowId: string,
	reason: string,
	detail: string,
): void {
	const errText = `${reason}: ${detail}`;
	buildUpdate(
		db,
		"workflow_attempts",
		{ status: "aborted", error: errText },
		{ id: attemptId },
	);
	buildUpdate(
		db,
		"workflow_steps",
		{ status: "failed", error: errText, updated_at: Date.now() },
		{ id: step.id },
	);
	addEvent(db, {
		workflowId,
		stepId: step.id,
		attemptId,
		type: EVT.stepAborted,
		payload: { reason, detail },
	});
}

export interface DispatchOptions {
	dryRun?: boolean;
	/** fresh=true:先 gittree clean --branch --force 重建 worktree(设计 §7.1) */
	fresh?: boolean;
	/** 覆盖 gittree/ghostctl 可执行文件(测试用) */
	gittreeBin?: string;
	ghostctlBin?: string;
}

const DISPATCHABLE = new Set([
	"pending",
	"ready",
	"failed",
	"aborted",
	"needs-fix",
]);

/**
 * 派发单个步骤。
 * 前置:step 存在且状态允许派发(pending/ready/failed/aborted/needs-fix)。
 */
export async function dispatchStep(
	db: DatabaseSync,
	workflow: WorkflowRow,
	step: StepRow,
	opts: DispatchOptions = {},
): Promise<DispatchResult> {
	const dotted = step.id.slice(workflow.id.length + 1);
	const wtName = worktreeName(workflow.id, dotted);
	const wtPath = worktreePath(workflow.repo_path, workflow.id, dotted);
	const dryRun = Boolean(opts.dryRun);
	const waveSeq = workflow.current_wave || 1;

	if (!DISPATCHABLE.has(step.status)) {
		return {
			ok: false,
			stepId: step.id,
			error: `状态 ${step.status} 不允许派发(仅 ${[...DISPATCHABLE].join("/")})`,
		};
	}

	// 去重复用:重派(failed/aborted/needs-fix)时原 tab 仍存活(monitor 误判、
	// 状态回退等场景)→ 实时查一次 layout,存活则恢复 running,绝不重开新 tab。
	// 复用不消耗 retries_done(未真正重派);--fresh 语义为重建,跳过此检查。
	const isRetry = ["failed", "aborted", "needs-fix"].includes(step.status);
	if (isRetry && step.tab_id && !opts.fresh) {
		const alive = await isTerminalAlive(
			opts.ghostctlBin ?? resolveBin("ghostctl"),
			workflow.repo_path,
			step.tab_id,
		);
		if (alive === true) {
			buildUpdate(
				db,
				"workflow_steps",
				{ status: "running", error: null, updated_at: Date.now() },
				{ id: step.id },
			);
			addEvent(db, {
				workflowId: workflow.id,
				stepId: step.id,
				type: EVT.stepTabReused,
				payload: { tabId: step.tab_id, dotted },
			});
			return {
				ok: true,
				stepId: step.id,
				worktree: wtName,
				worktreePath: wtPath,
				tabId: step.tab_id,
				reused: true,
			};
		}
	}

	// 重试上限(设计 P3:超过 max_retries 拒绝,提示人工处理)
	if (isRetry && step.retries_done >= step.max_retries) {
		return {
			ok: false,
			stepId: step.id,
			error: `已重试 ${step.retries_done}/${step.max_retries} 次,超过上限;请人工处理后 /wf skip 或调整计划`,
		};
	}

	// 依赖未完成拒绝派发(设计 §4.3 wave 顺序语义:先依赖,后并行,再后续)
	if (!depsDone(db, step)) {
		const pending = getStepDeps(db, step.id).filter((depId) => {
			const dep = getStep(db, depId);
			return !dep || !["done", "skipped"].includes(dep.status);
		});
		return {
			ok: false,
			stepId: step.id,
			error: `依赖未完成,先完成: ${pending.join(", ")}`,
		};
	}

	const pointer = buildPointer(workflow.id, dotted, waveSeq);

	if (dryRun) {
		return {
			ok: true,
			stepId: step.id,
			worktree: wtName,
			worktreePath: wtPath,
			pointer,
			dryRun: true,
		};
	}

	// 0. 冻结 base_sha(首次派发)
	await ensureBaseSha(db, workflow);

	// 0.5 fresh:先清理旧 worktree 重建(事件 worktree_cleaned,设计 §7.1)
	if (opts.fresh) {
		const cleanRes = await run(
			opts.gittreeBin ?? resolveBin("gittree"),
			["clean", wtName, "--branch", "--force"],
			workflow.repo_path,
		);
		if (cleanRes.code !== 0) {
			return {
				ok: false,
				stepId: step.id,
				error: `gittree clean 失败(可能仍被占用): ${cleanRes.stderr || cleanRes.stdout}`,
			};
		}
		addEvent(db, {
			workflowId: workflow.id,
			stepId: step.id,
			type: EVT.worktreeCleaned,
			payload: { worktree: wtName, fresh: true },
		});
	}

	// 1. worktree(事件 worktree_created)
	const createRes = await run(
		opts.gittreeBin ?? resolveBin("gittree"),
		["create", wtName],
		workflow.repo_path,
	);
	if (
		createRes.code !== 0 &&
		!/已存在|存在/.test(createRes.stdout + createRes.stderr)
	) {
		return {
			ok: false,
			stepId: step.id,
			error: `gittree create 失败: ${createRes.stderr || createRes.stdout}`,
		};
	}
	addEvent(db, {
		workflowId: workflow.id,
		stepId: step.id,
		type: EVT.worktreeCreated,
		payload: { worktree: wtName, path: wtPath },
	});

	// 2. 渲染 task_md 入库 + 状态 dispatched(事件 step_dispatched)
	const taskMd = renderTaskMd(db, workflow, step, waveSeq);
	buildUpdate(
		db,
		"workflow_steps",
		{
			task_md: taskMd,
			worktree: wtName,
			status: "dispatched",
			retries_done: isRetry ? step.retries_done + 1 : step.retries_done,
			updated_at: Date.now(),
		},
		{ id: step.id },
	);
	addEvent(db, {
		workflowId: workflow.id,
		stepId: step.id,
		type: EVT.stepDispatched,
		payload: {
			dotted,
			worktree: wtName,
			retry: isRetry ? step.retries_done + 1 : undefined,
		},
	});

	// 3. attempt 行(冻结 task_md + pointer)
	const attempt = createAttempt(db, step.id, { taskMd, pointer });

	// 4. 开子任务 tab(共享 openStepTab:new-tab → 反查 → 等就绪回车 → 落库)
	// 子任务开 tab,固定开进 workflow 绑定窗口(不受用户切焦点影响)
	const tabRes = await openStepTab(db, workflow, step, {
		ghostctlBin: opts.ghostctlBin,
		attemptId: attempt.id,
	});
	if (!tabRes.ok) {
		// 绑定窗口不可用(含已关闭)/ new-tab 失败 → 中止派发
		const reason = tabRes.phase === "window" ? "绑定窗口不可用" : "new-tab 失败";
		abortDispatch(db, attempt.id, step, workflow.id, reason, tabRes.error ?? "");
		return {
			ok: false,
			stepId: step.id,
			worktree: wtName,
			error: tabRes.error,
		};
	}

	return {
		ok: true,
		stepId: step.id,
		worktree: wtName,
		worktreePath: wtPath,
		attemptNo: attempt.attempt_no,
		tabId: tabRes.tabId,
	};
}

/** 步骤的依赖是否全部终态(done/skipped)— P2 就绪集查询用 */
export function depsDone(db: DatabaseSync, step: StepRow): boolean {
	const depIds = getStepDeps(db, step.id);
	if (depIds.length === 0) return true;
	const stmt = db.prepare("SELECT status FROM workflow_steps WHERE id = ?");
	for (const depId of depIds) {
		const row = stmt.get(depId) as { status: string } | undefined;
		if (!row || !["done", "skipped"].includes(row.status)) return false;
	}
	return true;
}

/** 冻结 base_sha(首次派发时记录当前 HEAD) */
export async function ensureBaseSha(
	db: DatabaseSync,
	workflow: WorkflowRow,
): Promise<void> {
	if (workflow.base_sha) return;
	const res = await run("git", ["rev-parse", "HEAD"], workflow.repo_path);
	if (res.code === 0) {
		const sha = res.stdout.trim();
		if (/^[0-9a-f]{7,40}$/.test(sha)) {
			buildUpdate(
				db,
				"workflow",
				{ base_sha: sha, updated_at: Date.now() },
				{ id: workflow.id },
			);
		}
	}
}

// ────────────────────────────────────────────────────────────
// 兼容再导出壳(arch-refactor §3.9)
// 被拆函数同名再导出,外部调用面(cli/index/monitor/test)零改动;
// 新文件内部 import 一律指向新文件,不经本壳中转。
// ────────────────────────────────────────────────────────────
export {
	sendTextToTerminal,
	openStepTab,
	findTerminalId,
	shellQuote,
	WF_WINDOW_META_KEY,
	type OpenStepTabResult,
	type OpenStepTabOptions,
} from "./window.ts";
export {
	run,
	resolveBin,
	piInvocation,
	worktreeName,
	worktreePath,
	type RunResult,
} from "./shell.ts";
export {
	getDepSummaries,
	injectDeps,
	parseExpectations,
	renderTaskMd,
	buildPointer,
	type DepSummary,
} from "./template.ts";
