/**
 * cli.ts — pi-workflow 辅助命令行(创建/执行/排查)
 *
 * 与插件共享核心逻辑(db/orchestrator/dispatch/validate),不依赖 pi 交互:
 *
 *   wf plan-init <name> "<目标>" [--repo <path>] [--steps N]
 *   wf import <plan.json>
 *   wf status [--json] | wf tree [wf] | wf step <id> | wf events [wf] [N] [--follow]
 *   wf dispatch <dotted...> [--workflow <id>] [--dry-run]
 *   wf rebind-window [wfId] | wf verify <id> approve|reject [原因] | wf done <id> '<JSON>' | wf fail <id> <原因>
 *   wf tabs [wf] [--json] | wf cleanup [wf] [--dry-run] [--no-fix]
 *   wf inject <target> <text...> | wf poll [wf] [--until S] [--timeout T] [--interval I]
 *   wf session [wf|--last] [-n N] [--json] | wf open-tab <stepId> | wf fix-tab <stepId> <tid|auto>
 *   wf clean | wf doctor | wf debug
 *
 * 运行:node --experimental-strip-types src/cli.ts(入口 bin/wf)
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import {
	DB_PATH,
	EVT,
	WORKFLOW_STATUS,
	addEvent,
	buildUpdate,
	createAttempt,
	createWave,
	getEvents,
	getRunningSteps,
	getStep,
	getStepsByWorkflow,
	getWorkflow,
	getWorkflowMeta,
	setWorkflowMeta,
	listActiveWorkflows,
	listWaves,
	listWorkflows,
	stepStatusCounts,
	updateWorkflowStatus,
	workflowCost,
	getDb,
	getAttemptsByStep,
} from "./db.ts";
import type { StepRow } from "./db.ts";
import {
	appendSteps,
	importPlan,
	reportDone,
	reportFail,
	verifyStep,
} from "./orchestrator.ts";
import {
	buildPointer,
	dispatchStep,
	findTerminalId,
	openStepTab,
	resolveBin,
	run,
	sendTextToTerminal,
	worktreePath,
} from "./dispatch.ts";
import { fetchLiveTabIds, mergeWave, pollTargetReached } from "./monitor.ts";
import { planFromGoal } from "./planner.ts";
import { buildBoard, renderBoardHtml, renderBoardText } from "./board.ts";
import { encodeSessionDir, findLatestSessionFile, parseSessionLine } from "./session.ts";
import { WF_WINDOW_META_KEY } from "./dispatch.ts";
import { resolveIdentity } from "./index.ts";
import type { PlanInput } from "./validate.ts";

const db = getDb();

// ────────────────────────────────────────────────────────────
// 工具
// ────────────────────────────────────────────────────────────
function resolveWorkflowId(explicit?: string): string | null {
	if (explicit) return explicit;
	const ident = resolveIdentity(process.cwd());
	if (ident) return ident.workflowId;
	const cwd = path.resolve(process.cwd());
	const matches = listActiveWorkflows(db).filter((w) => {
		const repo = path.resolve(w.repo_path);
		return repo === cwd || cwd.startsWith(repo + path.sep);
	});
	if (matches.length === 1) return matches[0].id;
	return null;
}

/**
 * 步骤解析(与 /wf steer 同规则):完整 id 直接命中 → 点号 id 按身份/活动 workflow 兜底。
 */
function resolveStepId(db: DatabaseSync, token: string): StepRow | null {
	const direct = getStep(db, token);
	if (direct) return direct;
	const wfId = resolveWorkflowId();
	if (!wfId) return null;
	return getStep(db, `${wfId}-${token}`) ?? null;
}

/** 取带值 flag 的值(--until done / -n 20),缺省返回默认 */
function flagValue(
	args: string[],
	name: string,
	def?: string,
): string | undefined {
	const idx = args.indexOf(name);
	if (idx === -1) return def;
	return args[idx + 1];
}

const VALUE_FLAGS = new Set(["--until", "--timeout", "--interval", "-n"]);

/** 过滤出位置参数(跳过 flag 名与其取值,如 --until done 的 done) */
function positionalArgs(args: string[]): string[] {
	return args.filter((a, i) => {
		if (a.startsWith("--") || a === "-n") return false;
		return !VALUE_FLAGS.has(args[i - 1]);
	});
}

const STATUS_ICON: Record<string, string> = {
	pending: "○",
	ready: "○",
	dispatched: "▶",
	running: "▶",
	reported: "◐",
	"waiting-verify": "◐",
	done: "✓",
	skipped: "–",
	failed: "✗",
	aborted: "✗",
	conflict: "⚠",
	"needs-fix": "↻",
};

function printStatusJson(wfId?: string): void {
	const workflows = wfId
		? [getWorkflow(db, wfId)].filter((w): w is NonNullable<typeof w> =>
				Boolean(w),
			)
		: listWorkflows(db);
	const out = workflows.map((w) => {
		const counts = stepStatusCounts(db, w.id);
		const steps = getStepsByWorkflow(db, w.id);
		const cost = workflowCost(db, w.id);
		const winId = getWorkflowMeta(db, w.id, WF_WINDOW_META_KEY);
		return {
			id: w.id,
			title: w.title,
			status: w.status,
			wave: w.current_wave,
			repoPath: w.repo_path,
			baseSha: w.base_sha,
			boundWindow: winId ?? null,
			steps: steps.map((s) => ({
				id: s.id,
				status: s.status,
				agent: s.agent,
				gate: Boolean(s.gate),
			})),
			counts,
			costCents: cost?.cost_cents ?? 0,
		};
	});
	console.log(JSON.stringify(out, null, 2));
}

function printStatusText(wfId?: string): void {
	const workflows = wfId
		? [getWorkflow(db, wfId)].filter((w): w is NonNullable<typeof w> =>
				Boolean(w),
			)
		: listWorkflows(db);
	if (workflows.length === 0) {
		console.log("(无 workflow,先用 wf import <plan.json> 导入计划)");
		return;
	}
	for (const w of workflows) {
		const counts = stepStatusCounts(db, w.id);
		const steps = getStepsByWorkflow(db, w.id);
		const cost = workflowCost(db, w.id);
		const winId = getWorkflowMeta(db, w.id, WF_WINDOW_META_KEY) as
			| string
			| undefined;
		const done = (counts.done ?? 0) + (counts.skipped ?? 0);
		const running = (counts.dispatched ?? 0) + (counts.running ?? 0);
		const abnormal =
			(counts.failed ?? 0) +
			(counts.aborted ?? 0) +
			(counts.conflict ?? 0) +
			(counts["needs-fix"] ?? 0);
		const costText =
			cost && cost.cost_cents > 0
				? ` $${(cost.cost_cents / 100).toFixed(2)}`
				: "";
		console.log(
			`[${w.id}] ${w.title} | ${w.status} | 进度 ${done}/${steps.length} 运行${running} 异常${abnormal}${costText}`,
		);
		console.log(
			`  repo: ${w.repo_path} | base: ${w.base_sha ?? "-"} | 绑定窗口: ${winId ?? "-"}`,
		);
		for (const s of getRunningSteps(db, w.id)) {
			console.log(
				`  ▶ ${s.id} ${s.title} tab=${s.tab_id ? s.tab_id.slice(0, 8) : "?"}`,
			);
		}
	}
}

function printTree(wfId?: string): void {
	const wf = wfId ?? resolveWorkflowId();
	if (!wf) {
		console.error("无法确定 workflow(传 id 或在仓库根目录运行)");
		process.exit(1);
	}
	const steps = getStepsByWorkflow(db, wf);
	for (const s of steps) {
		const depth = s.id.slice(wf.length + 1).split(".").length;
		const icon = STATUS_ICON[s.status] ?? "?";
		console.log(
			`${"  ".repeat(depth - 1)}${icon} ${s.id.slice(wf.length + 1)} ${s.title} [${s.agent}${s.gate ? "/gate" : ""}]${s.error ? ` ✗ ${s.error}` : ""}`,
		);
	}
}

