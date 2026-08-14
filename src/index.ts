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
import {
	ATTEMPT_STATUS,
	type StepRow,
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
	workflowCost,
} from "./db.ts";
import {
	importPlan,
	reportDone,
	reportFail,
	verifyStep,
} from "./orchestrator.ts";
import type { PlanInput } from "./validate.ts";
import { dispatchStep, parseExpectations } from "./dispatch.ts";

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
					case "status":
						cmdStatus(ctx, rest);
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
							`用法: /wf import|dispatch|context|done|fail|verify|status|tree|step|events\n示例: /wf status / /wf import plan.json / /wf done 1.1 '{"summary":"..."}'`,
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
		if (tokens.length === 0) {
			notify(
				ctx,
				"用法: /wf dispatch <dotted>... [--dry-run] [--workflow <id>]",
				"warning",
			);
			return;
		}
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
		const results: string[] = [];
		for (const token of tokens) {
			const step = getStep(db, token) ?? getStep(db, `${wfId}-${token}`);
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
		const wf = getWorkflow(db, step.workflow_id);
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

	// ── 子 pi 身份:session_start 设置标题 ──────────────────
	pi.on("session_start", async (_event, ctx) => {
		const ident = resolveIdentity(ctx.cwd);
		if (ident?.stepId) {
			ctx.ui.setTitle(`wf ${ident.workflowId}/${ident.dotted}`);
		}
		renderWidget(ctx, db);
	});
}
