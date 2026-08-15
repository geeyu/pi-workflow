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

/** 执行时长:运行中=已运行,终态=耗时。60s 内秒,其余分钟,超 1h 带小时。 */
function durText(startedAt: number | null, finishedAt: number | null): string {
	if (!startedAt) return "";
	const end = finishedAt ?? Date.now();
	const sec = Math.max(0, Math.round((end - startedAt) / 1000));
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m`;
	return `${Math.floor(min / 60)}h${min % 60}m`;
}

/**
 * 单条任务行(rpiv-todo 风格):树形连接线 + 状态字形 + 点号 id + 内容 + 时长/依赖。
 * 完成行删除线并置顶;running 显示已运行时长。
 */
function planStepLine(
	s: StepRow,
	dotted: string,
	deps: string[],
	conn: string,
): string {
	const id = padEnd(dotted, 6);
	const title = truncWidth(s.title, Math.max(20, 60 - conn.length));
	const dur = durText(s.started_at, s.finished_at);
	const durText_ =
		dur.length > 0 ? ` ${WF_ANSI.dim}(${dur})${WF_ANSI.reset}` : "";
	const depText =
		deps.length > 0
			? ` ${WF_ANSI.dim}[依赖 ${deps.join(",")}]${WF_ANSI.reset}`
			: "";
	// 连接线后空一格(rpiv-todo 风格:├─ ✓ …)
	const g = (glyph: string, color: string): string =>
		`${conn} ${color}${glyph}${WF_ANSI.reset} ${id}`;
	switch (s.status) {
		case "running":
		case "dispatched":
			return `${g(PLAN_ICON.running, WF_ANSI.yellow)}${title}${durText_}`;
		case "reported":
		case "waiting-verify":
			return `${g(PLAN_ICON.verify, WF_ANSI.cyan)}${title}${durText_} ${WF_ANSI.cyan}(待核对)${WF_ANSI.reset}`;
		case "failed":
		case "aborted":
			return `${g(PLAN_ICON.abnormal, WF_ANSI.red)}${title}${durText_} ${WF_ANSI.red}(${s.status})${WF_ANSI.reset}`;
		case "conflict":
			return `${g(PLAN_ICON.conflict, WF_ANSI.red)}${title}${durText_} ${WF_ANSI.red}(冲突)${WF_ANSI.reset}`;
		case "needs-fix":
			return `${g(PLAN_ICON.needsFix, WF_ANSI.red)}${title}${durText_} ${WF_ANSI.red}(待修复)${WF_ANSI.reset}`;
		case "done":
			return `${g(PLAN_ICON.done, WF_ANSI.dim)}${WF_ANSI.dim}\x1b[9m${title}\x1b[0m${WF_ANSI.reset}${durText_}`;
		case "skipped":
			return `${g(PLAN_ICON.skipped, WF_ANSI.dim)}${WF_ANSI.dim}${title}(skipped)${WF_ANSI.reset}`;
		default:
			return `${conn} ${PLAN_ICON.pending} ${id}${title}${depText}`;
	}
}

function padEnd(s: string, n: number): string {
	return s + " ".repeat(Math.max(0, n - s.length));
}

interface PlanNode {
	step: StepRow;
	dotted: string;
	children: PlanNode[];
}

/** 按点号 id 前缀构建层级树(父缺失时挂顶层;子按 sort_order 序) */
function buildPlanTree(steps: StepRow[], wfId: string): PlanNode[] {
	const roots: PlanNode[] = [];
	const byDotted = new Map<string, PlanNode>();
	for (const s of steps) {
		const dotted = s.id.slice(wfId.length + 1);
		const node: PlanNode = { step: s, dotted, children: [] };
		byDotted.set(dotted, node);
		const dotIdx = dotted.lastIndexOf(".");
		const parentDotted = dotIdx === -1 ? null : dotted.slice(0, dotIdx);
		const parent = parentDotted ? byDotted.get(parentDotted) : undefined;
		if (parent) parent.children.push(node);
		else roots.push(node);
	}
	return roots;
}

/** DFS 渲染:树形连接线(├─/└─/│),父前缀延续 */
function walkPlan(
	nodes: PlanNode[],
	prefix: string,
	db: ReturnType<typeof getDb>,
	wfId: string,
	lines: string[],
	budget: number,
): void {
	for (let i = 0; i < nodes.length; i++) {
		if (lines.length >= budget) return;
		const node = nodes[i]!;
		const isLast = i === nodes.length - 1;
		const conn = `${prefix}${isLast ? "└─" : "├─"}`;
		const deps = getStepDeps(db, node.step.id)
			.map((d) => d.slice(wfId.length + 1))
			.filter((d) => /^[0-9.]+$/.test(d));
		lines.push(planStepLine(node.step, node.dotted, deps, conn));
		walkPlan(
			node.children,
			`${prefix}${isLast ? "  " : "│ "}`,
			db,
			wfId,
			lines,
			budget,
		);
	}
}

/**
 * 计划概览面板(rpiv-todo 风格,纯函数可测):每个活动 workflow 一段。
 * 标题 `● <id> (done/total) 🔄N` → 树形连接线逐条任务(完成行删除线置顶,
 * running 显示已运行时长,完成行显示耗时)。
 * 示例:
 *   ● wf-control-center (5/8) 🔄1
 *   ├─ ✓ 1  sources.lua 只读协议扫描器 (12m)
 *   ├─ ✓ 2  panel.lua 配置面板单例 (25m)
 *   ├─ 🔄 6  init.lua 装配 + 根 init.lua 一行接入 (3m)
 *   └─ ○ 8  集成验证与零侵入回归 [依赖 6,7]
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
		lines.push(
			`${WF_STATUS_COLOR[w.status] ?? WF_ANSI.dim}● ${w.id}${WF_ANSI.reset} ` +
				`${WF_ANSI.dim}(${done}/${steps.length})${WF_ANSI.reset}` +
				(running > 0
					? ` ${WF_ANSI.yellow}${PLAN_ICON.running}${running}${WF_ANSI.reset}`
					: "") +
				(verify > 0
					? ` ${WF_ANSI.cyan}${PLAN_ICON.verify}${verify}${WF_ANSI.reset}`
					: "") +
				(abnormal > 0
					? ` ${WF_ANSI.red}${PLAN_ICON.abnormal}${abnormal}${WF_ANSI.reset}`
					: ""),
		);
		// 完成行置顶(删除线),未完成在后;组内保持树序(sort_order 前缀序)
		const isFinished = (s: StepRow): boolean =>
			s.status === "done" || s.status === "skipped";
		const sorted = [
			...steps.filter(isFinished),
			...steps.filter((s) => !isFinished(s)),
		];
		const roots = buildPlanTree(sorted, w.id);
		const budget = lines.length + 1 + PLAN_MAX_ROWS;
		walkPlan(roots, "", db, w.id, lines, budget);
		const hidden = steps.length - (lines.length - 1);
		if (hidden > 0) {
			lines.push(
				`  ${WF_ANSI.dim}+${hidden} 步未显示(${PLAN_ICON.done} 折叠)${WF_ANSI.reset}`,
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