function cmdBoard(args: string[]): void {
	const htmlIdx = args.indexOf("--html");
	const htmlPath = htmlIdx !== -1 ? args[htmlIdx + 1] : undefined;
	const waveIdx = args.indexOf("--wave");
	const waveSeq = waveIdx !== -1 ? Number(args[waveIdx + 1]) : undefined;
	const wfId = resolveWorkflowId(
		args.find((a) => !a.startsWith("--") && !/^\d+$/.test(a)),
	);
	if (!wfId) {
		console.error("无法确定 workflow(传 id 或在仓库根目录运行)");
		process.exit(1);
	}
	const board = buildBoard(db, wfId, waveSeq);
	if (!board) {
		console.error(`✗ workflow 不存在: ${wfId}`);
		process.exit(1);
	}
	if (htmlPath) {
		const out = path.resolve(process.cwd(), htmlPath);
		fs.writeFileSync(out, renderBoardHtml(board), "utf-8");
		console.log(`✓ 看板已导出: ${out}`);
		return;
	}
	for (const line of renderBoardText(board)) console.log(line);
}

// ────────────────────────────────────────────────────────────
// 子命令
// ────────────────────────────────────────────────────────────
function cmdPlanInit(args: string[]): void {
	const [name, goal] = args.filter((a) => !a.startsWith("--"));
	const repo = args.includes("--repo")
		? args[args.indexOf("--repo") + 1]
		: process.cwd();
	const n = args.includes("--steps")
		? Number(args[args.indexOf("--steps") + 1])
		: 4;
	if (!name || !goal) {
		console.error(
			'用法: wf plan-init <name> "<目标>" [--repo <path>] [--steps N]',
		);
		process.exit(1);
	}
	const steps = Array.from({ length: n }, (_, i) => ({
		id: String(i + 1),
		title: `步骤 ${i + 1}`,
		agent: i === 0 ? "planner" : i === n - 1 ? "reviewer" : "worker",
		task: `描述第 ${i + 1} 步要做什么`,
	}));
	const plan: PlanInput = { name, title: name, goal, repoPath: repo, steps };
	const out = path.join(process.cwd(), "plan.json");
	fs.writeFileSync(out, JSON.stringify(plan, null, 2) + "\n");
	console.log(`已生成 ${out}(编辑 steps 后 /wf import 或 wf import)`);
}

function cmdImport(file: string | undefined): void {
	if (!file) {
		console.error("用法: wf import <plan.json>");
		process.exit(1);
	}
	const raw = fs.readFileSync(path.resolve(file), "utf-8");
	let plan: PlanInput;
	try {
		plan = JSON.parse(raw) as PlanInput;
	} catch (e) {
		console.error(`✗ 计划文件不是合法 JSON: ${(e as Error).message}`);
		process.exit(1);
	}
	const result = importPlan(db, plan, process.cwd());
	if (!result.ok) {
		console.error("导入失败:");
		for (const e of result.errors ?? []) console.error(`  ✗ ${e}`);
		process.exit(1);
	}
	console.log(
		`✓ 已导入 ${result.workflowId}:${result.stepCount} 个步骤(wave ${result.wave})`,
	);
}

async function cmdDispatch(args: string[]): Promise<void> {
	const dryRun = args.includes("--dry-run");
	const wfFlagIdx = args.indexOf("--workflow");
	const explicitWf = wfFlagIdx !== -1 ? args[wfFlagIdx + 1] : undefined;
	const tokens = args.filter((a) => !a.startsWith("--") && a !== explicitWf);
	const wfId = resolveWorkflowId(explicitWf);
	if (!wfId) {
		console.error("无法确定 workflow(传 --workflow <id> 或在仓库根目录运行)");
		process.exit(1);
	}
	const workflow = getWorkflow(db, wfId);
	if (!workflow) {
		console.error(`workflow 不存在: ${wfId}`);
		process.exit(1);
	}
	for (const token of tokens) {
		const step = getStep(db, token) ?? getStep(db, `${wfId}-${token}`);
		if (!step) {
			console.error(`✗ ${token}: 步骤不存在`);
			continue;
		}
		const res = await dispatchStep(db, workflow, step, { dryRun });
		if (res.ok) {
			console.log(
				res.dryRun
					? `◦ ${token}: [dry-run] worktree=${res.worktree}\n${res.pointer}`
					: `✓ ${token}: running tab=${res.tabId ? res.tabId.slice(0, 8) : "?"} worktree=${res.worktree}`,
			);
		} else {
			console.error(`✗ ${token}: ${res.error}`);
		}
	}
}

function cmdVerify(args: string[]): void {
	const [id, action, ...rest] = args;
	if (!id || (action !== "approve" && action !== "reject")) {
		console.error("用法: wf verify <id> approve|reject [原因]");
		process.exit(1);
	}
	const res = verifyStep(db, id, action, rest.join(" "));
	if (!res.ok) {
		console.error(`✗ ${res.error}`);
		process.exit(1);
	}
	console.log(`✓ ${id} → ${res.status}`);
}

async function cmdRebindWindow(args: string[]): Promise<void> {
	const explicitWf = args.find((a) => !a.startsWith("--"));
	const wfId = resolveWorkflowId(explicitWf);
	if (!wfId) {
		console.error("无法确定 workflow(传 <id> 或在仓库根目录运行)");
		process.exit(1);
	}
	const workflow = getWorkflow(db, wfId);
	if (!workflow) {
		console.error(`workflow 不存在: ${wfId}`);
		process.exit(1);
	}
	// 取当前焦点窗口 id(ghostctl layout --json 的 front 标记)
	let raw: string;
	try {
		raw = execFileSync(resolveBin("ghostctl"), ["layout", "--json"], {
			encoding: "utf-8",
			cwd: workflow.repo_path,
		});
	} catch (e) {
		console.error(`ghostctl layout 失败: ${(e as Error).message}`);
		process.exit(1);
	}
	let windows: Array<{ id: string; front?: boolean }>;
	try {
		windows = (
			JSON.parse(raw) as { windows: Array<{ id: string; front?: boolean }> }
		).windows;
	} catch {
		console.error("ghostctl layout 输出无法解析");
		process.exit(1);
	}
	const target = windows.find((w) => w.front) ?? windows[0];
	if (!target) {
		console.error("ghostctl layout 无窗口信息");
		process.exit(1);
	}
	const old =
		(getWorkflowMeta(db, wfId, WF_WINDOW_META_KEY) as string | undefined) ??
		"(未绑定)";
	setWorkflowMeta(db, wfId, WF_WINDOW_META_KEY, target.id);
	addEvent(db, {
		workflowId: wfId,
		type: EVT.workflowWindowRebound,
		payload: { key: WF_WINDOW_META_KEY, from: old, to: target.id },
	});
	console.log(`✓ ${wfId} 绑定窗口: ${old} → ${target.id}(当前焦点窗口)`);
}

