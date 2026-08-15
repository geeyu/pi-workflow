/**
 * index.ts — workflow 插件入口(/wf 命令族 + widget + 子 pi 身份绑定)
 *
 * 编排者侧(主 pi):/wf import / dispatch / verify / status / tree / step / events
 * 子任务侧(子 pi):/wf context / done / fail(身份经 PI_WF_* 环境变量或 cwd 解析)
 *
 * 设计文档:../DESIGN.md
 */
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** 本扩展目录(兼容 jiti 的 CJS/ESM 两种加载) */
const EXT_DIR =
	typeof __dirname !== "undefined"
		? __dirname
		: path.dirname(fileURLToPath(import.meta.url));
import {
	ATTEMPT_STATUS,
	EVT,
	STEP_STATUS,
	WORKFLOW_STATUS,
	type StepRow,
	addEvent,
	getAttemptsByStep,
	getEvents,
	getLatestAttempt,
	getRunningSteps,
	getStep,
	getStepsByWorkflow,
	getWorkflow,
	listActiveWorkflows,
	listWaves,
	listWorkflows,
	getDb,
	stepStatusCounts,
	updateStepStatus,
	updateWorkflowStatus,
	workflowCost,
} from "./db.ts";
import {
	importPlan,
	appendSteps,
	checkBudget,
	goalCheckApprove,
	goalCheckEnter,
	goalCheckReject,
	nextWave,
	reportDone,
	reportFail,
	verifyStep,
} from "./orchestrator.ts";
import type { PlanInput } from "./validate.ts";
import {
	dispatchStep,
	parseExpectations,
	resolveBin,
	run,
} from "./dispatch.ts";
import {
	getReadySteps,
	mergeWave,
	recoverStaleSteps,
	startMonitor,
} from "./monitor.ts";
import { planFromGoal } from "./planner.ts";
import { buildBoard, renderBoardHtml, renderBoardText } from "./board.ts";

// ────────────────────────────────────────────────────────────
// 身份解析
// ────────────────────────────────────────────────────────────
interface WfIdentity {
	workflowId: string;
	dotted: string | null;
	stepId: string | null;
}

/** 子 pi 身份:环境变量优先,cwd(worktree 路径)兜底 */
export function resolveIdentity(cwd: string): WfIdentity | null {
	const envWf = process.env.PI_WF_WORKFLOW;
	const envStep = process.env.PI_WF_STEP;
	if (envWf && envStep) {
		return {
			workflowId: envWf,
			dotted: envStep,
			stepId: `${envWf}-${envStep}`,
		};
	}
	for (const seg of cwd.split("/")) {
		const m = /^(?:gittree-)?wf-(.+)-([0-9.]+)$/.exec(seg);
		if (m) return { workflowId: m[1], dotted: m[2], stepId: `${m[1]}-${m[2]}` };
	}
	return null;
}

/** 编排者侧解析 workflow id:显式参数 → 身份 env → cwd 所在仓库的活动 workflow */
function resolveWorkflowId(
	ctx: ExtensionCommandContext,
	explicit?: string,
): string | null {
	if (explicit) return explicit;
	const ident = resolveIdentity(ctx.cwd);
	if (ident) return ident.workflowId;
	const cwd = path.resolve(ctx.cwd);
	const matches = listActiveWorkflows(getDb()).filter((w) => {
		const repo = path.resolve(w.repo_path);
		return repo === cwd || cwd.startsWith(repo + path.sep);
	});
	if (matches.length === 1) return matches[0].id;
	return null;
}

function findStep(ctx: ExtensionCommandContext, token: string): StepRow | null {
	const db = getDb();
	// 完整 id 直接匹配
	const direct = getStep(db, token);
	if (direct) return direct;
	// 点号 → 按身份/活动 workflow 解析
	const wfId = resolveWorkflowId(ctx);
	if (!wfId) return null;
	return getStep(db, `${wfId}-${token}`) ?? null;
}

// ────────────────────────────────────────────────────────────
// 展示
// ────────────────────────────────────────────────────────────
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

function stepIcon(step: StepRow): string {
	return STATUS_ICON[step.status] ?? "?";
}

function statusCountsLine(
	counts: Record<string, number>,
	total: number,
): string {
	const done = (counts.done ?? 0) + (counts.skipped ?? 0);
	const running = (counts.dispatched ?? 0) + (counts.running ?? 0);
	const abnormal =
		(counts.failed ?? 0) +
		(counts.aborted ?? 0) +
		(counts.conflict ?? 0) +
		(counts["needs-fix"] ?? 0);
	const verify = (counts.reported ?? 0) + (counts["waiting-verify"] ?? 0);
	return `进度 ${done}/${total}  ✓${done} 运行${running} 待核对${verify} 异常${abnormal}`;
}

