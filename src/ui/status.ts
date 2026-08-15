/**
 * ui/status.ts — workflow 状态展示(状态条渲染,自 index.ts 收敛)
 *
 * 依赖方向:ui → db / core(无反向 import,见 docs/arch-refactor.md §3.10)。
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	listActiveWorkflows,
	getStepsByWorkflow,
	stepStatusCounts,
	workflowCost,
	getDb,
	type WorkflowRow,
	type StepRow,
} from "../db.ts";
import { STATUS_ICON } from "../core/state.ts";

export function statusCountsLine(
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

export function renderWorkflowStatus(
	ctx: ExtensionCommandContext,
	db: ReturnType<typeof getDb>,
): void {
	// 紧凑状态走 ctx.ui.setStatus:pi 原生 footer 与 pi-powerline-footer 的
	// extension_statuses 段都会渲染;monitor 每 5s tick + 每次 /wf 命令后刷新。
	// 注意:不能以 "[" 开头(powerline 会把 "[...]" 当通知而非状态条内容)。
	const active = listActiveWorkflows(db);
	if (active.length === 0) {
		ctx.ui.setStatus("wf", undefined);
		return;
	}
	const segments = active.map((w) => {
		const counts = stepStatusCounts(db, w.id);
		const steps = getStepsByWorkflow(db, w.id);
		const cost = workflowCost(db, w.id);
		return workflowStatusSegment(w, counts, steps, cost);
	});
	ctx.ui.setStatus(
		"wf",
		segments.join(` ${WF_ANSI.dim}·${WF_ANSI.reset} `),
	);
}

/** 单个 workflow 的紧凑状态段:⛭ wf-demo 3/4 ▶1.2 ◐1 ✗1 $0.42 */
export function workflowStatusSegment(
	w: WorkflowRow,
	counts: Record<string, number>,
	steps: StepRow[],
	cost: { cost_cents: number } | null,
): string {
	const total = steps.length;
	const done = (counts.done ?? 0) + (counts.skipped ?? 0);
	const verify = (counts.reported ?? 0) + (counts["waiting-verify"] ?? 0);
	const abnormal =
		(counts.failed ?? 0) +
		(counts.aborted ?? 0) +
		(counts.conflict ?? 0) +
		(counts["needs-fix"] ?? 0);
	// 执行中的步骤(▶ + 点号 id,最多 3 个)
	const runningIds = steps
		.filter((s) => s.status === "running" || s.status === "dispatched")
		.map((s) => s.id.slice(w.id.length + 1));
	const runningText =
		runningIds.length > 0
			? `${WF_ANSI.yellow}${STATUS_ICON.running}${runningIds.slice(0, 3).join(",")}${runningIds.length > 3 ? `+${runningIds.length - 3}` : ""}${WF_ANSI.reset} `
			: "";
	const costText =
		cost && cost.cost_cents > 0
			? ` ${WF_ANSI.dim}$${(cost.cost_cents / 100).toFixed(2)}${WF_ANSI.reset}`
			: "";
	const parts = [
		`${WF_STATUS_COLOR[w.status] ?? WF_ANSI.dim}${w.id}${WF_ANSI.reset}`,
		`${WF_ANSI.dim}${done}/${total}${WF_ANSI.reset}`,
	];
	if (runningText) parts.push(runningText);
	if (verify > 0) parts.push(`${WF_ANSI.cyan}${STATUS_ICON.reported}${verify}${WF_ANSI.reset}`);
	if (abnormal > 0) parts.push(`${WF_ANSI.red}${STATUS_ICON.failed}${abnormal}${WF_ANSI.reset}`);
	return parts.join(" ") + costText;
}

export const WF_ANSI = {
	reset: "\x1b[0m",
	dim: "\x1b[2m",
	yellow: "\x1b[33;1m",
	cyan: "\x1b[36m",
	red: "\x1b[31;1m",
} as const;

export const WF_STATUS_COLOR: Record<string, string> = {
	idle: WF_ANSI.dim,
	running: WF_ANSI.yellow,
	paused: WF_ANSI.dim,
	verifying: WF_ANSI.cyan,
	failed: WF_ANSI.red,
	aborted: WF_ANSI.red,
};