async function cmdMerge(args: string[]): Promise<void> {
	const waveFlagIdx = args.indexOf("--wave");
	const waveSeq =
		waveFlagIdx !== -1 && args[waveFlagIdx + 1]
			? Number(args[waveFlagIdx + 1])
			: undefined;
	const explicitWf = args.find((a) => !a.startsWith("--") && !/^\d+$/.test(a));
	const wfId = resolveWorkflowId(explicitWf);
	if (!wfId) {
		console.error("无法确定 workflow(传 id 或在仓库根目录运行)");
		process.exit(1);
	}
	const workflow = getWorkflow(db, wfId);
	if (!workflow) {
		console.error(`workflow 不存在: ${wfId}`);
		process.exit(1);
	}
	const res = await mergeWave(db, workflow, waveSeq ?? workflow.current_wave);
	if (res.ok) {
		console.log(
			`✓ wave ${res.wave} 合并完成:${res.merged.length} 个步骤合回主分支`,
		);
	} else {
		console.error(`✗ wave ${res.wave} 合并未完成: ${res.error}`);
		process.exit(1);
	}
}

async function cmdRetry(args: string[]): Promise<void> {
	const fresh = args.includes("--fresh");
	const token = args.find((a) => a !== "--fresh");
	if (!token) {
		console.error("用法: wf retry <id> [--fresh]");
		process.exit(1);
	}
	const step =
		getStep(db, token) ?? getStep(db, `${resolveWorkflowId()}-${token}`);
	if (!step) {
		console.error(`✗ 步骤不存在: ${token}`);
		process.exit(1);
	}
	if (!["failed", "aborted", "needs-fix"].includes(step.status)) {
		console.error(
			`✗ 状态 ${step.status} 无需重试(仅 failed/aborted/needs-fix)`,
		);
		process.exit(1);
	}
	const workflow = getWorkflow(db, step.workflow_id);
	if (!workflow) {
		console.error(`✗ workflow 不存在: ${step.workflow_id}`);
		process.exit(1);
	}
	const res = await dispatchStep(db, workflow, step, { fresh });
	if (res.ok) {
		console.log(
			`✓ 已重派 ${step.id}${fresh ? "(--fresh)" : ""} tab=${res.tabId ? res.tabId.slice(0, 8) : "?"}`,
		);
	} else {
		console.error(`✗ 重派失败: ${res.error}`);
		process.exit(1);
	}
}

async function cmdPlan(args: string[]): Promise<void> {
	const dryRun = args.includes("--dry-run");
	const repoFlagIdx = args.indexOf("--repo");
	const repoPath =
		repoFlagIdx !== -1 && args[repoFlagIdx + 1]
			? args[repoFlagIdx + 1]
			: process.cwd();
	const wfFlagIdx = args.indexOf("--workflow");
	const explicitWf =
		wfFlagIdx !== -1 && args[wfFlagIdx + 1] ? args[wfFlagIdx + 1] : undefined;
	const request = args
		.filter((a, i) => {
			if (a === "--dry-run" || a === "--repo" || a === "--workflow")
				return false;
			if (repoFlagIdx !== -1 && i === repoFlagIdx + 1) return false;
			if (wfFlagIdx !== -1 && i === wfFlagIdx + 1) return false;
			return true;
		})
		.join(" ");
	if (!request.trim()) {
		console.error(
			'用法: wf plan "<需求目标>" [--repo <path>] [--workflow <id>] [--dry-run]',
		);
		process.exit(1);
	}
	console.log(`[wf] planner 拆解中:"${request.slice(0, 60)}"…`);
	let result;
	try {
		result = await planFromGoal(repoPath, request);
	} catch (e) {
		console.error(`✗ planner 失败: ${(e as Error).message}`);
		process.exit(1);
	}
	if (dryRun) {
		console.log(JSON.stringify(result.plan, null, 2));
		return;
	}
	const plan = result.plan as PlanInput;
	if (
		typeof plan !== "object" ||
		plan === null ||
		!plan.name ||
		!Array.isArray(plan.steps)
	) {
		console.error(
			`✗ planner 输出缺少 name/steps:\n${result.output.slice(0, 500)}`,
		);
		process.exit(1);
	}
	if (explicitWf) {
		const wf = getWorkflow(db, explicitWf);
		const appendRes = appendSteps(
			db,
			explicitWf,
			wf?.current_wave ?? 1,
			plan,
			process.cwd(),
		);
		if (!appendRes.ok) {
			console.error(
				`✗ 追加失败:\n${appendRes.errors?.slice(0, 10).join("\n")}`,
			);
			process.exit(1);
		}
		console.log(`✓ 已向 ${explicitWf} 追加 ${appendRes.added} 个步骤`);
		return;
	}
	const importRes = importPlan(db, plan, repoPath);
	if (!importRes.ok) {
		console.error(
			`✗ 计划校验失败:\n${importRes.errors?.slice(0, 10).join("\n")}`,
		);
		process.exit(1);
	}
	console.log(
		`✓ 已生成 workflow ${importRes.workflowId}:${importRes.stepCount} 步(wave ${importRes.wave})`,
	);
}

function cmdGoalCheck(args: string[]): void {
	const [action, ...rest] = args;
	const wfId = resolveWorkflowId();
	if (!wfId) {
		console.error("无法确定 workflow(传 id 或在仓库根目录运行)");
		process.exit(1);
	}
	const workflow = getWorkflow(db, wfId);
	if (!workflow) {
		console.error(`✗ workflow 不存在: ${wfId}`);
		process.exit(1);
	}
	if (action === undefined) {
		updateWorkflowStatus(db, wfId, WORKFLOW_STATUS.verifying);
		addEvent(db, { workflowId: wfId, type: EVT.workflowGoalCheckStarted });
		console.log(`[${wfId}] 已进入目标核对(verifying)`);
		console.log(`最初目标: ${workflow.goal}`);
		for (const s of getStepsByWorkflow(db, wfId)) {
			console.log(
				`  ${s.id} [${s.status}] summary=${s.summary ?? "-"} issues=${s.issues ?? "-"} tests=${s.tests ?? "-"}`,
			);
		}
		console.log(`核对: wf goal-check approve | wf goal-check reject <原因>`);
		return;
	}
	if (action === "approve") {
		buildUpdate(
			db,
			"workflow",
			{
				goal_check: JSON.stringify({
					result: "passed",
					reason: rest.join(" "),
					checkedAt: Date.now(),
				}),
				updated_at: Date.now(),
			},
			{ id: wfId },
		);
		updateWorkflowStatus(db, wfId, WORKFLOW_STATUS.completed);
		addEvent(db, {
			workflowId: wfId,
			type: EVT.workflowGoalCheckPassed,
			payload: { reason: rest.join(" ") },
		});
		console.log(`✓ ${wfId} 目标核对通过 → completed`);
		return;
	}
	if (action === "reject") {
		const reason = rest.join(" ") || "(未说明)";
		buildUpdate(
			db,
			"workflow",
			{
				goal_check: JSON.stringify({
					result: "failed",
					reason,
					checkedAt: Date.now(),
				}),
				updated_at: Date.now(),
			},
			{ id: wfId },
		);
		updateWorkflowStatus(db, wfId, WORKFLOW_STATUS.running);
		addEvent(db, {
			workflowId: wfId,
			type: EVT.workflowGoalCheckFailed,
			payload: { reason },
		});
		console.log(`✗ ${wfId} 目标未达成 → 回到 running;/wf next 拆 gap wave`);
		return;
	}
	console.error("用法: wf goal-check [approve|reject <原因>]");
	process.exit(1);
}