function renderWidget(
	ctx: ExtensionCommandContext,
	db: ReturnType<typeof getDb>,
): void {
	const active = listActiveWorkflows(db).slice(0, 3);
	if (active.length === 0) {
		ctx.ui.setWidget("workflow", undefined);
		return;
	}
	const lines: string[] = [];
	for (const w of active) {
		const counts = stepStatusCounts(db, w.id);
		const steps = getStepsByWorkflow(db, w.id);
		const cost = workflowCost(db, w.id);
		const costText =
			cost && cost.cost_cents > 0
				? ` $${(cost.cost_cents / 100).toFixed(2)}`
				: "";
		lines.push(
			`[wf] ${w.id} ${w.status} wave${w.current_wave} | ${statusCountsLine(counts, steps.length)}${costText}`,
		);
	}
	ctx.ui.setWidget("workflow", lines);
}

function notify(
	ctx: ExtensionCommandContext,
	message: string,
	type: "info" | "warning" | "error" = "info",
): void {
	ctx.ui.notify(message, type);
}

function parseJsonArg(raw: string): {
	ok: boolean;
	value?: unknown;
	error?: string;
} {
	try {
		return { ok: true, value: JSON.parse(raw) };
	} catch (e) {
		return { ok: false, error: `JSON 解析失败: ${(e as Error).message}` };
	}
}

