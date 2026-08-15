/**
 * ui/status.ts — workflow 状态展示(状态条渲染,自 index.ts 收敛)
 *
 * 依赖方向:ui → db / core(无反向 import,见 docs/arch-refactor.md §3.10)。
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	listActiveWorkflows,
	getStepsByWorkflow,
	getStepDeps,
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
	// 面板(计划概览表格)走 setWidget,编辑区上方实时展示。
	const active = listActiveWorkflows(db);
	if (active.length === 0) {
		ctx.ui.setStatus("wf", undefined);
		ctx.ui.setWidget("workflow-plan", undefined);
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
	const plan = buildPlanLines(db, active);
	ctx.ui.setWidget("workflow-plan", plan.length > 0 ? plan : undefined);
}

/**
 * 单个 workflow 的紧凑状态段:⛭ control-center 2/8 🔄2 ⏳4 ◐1 ✗1 $0.42
 * 语义化计数:🔄 运行中 / ⏳ 待办(pending+ready)/ ◐ 待核对 / ✗ 异常;不再用点号 id 列表。
 */
export function workflowStatusSegment(
	w: WorkflowRow,
	counts: Record<string, number>,
	steps: StepRow[],
	cost: { cost_cents: number } | null,
): string {
	const total = steps.length;
	const done = (counts.done ?? 0) + (counts.skipped ?? 0);
	const running = (counts.dispatched ?? 0) + (counts.running ?? 0);
	const todo = (counts.pending ?? 0) + (counts.ready ?? 0);
	const verify = (counts.reported ?? 0) + (counts["waiting-verify"] ?? 0);
	const abnormal =
		(counts.failed ?? 0) +
		(counts.aborted ?? 0) +
		(counts.conflict ?? 0) +
		(counts["needs-fix"] ?? 0);
	const costText =
		cost && cost.cost_cents > 0
			? ` ${WF_ANSI.dim}$${(cost.cost_cents / 100).toFixed(2)}${WF_ANSI.reset}`
			: "";
	const parts = [
		`${WF_STATUS_COLOR[w.status] ?? WF_ANSI.dim}${w.id}${WF_ANSI.reset}`,
		`${WF_ANSI.dim}${done}/${total}${WF_ANSI.reset}`,
	];
	if (running > 0) parts.push(`${WF_ANSI.yellow}${PLAN_ICON.running}${running}${WF_ANSI.reset}`);
	if (todo > 0) parts.push(`${WF_ANSI.dim}${PLAN_ICON.todo}${todo}${WF_ANSI.reset}`);
	if (verify > 0) parts.push(`${WF_ANSI.cyan}${PLAN_ICON.verify}${verify}${WF_ANSI.reset}`);
	if (abnormal > 0) parts.push(`${WF_ANSI.red}${PLAN_ICON.abnormal}${abnormal}${WF_ANSI.reset}`);
	return parts.join(" ") + costText;
}

// ────────────────────────────────────────────────────────────
// 计划概览面板(编辑区上方 widget,表格形式,monitor tick 实时刷新)
// ────────────────────────────────────────────────────────────

export const PLAN_ICON = {
	running: "🔄",
	todo: "⏳",
	verify: "◐",
	abnormal: "✗",
	done: "✓",
	skipped: "–",
	conflict: "⚠",
	needsFix: "↻",
} as const;

/** 每个 workflow 面板最大行数(超出折叠已完成行) */
export const PLAN_MAX_ROWS = 10;

/** 状态列文案(含依赖信息) */
function stepStatusText(step: StepRow, deps: string[]): string {
	switch (step.status) {
		case "running":
		case "dispatched":
			return `${PLAN_ICON.running} running`;
		case "reported":
		case "waiting-verify":
			return `${PLAN_ICON.verify} 待核对`;
		case "done":
			return `${PLAN_ICON.done} done`;
		case "skipped":
			return `${PLAN_ICON.skipped} skipped`;
		case "failed":
			return `${PLAN_ICON.abnormal} failed`;
		case "aborted":
			return `${PLAN_ICON.abnormal} aborted`;
		case "conflict":
			return `${PLAN_ICON.conflict} 冲突`;
		case "needs-fix":
			return `${PLAN_ICON.needsFix} 待修复`;
		default:
			// pending / ready:显示依赖(如“依赖 1,2”),无依赖显示待办
			return deps.length > 0
				? `${PLAN_ICON.todo} 依赖 ${deps.join(",")}`
				: `${PLAN_ICON.todo} 待办`;
	}
}