function cmdNext(args: string[]): void {
	const noteIdx = args.indexOf("--note");
	const note = noteIdx !== -1 ? args.slice(noteIdx + 1).join(" ") : undefined;
	const wfId = resolveWorkflowId(
		args.find((a) => a !== "--note" && !a.startsWith("--")),
	);
	if (!wfId) {
		console.error("无法确定 workflow(传 id 或在仓库根目录运行)");
		process.exit(1);
	}
	const workflow = getWorkflow(db, wfId);
	if (!workflow) {
		console.error(`✗ workflow 不存在: ${wfId}`);
		process.exit(1);
	}
	const waves = listWaves(db, wfId);
	const nextSeq = (waves.length > 0 ? waves[waves.length - 1].seq : 0) + 1;
	const wave = createWave(db, wfId, nextSeq, note);
	buildUpdate(
		db,
		"workflow",
		{ current_wave: nextSeq, updated_at: Date.now() },
		{ id: wfId },
	);
	addEvent(db, {
		workflowId: wfId,
		waveId: wave.id,
		type: EVT.waveStarted,
		payload: { wave: nextSeq, note: note ?? null },
	});
	console.log(
		`✓ wave ${nextSeq} 已创建${note ? `(${note})` : ""};wf plan --workflow ${wfId} 补步骤`,
	);
}

function cmdDone(args: string[]): void {
	const [id, ...rest] = args;
	if (!id || rest.length === 0) {
		console.error("用法: wf done <id> '<JSON>'");
		process.exit(1);
	}
	let payload: unknown;
	try {
		payload = JSON.parse(rest.join(" "));
	} catch (e) {
		console.error(`✗ JSON 解析失败: ${(e as Error).message}`);
		process.exit(1);
	}
	const res = reportDone(db, id, payload);
	if (!res.ok) {
		console.error(`✗ ${res.error}`);
		process.exit(1);
	}
	console.log(`✓ ${id} → ${res.status}`);
}

function cmdFail(args: string[]): void {
	const [id, ...rest] = args;
	if (!id) {
		console.error("用法: wf fail <id> <原因>");
		process.exit(1);
	}
	const res = reportFail(db, id, rest.join(" ") || "(未说明)");
	if (!res.ok) {
		console.error(`✗ ${res.error}`);
		process.exit(1);
	}
	console.log(`✓ ${id} → failed`);
}

function cmdStep(id: string | undefined): void {
	if (!id) {
		console.error("用法: wf step <id>");
		process.exit(1);
	}
	const step = getStep(db, id) ?? getStep(db, `${resolveWorkflowId()}-${id}`);
	if (!step) {
		console.error(`✗ 步骤不存在: ${id}`);
		process.exit(1);
	}
	console.log(`[${step.id}] ${step.title}`);
	console.log(
		`  状态: ${step.status} | agent: ${step.agent} | gate: ${step.gate} | worktree: ${step.worktree ?? "-"} | tab: ${step.tab_id ?? "-"}`,
	);
	console.log(`  期望: ${step.expectations ?? "-"}`);
	console.log(`  回报: ${step.report ?? "-"}`);
	console.log(`  错误: ${step.error ?? "-"}`);
	for (const a of getAttemptsByStep(db, step.id)) {
		console.log(
			`  attempt#${a.attempt_no} ${a.status} tab=${a.tab_id ? a.tab_id.slice(0, 8) : "-"}${a.error ? ` 错误: ${a.error}` : ""}`,
		);
	}
	const events = getEvents(db, { stepId: step.id, limit: 10 });
	if (events.length > 0) {
		console.log(`  事件: ${events.map((e) => e.type).join(" → ")}`);
	}
}

function cmdEvents(args: string[]): void {
	const follow = args.includes("--follow");
	const nums = args.filter((a) => /^\d+$/.test(a));
	const limit = nums[0] ? Number(nums[0]) : 30;
	const wfId = args.find((a) => !/^\d+$/.test(a) && a !== "--follow");
	const show = (afterId: number): number => {
		const events = getEvents(db, {
			workflowId: wfId ?? undefined,
			limit,
			afterId: afterId || undefined,
		});
		for (const e of events.reverse()) {
			console.log(
				`${new Date(e.created_at).toLocaleTimeString()} ${e.type}${e.step_id ? ` ${e.step_id}` : ""}${e.attempt_id ? ` #${e.attempt_id}` : ""}`,
			);
		}
		return events.length > 0 ? events[events.length - 1].id : afterId;
	};
	let last = show(0);
	if (!follow) return;
	console.log("(跟随中,Ctrl+C 退出)");
	const timer = setInterval(() => {
		last = show(last);
	}, 3000);
	process.on("SIGINT", () => {
		clearInterval(timer);
		process.exit(0);
	});
}

function cmdClean(): void {
	const bin = resolveBin("gittree");
	const res = execFileSync(bin, ["list"], { encoding: "utf-8" });
	console.log(res.trim() || "(无 gittree worktree)");
	console.log(
		"提示:清理残留 worktree 用 gittree clean <name> --branch --force 或 clean all --yes(占用检测保护)",
	);
}

/** 终态步骤(done/skipped)判定 */
const TERMINAL_OK = new Set(["done", "skipped"]);

/**
 * wf tabs [workflowId] [--json] — 子任务 tab 状态(存活判定)
 *
 * 按 workflow 仓库一次 ghostctl layout,以 terminal id 集合判存活
 * (tab_id 存的就是 terminal id,与 monitor 存活检测同口径)。
 */
async function cmdTabs(args: string[]): Promise<void> {
	const json = args.includes("--json");
	const wfArg = args.find((a) => !a.startsWith("--"));
	const workflowId = resolveWorkflowId(wfArg);
	const workflow = workflowId ? getWorkflow(db, workflowId) : undefined;
	if (!workflow) {
		console.error(
			`✗ 无法确定 workflow: ${wfArg ?? "(未传 id,且 cwd 不在任何 workflow 仓库内)"}`,
		);
		process.exit(1);
	}
	const steps = getStepsByWorkflow(db, workflow.id);
	const live = await fetchLiveTabIds(resolveBin("ghostctl"), workflow.repo_path);
	if (live === null) {
		console.error(
			"✗ ghostctl layout 查询失败,无法判定 tab 存活(与 monitor 同口径:查询失败不算 tab 关闭)",
		);
		console.error("  请用 wf doctor 检查 ghostctl/ghostty 环境后重试");
		process.exit(1);
	}
	const rows = steps.map((s) => ({
		id: s.id,
		status: s.status,
		tabId: s.tab_id,
		alive: Boolean(s.tab_id && live.has(s.tab_id)),
		worktree: s.worktree,
	}));
	const withTab = rows.filter((r) => r.tabId);
	const summary = {
		total: rows.length,
		withTab: withTab.length,
		alive: withTab.filter((r) => r.alive).length,
		closed: withTab.filter((r) => !r.alive).length,
	};
	if (json) {
		console.log(JSON.stringify({ workflowId: workflow.id, steps: rows, summary }, null, 2));
		return;
	}
	for (const r of rows) {
		console.log(
			`${r.id} [${r.status}] tab=${r.tabId ? r.tabId.slice(0, 8) : "-"} 存活=${r.alive ? "yes" : "no"} worktree=${r.worktree ?? "-"}`,
		);
	}
	console.log(
		`共 ${summary.total} 步 | 有 tab ${summary.withTab} | 存活 ${summary.alive} | 已关 ${summary.closed}`,
	);
	if (summary.withTab > 0 && live.size === 0) {
		console.error(
			"(提示:ghostctl layout 无任何存活 terminal,存活判定可能不准 — 可用 wf doctor 检查环境)",
		);
	}
}

interface CleanupSummary {
	closedTabs: number;
	cleanedPiglla: number;
	gitignoreAppended: boolean;
	gitignoreMissing: boolean;
	warnings: number;
}

/**
 * wf cleanup [workflowId] [--dry-run] [--no-fix] — 合并前置自动处理
 *
 * 1. 关终态(done/skipped)步骤的存活 tab(ghostctl close-terminal,不切焦点),事件 step_tab_closed(reason=cleanup),清 tab_id;
 * 2. 清各 worktree 的 .pi-glla(路径守卫 + 跟踪检查,被误提交则只警告);
 * 3. 仓库根 .gitignore 缺 .pi-glla/ 自动追加(--no-fix 只提示);
 * 4. 终态步骤 worktree 未提交改动检查(排除 .pi-glla,只警告不自动 commit)。
 */