// ────────────────────────────────────────────────────────────
// 命令
// ────────────────────────────────────────────────────────────
export default function workflowExtension(pi: ExtensionAPI) {
	const db = getDb();

	// ── /wf import <plan.json> ──────────────────────────────
	pi.registerCommand("wf", {
		description:
			"workflow 编排:import/dispatch/context/done/fail/verify/status/tree/step/events",
		getArgumentCompletions: (prefix) => {
			const words = [
				"import",
				"dispatch",
				"context",
				"done",
				"fail",
				"verify",
				"status",
				"tree",
				"step",
				"events",
			];
			return words
				.filter((w) => w.startsWith(prefix))
				.map((w) => ({ value: w, label: w }));
		},
		handler: async (args, ctx) => {
			const [sub, ...rest] = args.trim().split(/\s+/);
			try {
				switch (sub) {
					case "import":
						await cmdImport(ctx, rest);
						break;
					case "dispatch":
						await cmdDispatch(ctx, rest);
						break;
					case "context":
						cmdContext(ctx, rest);
						break;
					case "done":
						cmdDone(ctx, rest);
						break;
					case "fail":
						cmdFail(ctx, rest);
						break;
					case "verify":
						cmdVerify(ctx, rest);
						break;
					case "retry":
						await cmdRetry(ctx, rest);
						break;
					case "steer":
						await cmdSteer(ctx, rest);
						break;
					case "resolve-conflict":
						cmdResolveConflict(ctx, rest);
						break;
					case "merge":
						await cmdMerge(ctx, rest);
						break;
					case "plan":
						await cmdPlan(ctx, rest);
						break;
					case "goal-check":
						cmdGoalCheck(ctx, rest);
						break;
					case "next":
						cmdNext(ctx, rest);
						break;
					case "resume":
						cmdResume(ctx, rest);
						break;
					case "status":
						cmdStatus(ctx, rest);
						break;
					case "board":
						cmdBoard(ctx, rest);
						break;
					case "tree":
						cmdTree(ctx, rest);
						break;
					case "step":
						cmdStep(ctx, rest);
						break;
					case "events":
						cmdEvents(ctx, rest);
						break;
					default:
						notify(
							ctx,
							`用法: /wf import|dispatch|context|done|fail|verify|merge|status|tree|step|events\n示例: /wf status / /wf import plan.json / /wf done 1.1 '{"summary":"..."}'`,
							"warning",
						);
				}
			} catch (e) {
				notify(ctx, `wf 命令失败: ${(e as Error).message}`, "error");
			} finally {
				renderWidget(ctx, db);
			}
		},
	});

	// ── /wf import <plan.json> ──────────────────────────────
	async function cmdImport(
		ctx: ExtensionCommandContext,
		args: string[],
	): Promise<void> {
		const file = args[0];
		if (!file) {
			notify(ctx, "用法: /wf import <plan.json>", "warning");
			return;
		}
		const abs = path.resolve(ctx.cwd, file);
		if (!fs.existsSync(abs)) {
			notify(ctx, `文件不存在: ${abs}`, "error");
			return;
		}
		let raw: string;
		try {
			raw = fs.readFileSync(abs, "utf-8");
		} catch (e) {
			notify(ctx, `读取失败: ${(e as Error).message}`, "error");
			return;
		}
		const plan = parseJsonArg(raw);
		if (!plan.ok) {
			notify(ctx, plan.error!, "error");
			return;
		}
		const result = importPlan(db, plan.value as PlanInput, ctx.cwd);
		if (!result.ok) {
			notify(
				ctx,
				`计划校验失败:\n${result.errors!.slice(0, 10).join("\n")}`,
				"error",
			);
			return;
		}
		notify(
			ctx,
			`已导入 ${result.workflowId}:${result.stepCount} 个步骤(wave ${result.wave}),可用 /wf dispatch 派发`,
		);
	}

	// ── /wf dispatch <dotted|fullId>... [--dry-run] ─────────
	async function cmdDispatch(
		ctx: ExtensionCommandContext,
		args: string[],
	): Promise<void> {
		const dryRun = args.includes("--dry-run");
		const wfFlagIdx = args.indexOf("--workflow");
		let explicitWf: string | undefined;
		if (wfFlagIdx !== -1 && args[wfFlagIdx + 1]) {
			explicitWf = args[wfFlagIdx + 1];
			args.splice(wfFlagIdx, 2);
		}
		const tokens = args.filter((t) => t !== "--dry-run");
		const wfId = resolveWorkflowId(ctx, explicitWf);
		if (!wfId) {
			const all = listWorkflows(db);
			notify(
				ctx,
				`无法确定 workflow(不在仓库根目录?):\n${all.map((w) => `  ${w.id} [${w.status}] ${w.repo_path}`).join("\n")}\n或显式 --workflow <id>`,
				"warning",
			);
			return;
		}
		const workflow = getWorkflow(db, wfId);
		if (!workflow) {
			notify(ctx, `workflow 不存在: ${wfId}`, "error");
			return;
		}

		// 预算护栏(设计 §10):累计成本超限 → 拒绝派发并暂停
		if (!dryRun) {
			const budget = checkBudget(db, workflow);
			if (!budget.ok) {
				updateWorkflowStatus(db, wfId, WORKFLOW_STATUS.paused);
				addEvent(db, {
					workflowId: wfId,
					type: EVT.workflowPaused,
					payload: { reason: budget.reason },
				});
				notify(
					ctx,
					`${budget.reason};workflow 已暂停(/wf resume 恢复)`,
					"warning",
				);
				return;
			}
		}

		// 无参数 = 派发当前 wave 的全部就绪步骤(依赖全 done 的 pending)
		const readyTokens =
			tokens.length === 0
				? getReadySteps(db, wfId).map((s) => s.id.slice(wfId.length + 1))
				: tokens;
		if (readyTokens.length === 0) {
			notify(
				ctx,
				`wave ${workflow.current_wave} 无就绪步骤(依赖未完成或已全部派发)`,
			);
			return;
		}

		const results: string[] = [];
		for (const token of readyTokens) {
			const step: StepRow | undefined =
				getStep(db, token) ?? getStep(db, `${wfId}-${token}`);
			if (!step) {
				results.push(`✗ ${token}: 步骤不存在`);
				continue;
			}
			if (step.workflow_id !== wfId) {
				results.push(`✗ ${token}: 属于其他 workflow(${step.workflow_id})`);
				continue;
			}
			const res = await dispatchStep(db, workflow, step, { dryRun });
			if (res.ok) {
				results.push(
					res.dryRun
						? `◦ ${token}: [dry-run] worktree=${res.worktree} pointer:\n${res.pointer}`
						: `✓ ${token}: tab=${res.tabId ?? "?"} attempt=${res.attemptNo ?? "?"} worktree=${res.worktree}`,
				);
			} else {
				results.push(`✗ ${token}: ${res.error}`);
			}
		}
		notify(ctx, results.join("\n\n"));
	}

	// ── /wf context(子 pi 内)───────────────────────────────
	function cmdContext(ctx: ExtensionCommandContext, _args: string[]): void {
		const ident = resolveIdentity(ctx.cwd);
		if (!ident) {
			notify(
				ctx,
				"无法确定任务身份:未设置 PI_WF_WORKFLOW/PI_WF_STEP,且 cwd 不在 wf worktree 内",
				"warning",
			);
			return;
		}
		const step = getStep(db, ident.stepId!);
		if (!step) {
			notify(ctx, `步骤不存在: ${ident.stepId}`, "error");
			return;
		}
		const workflow = getWorkflow(db, ident.workflowId);
		if (!workflow) {
			notify(ctx, `workflow 不存在: ${ident.workflowId}`, "error");
			return;
		}
		// 优先最新 attempt 的冻结任务正文
		const attempt = getLatestAttempt(db, step.id);
		const taskMd =
			(attempt?.task_md && attempt.status === ATTEMPT_STATUS.running
				? attempt.task_md
				: null) ?? step.task_md;
		ctx.ui.setWidget("workflow-task", taskMd.split("\n"));
		notify(
			ctx,
			`[wf] 任务详情已显示: ${ident.stepId}(worktree: ${step.worktree ?? "-"})`,
		);
	}

	// ── /wf done <dotted|fullId> <JSON> ─────────────────────
	function cmdDone(ctx: ExtensionCommandContext, args: string[]): void {
		const [token, ...rest] = args;
		if (!token || rest.length === 0) {
			notify(
				ctx,
				'用法: /wf done <dotted> \'{"summary":"...","filesChanged":[...],"tests":"passed"}\'',
				"warning",
			);
			return;
		}
		const step = findStep(ctx, token);
		if (!step) {
			notify(ctx, `步骤不存在: ${token}`, "error");
			return;
		}
		const parsed = parseJsonArg(rest.join(" "));
		if (!parsed.ok) {
			notify(ctx, parsed.error!, "error");
			return;
		}
		const res = reportDone(db, step.id, parsed.value);
		if (!res.ok) {
			notify(ctx, res.error!, "error");
			return;
		}
		notify(
			ctx,
			res.status === "waiting-verify"
				? `已回报 ${step.id},等待编排者 /wf verify approve|reject`
				: `已回报 ${step.id},编排者将核对期望(或 /wf verify)`,
		);
	}

	// ── /wf fail <dotted|fullId> <原因> ─────────────────────
	function cmdFail(ctx: ExtensionCommandContext, args: string[]): void {
		const [token, ...rest] = args;
		if (!token) {
			notify(ctx, "用法: /wf fail <dotted> <原因>", "warning");
			return;
		}
		const step = findStep(ctx, token);
		if (!step) {
			notify(ctx, `步骤不存在: ${token}`, "error");
			return;
		}
		const res = reportFail(db, step.id, rest.join(" ") || "(未说明)");
		if (!res.ok) {
			notify(ctx, res.error!, "error");
			return;
		}
		notify(ctx, `已标记失败 ${step.id}`, "warning");
	}

	// ── /wf verify <dotted|fullId> [approve|reject <原因>] ──
	function cmdVerify(ctx: ExtensionCommandContext, args: string[]): void {
		const [token, action, ...rest] = args;
		if (!token) {
			notify(
				ctx,
				"用法: /wf verify <dotted> [approve|reject <原因>]",
				"warning",
			);
			return;
		}
		const step = findStep(ctx, token);
		if (!step) {
			notify(ctx, `步骤不存在: ${token}`, "error");
			return;
		}
		if (action === "reject") {
			const res = verifyStep(db, step.id, "reject", rest.join(" "));
			if (!res.ok) {
				notify(ctx, res.error!, "warning");
				return;
			}
			notify(ctx, `已驳回 ${step.id} → needs-fix`, "warning");
		} else if (action === undefined || action === "approve") {
			const res = verifyStep(db, step.id, "approve");
			if (!res.ok) {
				notify(ctx, res.error!, "warning");
				return;
			}
			notify(ctx, `已核对通过 ${step.id} → done`);
		} else {
			notify(ctx, `未知动作: ${action}(approve|reject)`, "warning");
		}
	}

	// ── /wf status [workflowId|--all] ───────────────────────
	function cmdStatus(ctx: ExtensionCommandContext, args: string[]): void {
		const explicit = args[0] && args[0] !== "--all" ? args[0] : undefined;
		const lines: string[] = [];
		const showAll = args[0] === "--all";
		const workflows = explicit
			? [getWorkflow(db, explicit)].filter((w): w is NonNullable<typeof w> =>
					Boolean(w),
				)
			: showAll
				? listWorkflows(db)
				: listActiveWorkflows(db);
		if (workflows.length === 0) {
			lines.push("(无 workflow,先用 /wf import <plan.json> 导入计划)");
		}
		for (const w of workflows) {
			const counts = stepStatusCounts(db, w.id);
			const steps = getStepsByWorkflow(db, w.id);
			const cost = workflowCost(db, w.id);
			const costText =
				cost && cost.cost_cents > 0
					? ` $${(cost.cost_cents / 100).toFixed(2)}`
					: "";
			const waves = listWaves(db, w.id);
			lines.push(
				`[${w.id}] ${w.title} | ${w.status} | repo: ${w.repo_path} | base: ${w.base_sha ?? "-"}`,
				`  ${statusCountsLine(counts, steps.length)}${costText} | waves: ${waves.map((x) => `${x.seq}:${x.status}`).join(", ")}`,
			);
			for (const s of getRunningSteps(db, w.id)) {
				lines.push(`  ▶ ${s.id} ${s.title} tab=${s.tab_id ?? "?"}`);
			}
			const recent = getEvents(db, { workflowId: w.id, limit: 5 });
			if (recent.length > 0) {
				lines.push(`  最近事件: ${recent.map((e) => `${e.type}`).join(" → ")}`);
			}
		}
		ctx.ui.setWidget("workflow-status", lines);
		notify(ctx, `[wf] 状态已更新(${workflows.length} 个 workflow)`);
	}

	// ── /wf board [workflowId] [--wave N] [--html out.html] ──
	function cmdBoard(ctx: ExtensionCommandContext, args: string[]): void {
		const htmlIdx = args.indexOf("--html");
		const htmlPath = htmlIdx !== -1 ? args[htmlIdx + 1] : undefined;
		const waveIdx = args.indexOf("--wave");
		const waveSeq = waveIdx !== -1 ? Number(args[waveIdx + 1]) : undefined;
		const wfId = resolveWorkflowId(
			ctx,
			args.find((a) => !a.startsWith("--") && !/^\d+$/.test(a)),
		);
		if (!wfId) {
			notify(
				ctx,
				"无法确定 workflow(在仓库根目录运行,或显式传 workflow id)",
				"warning",
			);
			return;
		}
		const board = buildBoard(db, wfId, waveSeq);
		if (!board) {
			notify(ctx, `workflow 不存在: ${wfId}`, "error");
			return;
		}
		if (htmlPath) {
			try {
				const out = path.resolve(ctx.cwd, htmlPath);
				fs.writeFileSync(out, renderBoardHtml(board), "utf-8");
				notify(ctx, `看板已导出: ${out}`);
			} catch (e) {
				notify(ctx, `导出失败: ${(e as Error).message}`, "error");
			}
			return;
		}
		ctx.ui.setWidget("workflow-board", renderBoardText(board));
		notify(ctx, `[wf] ${wfId} 看板:${board.done}/${board.total} 完成`);
	}

	// ── /wf tree [workflowId] ───────────────────────────────
	function cmdTree(ctx: ExtensionCommandContext, args: string[]): void {
		const wfId = resolveWorkflowId(ctx, args[0]);
		if (!wfId) {
			notify(
				ctx,
				"无法确定 workflow(在仓库根目录运行,或显式传 workflow id)",
				"warning",
			);
			return;
		}
		const steps = getStepsByWorkflow(db, wfId);
		if (steps.length === 0) {
			notify(ctx, `workflow ${wfId} 没有步骤`, "warning");
			return;
		}
		const lines = steps.map((s) => {
			const depth = s.id.slice(wfId.length + 1).split(".").length;
			const indent = "  ".repeat(depth - 1);
			const exp = parseExpectations(s.expectations);
			const meta = [
				s.agent,
				s.gate === 1 ? "gate" : null,
				exp.length > 0 ? `期望${exp.length}` : null,
				s.worktree ?? null,
			]
				.filter(Boolean)
				.join(" ");
			return `${indent}${stepIcon(s)} ${s.id.slice(wfId.length + 1)} ${s.title} [${meta}] ${s.error ? `✗ ${s.error}` : ""}`;
		});
		ctx.ui.setWidget("workflow-tree", lines);
		notify(ctx, `[wf] ${wfId} 任务树(${steps.length} 步)`);
	}

	// ── /wf step <id> ───────────────────────────────────────
	function cmdStep(ctx: ExtensionCommandContext, args: string[]): void {
		const token = args[0];
		if (!token) {
			notify(ctx, "用法: /wf step <id>", "warning");
			return;
		}
		const step = findStep(ctx, token);
		if (!step) {
			notify(ctx, `步骤不存在: ${token}`, "error");
			return;
		}
		const attempts = getAttemptsByStep(db, step.id);
		const events = getEvents(db, { stepId: step.id, limit: 20 });
		const expectations = parseExpectations(step.expectations);
		const lines = [
			`${stepIcon(step)} ${step.id} ${step.title}`,
			`  状态: ${step.status} | agent: ${step.agent} | wave: ${step.wave_id ?? "-"} | gate: ${step.gate}`,
			`  worktree: ${step.worktree ?? "-"} | tab: ${step.tab_id ?? "-"} | 重试: ${step.retries_done}/${step.max_retries}`,
			`  期望: ${expectations.length > 0 ? expectations.join(" | ") : "(未设定)"}`,
			`  回报: ${step.report ?? "(无)"}`,
			`  错误: ${step.error ?? "(无)"}`,
		];
		if (attempts.length > 0) {
			lines.push(`  尝试(${attempts.length}):`);
			for (const a of attempts) {
				lines.push(
					`    #${a.attempt_no} ${a.status} tab=${a.tab_id ?? "-"} ${a.finished_at ? `完成于 ${new Date(a.finished_at).toLocaleString()}` : ""}${a.error ? ` 错误: ${a.error}` : ""}`,
				);
			}
		}
		if (events.length > 0) {
			lines.push(
				`  事件: ${events.map((e) => `${e.type}${e.attempt_id ? `#${e.attempt_id}` : ""}`).join(" → ")}`,
			);
		}
		if (step.task_md) {
			lines.push(
				`  ── 任务正文 ──`,
				...step.task_md.split("\n").map((l) => `  ${l}`),
			);
		}
		ctx.ui.setWidget("workflow-step", lines);
		notify(ctx, `[wf] ${step.id} 详情已显示`);
	}

	// ── /wf events [workflowId] [N] ─────────────────────────
	function cmdEvents(ctx: ExtensionCommandContext, args: string[]): void {
		const limit =
			args.length > 1 && /^\d+$/.test(args[1]) ? Number(args[1]) : 30;
		const wfId =
			args[0] && !/^\d+$/.test(args[0])
				? resolveWorkflowId(ctx, args[0])
				: resolveWorkflowId(ctx);
		const events = getEvents(db, { workflowId: wfId ?? undefined, limit });
		const lines = events.map((e) => {
			const ts = new Date(e.created_at).toLocaleTimeString();
			return `${ts} ${e.type}${e.step_id ? ` ${e.step_id}` : ""}${e.attempt_id ? ` #${e.attempt_id}` : ""}`;
		});
		if (lines.length === 0) lines.push("(无事件)");
		ctx.ui.setWidget("workflow-events", lines);
		notify(
			ctx,
			`[wf] 最近 ${lines.length} 条事件${wfId ? `(${wfId})` : "(全部)"}`,
		);
	}

	// ── /wf merge [--wave N] ──────────────────────────────
	async function cmdMerge(
		ctx: ExtensionCommandContext,
		args: string[],
	): Promise<void> {
		const waveFlagIdx = args.indexOf("--wave");
		const explicitWave =
			waveFlagIdx !== -1 && args[waveFlagIdx + 1]
				? Number(args[waveFlagIdx + 1])
				: undefined;
		const wfId = resolveWorkflowId(
			ctx,
			args.find((a) => !a.startsWith("--") && !/^\d+$/.test(a)),
		);
		if (!wfId) {
			notify(
				ctx,
				"无法确定 workflow(在仓库根目录运行,或显式传 workflow id)",
				"warning",
			);
			return;
		}
		const workflow = getWorkflow(db, wfId);
		if (!workflow) {
			notify(ctx, `workflow 不存在: ${wfId}`, "error");
			return;
		}
		const waveSeq = explicitWave ?? workflow.current_wave;
		const res = await mergeWave(db, workflow, waveSeq);
		if (res.ok) {
			notify(
				ctx,
				`wave ${waveSeq} 合并完成:${res.merged.length} 个步骤合回主分支${res.skipped > 0 ? `,${res.skipped} 个跳过` : ""}`,
			);
		} else {
			notify(ctx, `wave ${waveSeq} 合并未完成: ${res.error}`, "warning");
		}
	}

	// ── /wf retry <dotted|fullId> [--fresh] ───────────────
	async function cmdRetry(
		ctx: ExtensionCommandContext,
		args: string[],
	): Promise<void> {
		const fresh = args.includes("--fresh");
		const token = args.find((a) => a !== "--fresh");
		if (!token) {
			notify(ctx, "用法: /wf retry <dotted> [--fresh]", "warning");
			return;
		}
		const step = findStep(ctx, token);
		if (!step) {
			notify(ctx, `步骤不存在: ${token}`, "error");
			return;
		}
		if (!["failed", "aborted", "needs-fix"].includes(step.status)) {
			notify(
				ctx,
				`状态 ${step.status} 无需重试(仅 failed/aborted/needs-fix)`,
				"warning",
			);
			return;
		}
		const workflow = getWorkflow(db, step.workflow_id);
		if (!workflow) {
			notify(ctx, `workflow 不存在: ${step.workflow_id}`, "error");
			return;
		}
		const res = await dispatchStep(db, workflow, step, { fresh });
		if (res.ok) {
			notify(
				ctx,
				`已重派 ${step.id}${fresh ? "(--fresh 重建 worktree)" : ""} tab=${res.tabId ? res.tabId.slice(0, 8) : "?"}`,
			);
		} else {
			notify(ctx, `重派失败: ${res.error}`, "warning");
		}
	}

	// ── /wf steer <dotted|fullId> <文本> ──────────────────
	async function cmdSteer(
		ctx: ExtensionCommandContext,
		args: string[],
	): Promise<void> {
		const [token, ...text] = args;
		if (!token || text.length === 0) {
			notify(ctx, "用法: /wf steer <dotted> <文本>", "warning");
			return;
		}
		const step = findStep(ctx, token);
		if (!step) {
			notify(ctx, `步骤不存在: ${token}`, "error");
			return;
		}
		if (!step.tab_id) {
			notify(ctx, `步骤 ${step.id} 无 tab(tab_id 为空),无法 steer`, "warning");
			return;
		}
		const ghostctl = resolveBin("ghostctl");
		const msg = text.join(" ");
		const res = await run(
			ghostctl,
			["input", msg, "--to", step.tab_id],
			ctx.cwd,
		);
		await run(ghostctl, ["key", "enter", "--to", step.tab_id], ctx.cwd);
		if (res.code === 0) {
			notify(ctx, `已向 ${step.id} 的 tab 发送指令`);
		} else {
			notify(ctx, `发送失败: ${res.stderr || res.stdout}`, "warning");
		}
	}

	// ── /wf resolve-conflict <dotted|fullId> ──────────────
	function cmdResolveConflict(
		ctx: ExtensionCommandContext,
		args: string[],
	): void {
		const token = args[0];
		if (!token) {
			notify(ctx, "用法: /wf resolve-conflict <dotted>", "warning");
			return;
		}
		const step = findStep(ctx, token);
		if (!step) {
			notify(ctx, `步骤不存在: ${token}`, "error");
			return;
		}
		if (step.status !== "conflict") {
			notify(ctx, `状态 ${step.status} 不是 conflict,无需解决`, "warning");
			return;
		}
		updateStepStatus(db, step.id, STEP_STATUS.done);
		addEvent(db, {
			workflowId: step.workflow_id,
			stepId: step.id,
			type: EVT.stepResolved,
		});
		notify(ctx, `已确认解决 ${step.id} → done,可 /wf merge 继续`);
	}

	// ── /wf plan "<需求目标>" [--repo <path>] [--workflow <id>] [--dry-run] ──
	async function cmdPlan(
		ctx: ExtensionCommandContext,
		args: string[],
	): Promise<void> {
		const dryRun = args.includes("--dry-run");
		const repoFlagIdx = args.indexOf("--repo");
		const repoPath =
			repoFlagIdx !== -1 && args[repoFlagIdx + 1]
				? args[repoFlagIdx + 1]
				: ctx.cwd;
		const wfFlagIdx = args.indexOf("--workflow");
		const explicitWf =
			wfFlagIdx !== -1 && args[wfFlagIdx + 1] ? args[wfFlagIdx + 1] : undefined;
		const skip = new Set(["--dry-run", "--repo", "--workflow"]);
		const request = args
			.filter((a, i) => {
				if (skip.has(a)) return false;
				if (repoFlagIdx !== -1 && i === repoFlagIdx + 1) return false;
				if (wfFlagIdx !== -1 && i === wfFlagIdx + 1) return false;
				return true;
			})
			.join(" ");
		if (!request.trim()) {
			notify(
				ctx,
				'用法: /wf plan "<需求目标>" [--repo <path>] [--workflow <id>] [--dry-run]',
				"warning",
			);
			return;
		}
		notify(ctx, `[wf] planner 拆解中:"${request.slice(0, 60)}"…`);
		let result;
		try {
			result = await planFromGoal(repoPath, request);
		} catch (e) {
			notify(ctx, `planner 失败: ${(e as Error).message}`, "error");
			return;
		}
		if (dryRun) {
			ctx.ui.setWidget(
				"workflow-plan",
				JSON.stringify(result.plan, null, 2).split("\n"),
			);
			notify(ctx, "[wf] planner 输出已显示(--dry-run,未落库)");
			return;
		}
		const plan = result.plan as PlanInput;
		if (
			typeof plan !== "object" ||
			plan === null ||
			!plan.name ||
			!Array.isArray(plan.steps)
		) {
			notify(
				ctx,
				`planner 输出缺少 name/steps:\n${result.output.slice(0, 500)}`,
				"error",
			);
			return;
		}
		if (explicitWf) {
			// 给已有 workflow 的当前 wave 追加步骤(gap wave)
			const appendRes = appendSteps(
				db,
				explicitWf,
				getWorkflow(db, explicitWf)?.current_wave ?? 1,
				plan,
				ctx.cwd,
			);
			if (!appendRes.ok) {
				notify(
					ctx,
					`追加失败:\n${appendRes.errors?.slice(0, 10).join("\n")}`,
					"error",
				);
				return;
			}
			notify(
				ctx,
				`✓ 已向 ${explicitWf} 追加 ${appendRes.added} 个步骤(wave ${getWorkflow(db, explicitWf)?.current_wave}),可 /wf dispatch 派发`,
			);
			return;
		}
		const importRes = importPlan(db, plan, repoPath);
		if (!importRes.ok) {
			notify(
				ctx,
				`计划校验失败:\n${importRes.errors?.slice(0, 10).join("\n")}`,
				"error",
			);
			return;
		}
		notify(
			ctx,
			`✓ 已生成 workflow ${importRes.workflowId}:${importRes.stepCount} 步(wave ${importRes.wave}),可 /wf dispatch 派发`,
		);
	}

	// ── /wf goal-check [approve|reject <原因>] ────────────
	function cmdGoalCheck(ctx: ExtensionCommandContext, args: string[]): void {
		const [action, ...rest] = args;
		const wfId = resolveWorkflowId(ctx);
		if (!wfId) {
			notify(
				ctx,
				"无法确定 workflow(在仓库根目录运行,或显式传 workflow id)",
				"warning",
			);
			return;
		}
		const workflow = getWorkflow(db, wfId);
		if (!workflow) {
			notify(ctx, `workflow 不存在: ${wfId}`, "error");
			return;
		}
		if (action === undefined) {
			// 进入 verifying 并展示核对依据(设计 §4.4)
			const r = goalCheckEnter(db, wfId);
			if (!r.ok) {
				notify(ctx, r.error!, "error");
				return;
			}
			const steps = getStepsByWorkflow(db, wfId);
			const lines = [
				`[${wfId}] 目标核对(verifying)`,
				``,
				`最初目标: ${workflow.goal}`,
				``,
				...steps.map(
					(s) =>
						`${stepIcon(s)} ${s.id} ${s.title}\n    summary: ${s.summary ?? "-"}\n    issues: ${s.issues ?? "-"} | tests: ${s.tests ?? "-"}`,
				),
				``,
				`核对通过 → /wf goal-check approve;未达成 → /wf goal-check reject <原因>(拆 gap wave)`,
			];
			ctx.ui.setWidget("workflow-goal-check", lines);
			notify(
				ctx,
				"[wf] 已进入目标核对(verifying),请对照最初目标 approve / reject",
			);
			return;
		}
		if (action === "approve") {
			const r = goalCheckApprove(db, wfId, rest.join(" "));
			if (!r.ok) {
				notify(ctx, r.error!, "error");
				return;
			}
			notify(ctx, `✓ ${wfId} 目标核对通过 → completed`);
			return;
		}
		if (action === "reject") {
			const r = goalCheckReject(db, wfId, rest.join(" "));
			if (!r.ok) {
				notify(ctx, r.error!, "error");
				return;
			}
			notify(
				ctx,
				`${wfId} 目标未达成 → 回到 running;/wf next 拆 gap wave 补齐`,
				"warning",
			);
			return;
		}
		notify(ctx, "用法: /wf goal-check [approve|reject <原因>]", "warning");
	}

	// ── /wf next [--note <说明>] ──────────────────────────
	function cmdNext(ctx: ExtensionCommandContext, args: string[]): void {
		const noteIdx = args.indexOf("--note");
		const note = noteIdx !== -1 ? args.slice(noteIdx + 1).join(" ") : undefined;
		const wfId = resolveWorkflowId(
			ctx,
			args.find((a) => a !== "--note" && !a.startsWith("--")),
		);
		if (!wfId) {
			notify(
				ctx,
				"无法确定 workflow(在仓库根目录运行,或显式传 workflow id)",
				"warning",
			);
			return;
		}
		const r = nextWave(db, wfId, note);
		if (!r.ok) {
			notify(ctx, r.error!, "error");
			return;
		}
		notify(
			ctx,
			`wave ${r.seq} 已创建${note ? `(${note})` : ""};用 /wf plan --workflow ${wfId} 补步骤,或 /wf dispatch 派发`,
		);
	}

	// ── /wf resume(暂停后恢复)─────────────────────────────
	function cmdResume(ctx: ExtensionCommandContext, args: string[]): void {
		const wfId = resolveWorkflowId(ctx, args[0]);
		if (!wfId) {
			notify(
				ctx,
				"无法确定 workflow(在仓库根目录运行,或显式传 workflow id)",
				"warning",
			);
			return;
		}
		const workflow = getWorkflow(db, wfId);
		if (!workflow) {
			notify(ctx, `workflow 不存在: ${wfId}`, "error");
			return;
		}
		if (workflow.status !== WORKFLOW_STATUS.paused) {
			notify(ctx, `状态 ${workflow.status} 不是 paused,无需恢复`, "warning");
			return;
		}
		updateWorkflowStatus(db, wfId, WORKFLOW_STATUS.running);
		addEvent(db, { workflowId: wfId, type: EVT.workflowResumed });
		notify(ctx, `✓ ${wfId} 已恢复(running)`);
	}

	// ── 注册本插件 skill(使用与排查手册)──────────────────
	pi.on("resources_discover", async (_event, _ctx) => {
		return { skillPaths: [path.join(EXT_DIR, "skill")] };
	});

	// ── 存活轮询句柄(编排者侧)────────────────────────────
	let monitorStop: (() => void) | null = null;

	// ── session_start:子 pi 设标题;编排者崩溃恢复 + 启动轮询 ─
	pi.on("session_start", async (_event, ctx) => {
		const ident = resolveIdentity(ctx.cwd);
		if (ident?.stepId) {
			ctx.ui.setTitle(`wf ${ident.workflowId}/${ident.dotted}`);
		} else {
			// 崩溃恢复:running/dispatched 但 tab 已消失 → aborted(设计 §4.5)
			try {
				const { closed } = await recoverStaleSteps(db);
				if (closed.length > 0) {
					ctx.ui.notify(
						`[wf] 崩溃恢复:tab 已消失的步骤标 aborted: ${closed.join(", ")}`,
						"warning",
					);
				}
			} catch {
				/* 恢复失败不阻塞启动 */
			}
			// 存活轮询(5s,设计决策 12)
			monitorStop = startMonitor(db, {
				onClosed: (closed) =>
					ctx.ui.notify(
						`[wf] tab 关闭未回报 → aborted: ${closed.join(", ")}`,
						"warning",
					),
				onTick: () => renderWidget(ctx, db),
			});
		}
		renderWidget(ctx, db);
	});

	pi.on("session_shutdown", async () => {
		monitorStop?.();
		monitorStop = null;
	});
}