function visibleWidth(s: string): number {
	let n = 0;
	for (const c of s) n += c.charCodeAt(0) > 0xff ? 2 : 1;
	return n;
}

function padWidth(s: string, n: number): string {
	return s + " ".repeat(Math.max(0, n - visibleWidth(s)));
}

function truncWidth(s: string, n: number): string {
	if (visibleWidth(s) <= n) return s;
	let out = "";
	let w = 0;
	for (const c of s) {
		const cw = c.charCodeAt(0) > 0xff ? 2 : 1;
		if (w + cw > n - 1) break;
		out += c;
		w += cw;
	}
	return out + "…";
}

/**
 * 计划概览面板行(纯函数,可测):每个活动 workflow 一个表格。
 * 列:步骤 | 内容(截断) | 状态(含依赖)。标题带进度与运行计数。
 * 示例:
 *   ⛭ control-center 计划概览 2/8 · 🔄2
 *   ┌──────┬────────────────────────────┬────────────────┐
 *   │ 1    │ sources.lua 只读协议扫描器… │ 🔄 running     │
 *   ...
 */
export function buildPlanLines(
	db: ReturnType<typeof getDb>,
	workflows: WorkflowRow[],
): string[] {
	const lines: string[] = [];
	for (const w of workflows.slice(0, 2)) {
		const steps = getStepsByWorkflow(db, w.id);
		if (steps.length === 0) continue;
		const counts = stepStatusCounts(db, w.id);
		const done = (counts.done ?? 0) + (counts.skipped ?? 0);
		const running = (counts.dispatched ?? 0) + (counts.running ?? 0);
		const verify = (counts.reported ?? 0) + (counts["waiting-verify"] ?? 0);
		const abnormal =
			(counts.failed ?? 0) +
			(counts.aborted ?? 0) +
			(counts.conflict ?? 0) +
			(counts["needs-fix"] ?? 0);
		const title =
			`${WF_STATUS_COLOR[w.status] ?? WF_ANSI.dim}⛭ ${w.id}${WF_ANSI.reset} ` +
			`计划概览 ${done}/${steps.length} · ${WF_ANSI.yellow}${PLAN_ICON.running}${running}${WF_ANSI.reset}` +
			(verify > 0 ? ` ${WF_ANSI.cyan}${PLAN_ICON.verify}${verify}${WF_ANSI.reset}` : "") +
			(abnormal > 0 ? ` ${WF_ANSI.red}${PLAN_ICON.abnormal}${abnormal}${WF_ANSI.reset}` : "");
		lines.push(title);
		// 行预算:先取未完成(非 done/skipped)行,再补已完成行(最多 PLAN_MAX_ROWS 行)
		const unfinished = steps.filter(
			(s) => s.status !== "done" && s.status !== "skipped",
		);
		const finished = steps.filter(
			(s) => s.status === "done" || s.status === "skipped",
		);
		const shownUnfinished = unfinished.slice(0, PLAN_MAX_ROWS);
		const shownFinished = finished.slice(
			0,
			Math.max(0, PLAN_MAX_ROWS - shownUnfinished.length),
		);
		const hidden = finished.length - shownFinished.length;
		const rows = [...shownUnfinished, ...shownFinished];
		const cwStep = 6;
		const cwContent = 34;
		const cwStatus = 16;
		const sepTop = "─".repeat(cwStep) + "┬" + "─".repeat(cwContent) + "┬" + "─".repeat(cwStatus);
		const sepMid = "─".repeat(cwStep) + "┼" + "─".repeat(cwContent) + "┼" + "─".repeat(cwStatus);
		lines.push(`┌${sepTop}┐`);
		lines.push(
			`│${padWidth("步骤", cwStep)}│${padWidth("内容", cwContent)}│${padWidth("状态", cwStatus)}│`,
		);
		lines.push(`├${sepMid}┤`);
		for (const s of rows) {
			const dotted = s.id.slice(w.id.length + 1);
			const deps = getStepDeps(db, s.id)
				.map((d) => d.slice(w.id.length + 1))
				.filter((d) => /^[0-9.]+$/.test(d));
			lines.push(
				`│${padWidth(dotted, cwStep)}│${padWidth(truncWidth(s.title, cwContent), cwContent)}│${padWidth(stepStatusText(s, deps), cwStatus)}│`,
			);
		}
		lines.push(`└${sepTop}┘`);
		if (hidden > 0) {
			lines.push(`  ${WF_ANSI.dim}… 另有 ${hidden} 步已完成,${PLAN_ICON.done} 折叠${WF_ANSI.reset}`);
		}
	}
	return lines;
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