async function cmdCleanup(args: string[]): Promise<void> {
	const dryRun = args.includes("--dry-run");
	const noFix = args.includes("--no-fix");
	const wfArg = args.find((a) => !a.startsWith("--"));
	const workflowId = resolveWorkflowId(wfArg);
	const workflow = workflowId ? getWorkflow(db, workflowId) : undefined;
	if (!workflow) {
		console.error(
			`✗ 无法确定 workflow: ${wfArg ?? "(未传 id,且 cwd 不在任何 workflow 仓库内)"}`,
		);
		process.exit(1);
	}
	const prefix = dryRun ? "[dry-run] " : "";
	const steps = getStepsByWorkflow(db, workflow.id);
	const summary: CleanupSummary = {
		closedTabs: 0,
		cleanedPiglla: 0,
		gitignoreAppended: false,
		gitignoreMissing: false,
		warnings: 0,
	};
	const warn = (msg: string): void => {
		summary.warnings++;
		console.warn(`  ⚠ ${msg}`);
	};

	// 1. 关终态 tab
	const ghostctlBin = resolveBin("ghostctl");
	const ghostctlOk = fs.existsSync(ghostctlBin);
	const live = await fetchLiveTabIds(ghostctlBin, workflow.repo_path);
	// 查询失败:绝不关闭任何 tab(与 monitor 同口径:查询失败不算 tab 关闭),其余清理继续
	const canJudgeTabs = live !== null;
	if (!canJudgeTabs) {
		warn("ghostctl layout 查询失败,跳过「关闭终态 tab」步骤(不关闭任何 tab);其余清理继续");
	}
	for (const s of steps) {
		if (!canJudgeTabs || !s.tab_id || !TERMINAL_OK.has(s.status)) continue;
		if (!live?.has(s.tab_id)) continue; // 已不在布局中,无需动作
		if (!ghostctlOk) {
			warn(`${s.id}: ghostctl 不可用,无法关闭 tab ${s.tab_id.slice(0, 8)}`);
			continue;
		}
		if (dryRun) {
			console.log(`${prefix}关闭终态 tab: ${s.id} (${s.tab_id.slice(0, 8)})`);
			summary.closedTabs++;
			continue;
		}
		const res = await run(ghostctlBin, ["close-terminal", s.tab_id], workflow.repo_path);
		if (res.code !== 0) {
			warn(`${s.id}: close-terminal 失败: ${res.stderr || res.stdout}`);
			continue;
		}
		addEvent(db, {
			workflowId: workflow.id,
			stepId: s.id,
			type: EVT.stepTabClosed,
			payload: { tabId: s.tab_id, reason: "cleanup" },
		});
		buildUpdate(db, "workflow_steps", { tab_id: null, updated_at: Date.now() }, { id: s.id });
		console.log(`${prefix}关闭终态 tab: ${s.id} (${s.tab_id.slice(0, 8)})`);
		summary.closedTabs++;
	}

	// 2. 清 .pi-glla(路径守卫 + 跟踪检查;运行中/待核对的步骤跳过,不打扰在跑的会话)
	const worktreesGuard = path.join(workflow.repo_path, ".worktrees");
	const ACTIVE_STATES = new Set(["pending", "ready", "dispatched", "running", "reported", "waiting-verify"]);
	for (const s of steps) {
		if (!s.worktree) continue;
		if (ACTIVE_STATES.has(s.status)) {
			console.log(`${prefix}跳过 .pi-glla: ${s.id} (状态 ${s.status},运行中不打扰)`);
			continue;
		}
		const dotted = s.id.slice(workflow.id.length + 1);
		const wtPath = worktreePath(workflow.repo_path, workflow.id, dotted);
		// 守卫:只处理 <repo>/.worktrees/gittree-* 下的目录,防误删
		if (!wtPath.startsWith(worktreesGuard + path.sep) || !path.basename(wtPath).startsWith("gittree-")) {
			warn(`${s.id}: worktree 路径不在守卫范围内,跳过: ${wtPath}`);
			continue;
		}
		const piglla = path.join(wtPath, ".pi-glla");
		if (!fs.existsSync(piglla)) continue;
		// 跟踪检查:被误提交进 git 则只警告,不自动改索引
		let tracked = false;
		try {
			const ls = execFileSync("git", ["-C", wtPath, "ls-files", ".pi-glla"], {
				encoding: "utf-8",
			}).trim();
			tracked = ls.length > 0;
		} catch {
			warn(`${s.id}: git ls-files 检查失败,跳过 .pi-glla`);
			continue;
		}
		if (tracked) {
			warn(`${s.id}: ${wtPath} 的 .pi-glla 已被 git 跟踪,不自动删除;请 git rm -r --cached .pi-glla 后在各 worktree 提交`);
			continue;
		}
		if (!dryRun) {
			fs.rmSync(piglla, { recursive: true, force: true });
		}
		console.log(`${prefix}清理 .pi-glla: ${s.id} (${path.relative(workflow.repo_path, piglla)})`);
		summary.cleanedPiglla++;
	}

	// 3. .gitignore 自动修复(合并前置,根治 untracked 冲突)
	const giPath = path.join(workflow.repo_path, ".gitignore");
	const giContent = fs.existsSync(giPath) ? fs.readFileSync(giPath, "utf-8") : "";
	const giLines = giContent.split("\n");
	const hasEntry = giLines.some((l) => l.trim() === ".pi-glla/" || l.trim() === ".pi-glla");
	if (!hasEntry) {
		summary.gitignoreMissing = true;
		if (noFix) {
			warn(`仓库根 .gitignore 缺 .pi-glla/(--no-fix 未修改);建议手动追加后再 /wf merge`);
		} else if (!dryRun) {
			const add = `${giContent && !giContent.endsWith("\n") ? "\n" : ""}# pi-workflow: 子 pi 运行时状态(防 merge 冲突)\n.pi-glla/\n`;
			fs.appendFileSync(giPath, add);
			summary.gitignoreAppended = true;
			console.log(`${prefix}.gitignore 追加 .pi-glla/(${path.relative(workflow.repo_path, giPath)})`);
		} else {
			summary.gitignoreAppended = true;
			console.log(`${prefix}.gitignore 追加 .pi-glla/(${path.relative(workflow.repo_path, giPath)})`);
		}
	}

	// 4. 终态 worktree 未提交改动检查(排除 .pi-glla,不自动 commit)
	for (const s of steps) {
		if (!s.worktree || !TERMINAL_OK.has(s.status)) continue;
		const dotted = s.id.slice(workflow.id.length + 1);
		const wtPath = worktreePath(workflow.repo_path, workflow.id, dotted);
		if (!fs.existsSync(wtPath)) continue;
		try {
			const out = execFileSync("git", ["-C", wtPath, "status", "--porcelain"], {
				encoding: "utf-8",
			}).trim();
			const dirty = out
				.split("\n")
				.filter(Boolean)
				.filter((l) => {
					const p = l.length > 3 ? l.slice(3) : l;
					return !p.startsWith(".pi-glla") && !p.includes("/.pi-glla");
				});
			if (dirty.length > 0) {
				warn(`${s.id}: worktree 有 ${dirty.length} 处未提交改动(合并前请自行 commit):`);
				for (const l of dirty.slice(0, 10)) console.warn(`    ${l}`);
			}
		} catch {
			warn(`${s.id}: git status 检查失败(worktree 可能已失效)`);
		}
	}

	// 5. 摘要
	let giState = "否";
	if (summary.gitignoreAppended) giState = "是";
	else if (summary.gitignoreMissing) giState = "缺,未改";
	console.log(
		`${prefix}关闭 tab ${summary.closedTabs} | 清理 .pi-glla ${summary.cleanedPiglla} | .gitignore 追加(${giState}) | 警告 ${summary.warnings}`,
	);
	if (summary.warnings > 0) console.log("  提示:警告项需人工确认;关闭的 tab 不影响重新派发(重派会开新 tab)");
	console.log("现在可 /wf merge");
}

