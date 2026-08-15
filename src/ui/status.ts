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
	// 会话隔离:状态条/面板只显示 cwd 所在仓库的 workflow(谁发起谁看)
	const active = listActiveWorkflows(db, ctx.cwd);
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
// 计划概览面板(编辑区上方 widget,rpiv-todo 式列表,monitor tick 实时刷新)
// ────────────────────────────────────────────────────────────

export const PLAN_ICON = {
	running: "🔄",
	todo: "⏳",
	pending: "○",
	verify: "◐",
	abnormal: "✗",
	done: "✓",
	skipped: "–",
	conflict: "⚠",
	needsFix: "↻",
} as const;

/** 每个 workflow 面板最大行数(超出折叠已完成行) */
export const PLAN_MAX_ROWS = 10;

function visibleWidth(s: string): number {
	let n = 0;
	for (const c of s) n += c.charCodeAt(0) > 0xff ? 2 : 1;
	return n;
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

/** 单条任务行:层级缩进 + 状态字形 + 点号 id + 内容(+ 状态标签/依赖标注);完成行删除线。 */
function planStepLine(
	s: StepRow,
	dotted: string,
	deps: string[],
	depth: number,
): string {
	const indent = "  ".repeat(depth);
	const id = padEnd(dotted, 6);
	const title = truncWidth(s.title, Math.max(20, 60 - depth * 2));
	const depText =
		deps.length > 0
			? ` ${WF_ANSI.dim}[依赖 ${deps.join(",")}]${WF_ANSI.reset}`
			: "";
	switch (s.status) {
		case "running":
		case "dispatched":
			return `  ${indent}${WF_ANSI.yellow}${PLAN_ICON.running}${WF_ANSI.reset} ${id}${title} ${WF_ANSI.dim}(running)${WF_ANSI.reset}`;
		case "reported":
		case "waiting-verify":
			return `  ${indent}${WF_ANSI.cyan}${PLAN_ICON.verify}${WF_ANSI.reset} ${id}${title} ${WF_ANSI.cyan}(待核对)${WF_ANSI.reset}`;
		case "failed":
		case "aborted":
			return `  ${indent}${WF_ANSI.red}${PLAN_ICON.abnormal}${WF_ANSI.reset} ${id}${title} ${WF_ANSI.red}(${s.status})${WF_ANSI.reset}`;
		case "conflict":
			return `  ${indent}${WF_ANSI.red}${PLAN_ICON.conflict}${WF_ANSI.reset} ${id}${title} ${WF_ANSI.red}(冲突)${WF_ANSI.reset}`;
		case "needs-fix":
			return `  ${indent}${WF_ANSI.red}${PLAN_ICON.needsFix}${WF_ANSI.reset} ${id}${title} ${WF_ANSI.red}(待修复)${WF_ANSI.reset}`;
		case "done":
			return `  ${indent}${WF_ANSI.dim}${PLAN_ICON.done}${WF_ANSI.reset} ${id}${WF_ANSI.dim}\x1b[9m${title}\x1b[0m${WF_ANSI.reset}`;
		case "skipped":
			return `  ${indent}${WF_ANSI.dim}${PLAN_ICON.skipped}${WF_ANSI.reset} ${id}${WF_ANSI.dim}${title}(skipped)${WF_ANSI.reset}`;
		default:
			return `  ${indent}${PLAN_ICON.pending} ${id}${title}${depText}`;
	}
}

function padEnd(s: string, n: number): string {
	return s + " ".repeat(Math.max(0, n - s.length));
}

/**
 * 计划概览面板行(rpiv-todo 式列表,纯函数可测):每个活动 workflow 一段。
 * 标题(进度 + 计数)→ 逐条任务行(进行中/待核对/待办/完成,完成行删除线)。
 * 示例:
 *   ⛭ wf-control-center (2/8) · 🔄2
 *     🔄 api.lua:HTTP 路由(providers/open/close + 静态挂载) (running)
 *     ○ views:聚合配置页(webview 卡片网格) [依赖 3]
 *     ✓ sources.lua:只读协议扫描器(name/cards/pages + 单测)
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
			`${WF_ANSI.dim}(${done}/${steps.length})${WF_ANSI.reset}` +
			(running > 0
				? ` ${WF_ANSI.yellow}${PLAN_ICON.running}${running}${WF_ANSI.reset}`
				: "") +
			(verify > 0 ? ` ${WF_ANSI.cyan}${PLAN_ICON.verify}${verify}${WF_ANSI.reset}` : "") +
			(abnormal > 0 ? ` ${WF_ANSI.red}${PLAN_ICON.abnormal}${abnormal}${WF_ANSI.reset}` : "");
		lines.push(title);
		// 行预算:未完成行优先,完成行补足(折叠时先收完成行)
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
		for (const s of [...shownUnfinished, ...shownFinished]) {
			const dotted = s.id.slice(w.id.length + 1);
			const depth = dotted.split(".").length - 1;
			const deps = getStepDeps(db, s.id)
				.map((d) => d.slice(w.id.length + 1))
				.filter((d) => /^[0-9.]+$/.test(d));
			lines.push(planStepLine(s, dotted, deps, depth));
		}
		if (hidden > 0) {
			lines.push(
				`  ${WF_ANSI.dim}+${hidden} 已完成(${PLAN_ICON.done} 折叠)${WF_ANSI.reset}`,
			);
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