// ────────────────────────────────────────────────────────────
// wf-enhance2:无头编排命令(inject / poll / session / open-tab / fix-tab)
// 退出码约定:0 成功/达成;1 运行失败;2 状态不可达(仅 poll);3 用法/参数错误
// 进度打 stderr,结论打 stdout;--json 输出纯 JSON。
// ────────────────────────────────────────────────────────────

/**
 * wf inject <target> <text...> — 向指定步骤 tab/终端注入指令(自动回车)
 * target 解析(先步骤后终端):完整 step id → 点号 step id → terminal id 前缀。
 */
async function cmdInject(args: string[]): Promise<void> {
	const [target, ...text] = args;
	if (!target || text.length === 0) {
		console.error("用法: wf inject <target> <text...>");
		process.exit(3);
	}
	const msg = text.join(" ");
	const ghostctl = resolveBin("ghostctl");
	const step = resolveStepId(db, target);
	if (step) {
		if (!step.tab_id) {
			console.error(
				`✗ 步骤 ${step.id} 无 tab(tab_id 为空);请 wf open-tab ${step.id} 或 wf fix-tab ${step.id} auto`,
			);
			process.exit(1);
		}
		const workflow = getWorkflow(db, step.workflow_id);
		const res = await sendTextToTerminal(
			ghostctl,
			step.tab_id,
			msg,
			workflow?.repo_path ?? process.cwd(),
		);
		if (res.code !== 0) {
			console.error(`✗ 注入失败: ${res.stderr || res.stdout}`);
			process.exit(1);
		}
		console.log(`✓ 已向 ${step.id} 的 tab 注入 ${msg.length} 字符`);
		return;
	}
	// 未命中任何步骤 → 按 terminal id 前缀直接注入(不查 DB,ghostctl 负责前缀匹配)
	const res = await sendTextToTerminal(ghostctl, target, msg, process.cwd());
	if (res.code !== 0) {
		console.error(`✗ 注入失败: ${res.stderr || res.stdout}`);
		process.exit(1);
	}
	console.log(`✓ 已向 terminal ${target} 注入 ${msg.length} 字符`);
}

const POLL_TARGETS = new Set([
	"pending",
	"ready",
	"dispatched",
	"running",
	"reported",
	"waiting-verify",
	"done",
	"skipped",
	"failed",
	"aborted",
	"conflict",
	"needs-fix",
]);

/**
 * wf poll [workflowId] [--until <status>] [--timeout <sec>] [--interval <sec>]
 * 轮询直到达成或超时;达成集 = {until} ∪ {skipped},pending/ready 不计入达成。
 * 退出码:0 达成 / 1 超时 / 2 失败中止冲突待修复(不可达)/ 3 用法或 workflow 不存在。
 */
async function cmdPoll(args: string[]): Promise<void> {
	const until = flagValue(args, "--until", "done")!;
	const timeout = Number(flagValue(args, "--timeout", "600"));
	const interval = Number(flagValue(args, "--interval", "5"));
	const wfArg = positionalArgs(args)[0];
	const wfId = resolveWorkflowId(wfArg);
	if (!wfId) {
		console.error("✗ 无法确定 workflow(传 id 或在仓库根目录运行)");
		process.exitCode = 3;
		return;
	}
	if (!getWorkflow(db, wfId)) {
		console.error(`✗ workflow 不存在: ${wfId}`);
		process.exitCode = 3;
		return;
	}
	if (!POLL_TARGETS.has(until)) {
		console.error(
			`✗ --until 非法: ${until}(合法取值: ${[...POLL_TARGETS].join("/")})`,
		);
		process.exitCode = 3;
		return;
	}
	if (!Number.isFinite(timeout) || timeout <= 0) {
		console.error("✗ --timeout 必须为正数秒");
		process.exitCode = 3;
		return;
	}
	if (!Number.isFinite(interval) || interval <= 0) {
		console.error("✗ --interval 必须为正数秒");
		process.exitCode = 3;
		return;
	}

	const start = Date.now();
	const deadline = start + timeout * 1000;
	const fmtCounts = (): string => {
		const counts = stepStatusCounts(db, wfId);
		return Object.entries(counts)
			.filter(([, n]) => n > 0)
			.map(([s, n]) => `${s} ${n}`)
			.join("/");
	};
	let timer: ReturnType<typeof setInterval> | undefined;
	// 用 exitCode + 自然退出而非 process.exit:pipe 下 exit 会截断未刷新的
	// stdout/stderr 缓冲(最后写入的 "wf retry" 提示行间歇性丢失,测试偶发失败)
	const finish = (code: number, text: string): void => {
		if (timer) clearInterval(timer);
		console.log(text);
		process.exitCode = code;
	};
	const tick = (): void => {
		const steps = getStepsByWorkflow(db, wfId);
		const { reached, unreachable, notStarted } = pollTargetReached(steps, until);
		const elapsed = Math.round((Date.now() - start) / 1000);
		console.error(
			`t=${elapsed}s 状态=${fmtCounts() || "(无)"} 未派发 ${notStarted}`,
		);
		if (unreachable.length > 0) {
			console.error("不可达步骤(需人工介入):");
			for (const id of unreachable) {
				console.error(`  ✗ ${id} → wf step ${id} 看原因 → wf retry ${id}`);
			}
			finish(2, `不可达: ${unreachable.join(", ")}`);
			return;
		}
		if (reached) {
			const summary =
				`达成(${until}${until !== "skipped" ? " 或 skipped" : ""}): ` +
				`${fmtCounts() || "(无步骤)"}`;
			finish(0, summary);
			return;
		}
		if (Date.now() >= deadline) {
			const pendingSteps = steps
				.filter((s) => !["done", "skipped"].includes(s.status))
				.map((s) => `${s.id}[${s.status}]`);
			finish(
				1,
				`超时(${timeout}s): 未达成 ${pendingSteps.length} 步: ${pendingSteps.join(", ") || "(无)"}`,
			);
			return;
		}
	};
	tick();
	timer = setInterval(tick, interval * 1000);
	process.on("SIGINT", () => {
		if (timer) clearInterval(timer);
		console.error(
			`已中断(t=${Math.round((Date.now() - start) / 1000)}s),当前状态: ${fmtCounts() || "(无)"}`,
		);
		process.exit(130);
	});
}

/**
 * wf session [workflowId|--last] [-n <N>] [--json] — 打印主控 pi 会话最近文本
 * 会话目录按 cwd 编码定位;默认取最新 jsonl 末尾 N 条消息。
 */
async function cmdSession(args: string[]): Promise<void> {
	const json = args.includes("--json");
	const n = Number(flagValue(args, "-n", "20"));
	if (!Number.isFinite(n) || n < 0) {
		console.error("✗ -n 必须为非负整数");
		process.exit(3);
	}
	const wfArg = positionalArgs(args)[0];
	let cwd: string;
	if (wfArg && wfArg !== "--last") {
		const wf = getWorkflow(db, wfArg);
		if (!wf) {
			console.error(`✗ workflow 不存在: ${wfArg}`);
			process.exit(3);
		}
		cwd = wf.repo_path;
	} else if (wfArg === "--last") {
		// --last:强制按当前 cwd 定位,不解析 workflow
		cwd = process.cwd();
	} else {
		// 无参数:先按 cwd 推断 workflow → repo_path;推断不出用 cwd 本身
		const wfId = resolveWorkflowId();
		const wf = wfId ? getWorkflow(db, wfId) : undefined;
		cwd = wf?.repo_path ?? process.cwd();
	}

	const sessionsRoot =
		process.env.WF_SESSIONS_DIR ??
		path.join(os.homedir(), ".pi", "agent", "sessions");
	const file = findLatestSessionFile(sessionsRoot, cwd);
	if (!file) {
		console.error(
			`✗ 无会话文件(${path.join(sessionsRoot, encodeSessionDir(cwd))})`,
		);
		process.exit(1);
	}
	const messages: Array<{ ts: string; role: string; text: string }> = [];
	for (const raw of fs.readFileSync(file, "utf-8").split("\n")) {
		const m = parseSessionLine(raw);
		if (m) messages.push(m);
	}
	const recent = messages.slice(-n);
	const truncate = (t: string): string =>
		t.length > 500 ? `${t.slice(0, 500)}…(截断)` : t;
	if (json) {
		console.log(
			JSON.stringify(
				recent.map((m) => ({ ts: m.ts, role: m.role, text: truncate(m.text) })),
				null,
				2,
			),
		);
		return;
	}
	if (recent.length === 0) {
		console.log("(无消息)");
		return;
	}
	for (const m of recent) {
		const time = new Date(m.ts);
		const hhmmss = Number.isNaN(time.getTime())
			? "--:--:--"
			: time.toTimeString().slice(0, 8);
		const label = m.role === "notify" ? "[notify]" : `${m.role}:`;
		console.log(`[${hhmmss}] ${label} ${truncate(m.text)}`);
	}
}

/**
 * wf open-tab <stepId> — 手动为步骤开子任务 tab 并绑定状态(派发兜底)
 * 前置:步骤存在、worktree 目录存在、无存活 tab、绑定窗口可用。
 */
async function cmdOpenTab(args: string[]): Promise<void> {
	const token = args[0];
	if (!token) {
		console.error("用法: wf open-tab <stepId>");
		process.exit(3);
	}
	const step = resolveStepId(db, token);
	if (!step) {
		console.error(`✗ 步骤不存在: ${token}(wf step ${token} 核对 id)`);
		process.exit(1);
	}
	const workflow = getWorkflow(db, step.workflow_id);
	if (!workflow) {
		console.error(`✗ workflow 不存在: ${step.workflow_id}`);
		process.exit(1);
	}
	const dotted = step.id.slice(workflow.id.length + 1);
	const wtPath = worktreePath(workflow.repo_path, workflow.id, dotted);
	if (!step.worktree || !fs.existsSync(wtPath)) {
		console.error(
			`✗ 步骤 ${step.id} 无 worktree 或目录不存在(${wtPath});先 /wf dispatch ${step.id} 或 /wf retry ${step.id}(open-tab 只补 tab 层,不重建 worktree)`,
		);
		process.exit(1);
	}
	// 已绑定且 tab 存活 → 无需重开(layout 查询失败时保守重开并提示)
	if (step.tab_id) {
		const live = await fetchLiveTabIds(
			resolveBin("ghostctl"),
			workflow.repo_path,
		);
		if (live === null) {
			console.error(
				"⚠ ghostctl layout 查询失败,无法确认旧 tab 是否存活;仍尝试重开(旧 tab 若还活着请手动关闭)",
			);
		} else if (live.has(step.tab_id)) {
			console.error(
				`✗ 步骤 ${step.id} 已绑定 tab ${step.tab_id.slice(0, 8)} 且存活,无需重开;若状态不对用 wf fix-tab ${step.id} <terminalId>`,
			);
			process.exit(1);
		}
	}
	// 新 attempt 行(冻结 task_md + pointer),成功后由 openStepTab 回写 tab_id
	const pointer = buildPointer(
		workflow.id,
		dotted,
		workflow.current_wave || 1,
	);
	const attempt = createAttempt(db, step.id, {
		taskMd: step.task_md,
		pointer,
	});
	const res = await openStepTab(db, workflow, step, {
		ghostctlBin: resolveBin("ghostctl"),
		attemptId: attempt.id,
		manual: true,
	});
	if (!res.ok) {
		buildUpdate(
			db,
			"workflow_attempts",
			{ status: "aborted", error: res.error, finished_at: Date.now() },
			{ id: attempt.id },
		);
		console.error(`✗ open-tab 失败: ${res.error}`);
		process.exit(1);
	}
	console.log(`✓ ${step.id} tab=${res.tabId ? res.tabId.slice(0, 8) : "?"} manual`);
}

/**
 * wf fix-tab <stepId> <terminalId|auto> — 修复步骤 tab 状态(排查用)
 * 只改 DB 状态:step → running + tab_id;不验证子 pi 进程。
 * 显式 id 必须通过 layout 存活校验(前缀匹配且唯一),auto 按 worktree 反查。
 */
async function cmdFixTab(args: string[]): Promise<void> {
	const [token, tid] = args;
	if (!token || !tid) {
		console.error("用法: wf fix-tab <stepId> <terminalId|auto>");
		process.exit(3);
	}
	const step = resolveStepId(db, token);
	if (!step) {
		console.error(`✗ 步骤不存在: ${token}`);
		process.exit(1);
	}
	const workflow = getWorkflow(db, step.workflow_id);
	if (!workflow) {
		console.error(`✗ workflow 不存在: ${step.workflow_id}`);
		process.exit(1);
	}
	const ghostctl = resolveBin("ghostctl");
	const dotted = step.id.slice(workflow.id.length + 1);
	const wtPath = worktreePath(workflow.repo_path, workflow.id, dotted);
	let fullId: string | null = null;
	let mode: "auto" | "explicit" = "auto";
	if (tid === "auto") {
		fullId = await findTerminalId(ghostctl, workflow.repo_path, null, wtPath);
		if (!fullId) {
			console.error(
				`✗ layout 中无该 worktree 对应终端(${wtPath});请用 wf open-tab ${step.id} 重开`,
			);
			process.exit(1);
		}
	} else {
		mode = "explicit";
		const live = await fetchLiveTabIds(ghostctl, workflow.repo_path);
		if (live === null) {
			console.error(
				"✗ ghostctl layout 查询失败,无法校验 terminal id;请用 auto 或 wf open-tab 重开",
			);
			process.exit(1);
		}
		const matches = [...live].filter((id) => id.startsWith(tid));
		if (matches.length === 0) {
			console.error(
				`✗ layout 中无 terminal 前缀 ${tid};请用 auto 或 wf open-tab ${step.id} 重开`,
			);
			process.exit(1);
		}
		if (matches.length > 1) {
			console.error(
				`✗ terminal 前缀 ${tid} 不唯一(${matches.join(", ")});请用完整 id 或 auto`,
			);
			process.exit(1);
		}
		fullId = matches[0];
	}
	const from = `${step.status}/${step.tab_id ? step.tab_id.slice(0, 8) : "-"}`;
	buildUpdate(
		db,
		"workflow_steps",
		{ tab_id: fullId, status: "running", updated_at: Date.now() },
		{ id: step.id },
	);
	addEvent(db, {
		workflowId: workflow.id,
		stepId: step.id,
		type: EVT.stepTabFixed,
		payload: { from: step.tab_id, to: fullId, mode },
	});
	console.log(`修复前 ${from} → 修复后 running/${fullId}(mode=${mode})`);
	console.log(
		"提示:fix-tab 仅对齐 DB 状态,请人工确认该终端里子 pi 实际在运行;若终端已关闭请 wf open-tab 重开",
	);
}

function cmdDoctor(): void {
	const checks: Array<[string, boolean, string]> = [];
	checks.push([
		"node 版本 ≥ 22.13",
		Number(process.versions.node.split(".")[0]) >= 22,
		process.version,
	]);
	checks.push(["node:sqlite 可用", true, DB_PATH]);
	const gittree = resolveBin("gittree");
	checks.push(["gittree 可执行", fs.existsSync(gittree), gittree]);
	const ghostctl = resolveBin("ghostctl");
	checks.push(["ghostctl 可执行", fs.existsSync(ghostctl), ghostctl]);
	try {
		const py = execFileSync("/usr/bin/env", ["python3", "--version"], {
			encoding: "utf-8",
		}).trim();
		const ok = /3\.(1[0-9]|[2-9])/.test(py);
		checks.push(["python3 ≥ 3.10(ghostctl 语法)", ok, py]);
	} catch {
		checks.push(["python3 ≥ 3.10(ghostctl 语法)", false, "python3 不可用"]);
	}
	const ver = (
		db.prepare("PRAGMA user_version").get() as { user_version: number }
	).user_version;
	checks.push(["数据库可打开(user_version)", ver >= 1, `v${ver} @ ${DB_PATH}`]);
	let okAll = true;
	for (const [name, ok, detail] of checks) {
		console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : " ← 需修复"}`);
		console.log(`    ${detail}`);
		if (!ok) okAll = false;
	}
	console.log(okAll ? "\n环境正常" : "\n存在环境问题,见上");
}

function cmdDebug(): void {
	const ver = (
		db.prepare("PRAGMA user_version").get() as { user_version: number }
	).user_version;
	console.log(`DB: ${DB_PATH} (schema v${ver})`);
	const tables = db
		.prepare(
			"SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'workflow%' ORDER BY name",
		)
		.all() as Array<{ name: string }>;
	console.log(`表(${tables.length}): ${tables.map((t) => t.name).join(", ")}`);
	const wfs = listWorkflows(db);
	console.log(`workflows(${wfs.length}):`);
	for (const w of wfs) {
		const counts = stepStatusCounts(db, w.id);
		const winId = getWorkflowMeta(db, w.id, WF_WINDOW_META_KEY);
		console.log(
			`  ${w.id} [${w.status}] wave=${w.current_wave} 绑定窗口=${winId ?? "-"} counts=${JSON.stringify(counts)}`,
		);
	}
	const running = getRunningSteps(db);
	if (running.length > 0) {
		console.log(`运行中(${running.length}):`);
		for (const s of running)
			console.log(
				`  ${s.id} tab=${s.tab_id ?? "?"} worktree=${s.worktree ?? "?"}`,
			);
	}
	const evtTotal = (
		db.prepare("SELECT count(*) n FROM workflow_events").get() as { n: number }
	).n;
	const attTotal = (
		db.prepare("SELECT count(*) n FROM workflow_attempts").get() as {
			n: number;
		}
	).n;
	console.log(`事件总数: ${evtTotal} | attempts: ${attTotal}`);
	console.log(
		`gittree: ${resolveBin("gittree")} | ghostctl: ${resolveBin("ghostctl")}`,
	);
}

// ────────────────────────────────────────────────────────────
// 入口
// ────────────────────────────────────────────────────────────
async function main(): Promise<void> {
	const [cmd, ...args] = process.argv.slice(2);
	switch (cmd) {
		case "plan-init":
			cmdPlanInit(args);
			break;
		case "import":
			cmdImport(args[0]);
			break;
		case "status":
			if (args.includes("--json"))
				printStatusJson(args.find((a) => !a.startsWith("--")));
			else printStatusText(args.find((a) => !a.startsWith("--")));
			break;
		case "tree":
			printTree(args[0]);
			break;
		case "board":
			cmdBoard(args);
			break;
		case "step":
			cmdStep(args[0]);
			break;
		case "events":
			cmdEvents(args);
			break;
		case "dispatch":
			await cmdDispatch(args);
			break;
		case "verify":
			cmdVerify(args);
			break;
		case "merge":
			await cmdMerge(args);
			break;
		case "retry":
			await cmdRetry(args);
			break;
		case "rebind-window":
			await cmdRebindWindow(args);
			break;
		case "plan":
			await cmdPlan(args);
			break;
		case "goal-check":
			cmdGoalCheck(args);
			break;
		case "next":
			cmdNext(args);
			break;
		case "done":
			cmdDone(args);
			break;
		case "fail":
			cmdFail(args);
			break;
		case "clean":
			cmdClean();
			break;
		case "tabs":
			await cmdTabs(args);
			break;
		case "inject":
			await cmdInject(args);
			break;
		case "poll":
			await cmdPoll(args);
			break;
		case "session":
			await cmdSession(args);
			break;
		case "open-tab":
			await cmdOpenTab(args);
			break;
		case "fix-tab":
			await cmdFixTab(args);
			break;
		case "cleanup":
			await cmdCleanup(args);
			break;
		case "doctor":
			cmdDoctor();
			break;
		case "debug":
			cmdDebug();
			break;
		case "help":
		case undefined:
			console.log(`pi-workflow CLI — 创建/执行/排查(设计 §6 skill 手册)

用法:
  wf plan "<需求目标>" [--repo <path>] [--workflow <id>]      planner 自动拆解(无 id=新建,有 id=追加 gap wave)
  wf plan-init <name> "<目标>" [--repo <path>] [--steps N]   生成 plan.json 模板
  wf import <plan.json>                                      校验 + 落库
  wf status [--json] [wfId]                                  状态全景
  wf tree [wfId]                                             层级任务树
  wf board [wfId] [--wave N] [--html out.html]                   看板(终端列布局/导出 HTML)
  wf step <id>                                               单步详情
  wf events [wfId] [N] [--follow]                            审计流
  wf dispatch <dotted...> [--workflow <id>] [--dry-run]      派发子任务(真实开 tab)
  wf verify <id> approve|reject [原因]                       期望核对
  wf merge [--wave N]                                        合并 wave 回主分支
  wf retry <id> [--fresh]                                     重派失败/中止/待修步骤(--fresh 重建 worktree)
  wf rebind-window [wfId]                                    重新绑定窗口(绑定窗口已关闭时,把当前焦点窗口设为绑定窗口)
  wf goal-check [approve|reject <原因>]                        目标把关(verifying→completed/gap wave)
  wf next [--note <说明>]                                      滚动到下一 wave
  wf done <id> '<JSON>' / wf fail <id> <原因>                回报(子任务侧)
  wf inject <target> <text...>                              向步骤 tab/终端注入指令+自动回车(target=完整id/点号id/terminal前缀)
  wf poll [wf] [--until S] [--timeout T] [--interval I]     轮询直到达成/超时(0达成/1超时/2不可达/3用法)
  wf session [wf|--last] [-n N] [--json]                    读主控 pi 会话最近文本(按 cwd 编码定位)
  wf open-tab <stepId>                                      手动补开子任务 tab(绑 worktree/窗口,恢复 running)
  wf fix-tab <stepId> <tid|auto>                            修复步骤 tab 状态(排查用,只改 DB 状态)
  wf tabs [workflowId] [--json]                              子任务 tab 状态(存活判定)
  wf cleanup [workflowId] [--dry-run] [--no-fix]             关终态 tab + 清 .pi-glla + 合并前置修复
  wf clean                                                   清理残留 worktree
  wf doctor                                                  环境自检
  wf debug                                                   诊断信息`);
			break;
		default:
			console.error(`未知命令: ${cmd}(wf help 查看用法)`);
			process.exit(1);
	}
}

main().catch((e) => {
	console.error("执行失败:", (e as Error).message);
	process.exit(1);
});
