/**
 * ui/status.ts — workflow 状态展示(状态条渲染,自 index.ts 收敛)
 *
 * 依赖方向:ui → db / core(无反向 import,见 docs/arch-refactor.md §3.10)。
 */
import type { ExtensionCommandContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
	listActiveWorkflows,
	getStepsByWorkflow,
	getStepDeps,
	stepStatusCounts,
	workflowCost,
	type getDb,
	type WorkflowRow,
	type StepRow,
} from "../core/db.ts";
import { STATUS_ICON } from "../core/state.ts";
import { sanitizeTerminalText } from "../sanitize.ts";
import { COLLAPSE_KEY_OFF, getMaxWidgetLines, resolveCollapseKey } from "../config.ts";
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
	// factory 形式:每帧拿 theme(主题语义色,跟随用户主题)与 width(截断)
	ctx.ui.setWidget("workflow-plan", (_tui, theme) => ({
		render: (width: number) =>
			buildPlanLines(db, active, theme, width, {
				collapsed: planCollapsed,
			}),
	}));
}

// ────────────────────────────────────────────────────────────
// 面板折叠状态 + 完成行收起策略(参考 rpiv-todo completedTaskIdsPendingHide)
// ────────────────────────────────────────────────────────────

/** 面板折叠态(进程内;registerShortcut 切换,renderWorkflowStatus 读取) */
let planCollapsed = false;

/** 本 turn 完成、下 turn 收起的步骤 id(本 turn 显示) */
const completedPendingHide = new Set<string>();
/** 已收起的完成步骤 id(渲染时隐藏) */
const hiddenCompleted = new Set<string>();

/** 切换面板折叠态,返回新状态 */
export function togglePlanCollapsed(): boolean {
	planCollapsed = !planCollapsed;
	return planCollapsed;
}

/** 面板当前折叠态 */
export function isPlanCollapsed(): boolean {
	return planCollapsed;
}

/** 完成行收起跟踪的当前状态(测试/诊断用) */
export function completedDisplayState(): {
	pendingHide: string[];
	hidden: string[];
} {
	return {
		pendingHide: [...completedPendingHide],
		hidden: [...hiddenCompleted],
	};
}

/** 重置完成行跟踪(session_start 等全新上下文时调用) */
export function resetCompletedDisplayState(): void {
	completedPendingHide.clear();
	hiddenCompleted.clear();
}

/**
 * 收起上一 turn 完成的行(agent_start 时调用):pendingHide → hidden。
 * 本 turn 新完成的行保持显示,下个 turn 才收起(参考 rpiv completedTaskIdsPendingHide)。
 */
export function hideCompletedFromPreviousTurn(): void {
	for (const id of completedPendingHide) hiddenCompleted.add(id);
	completedPendingHide.clear();
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
	theme: Theme,
): string {
	const id = theme.fg("dim", padEnd(dotted, 6));
	// 模型可控标题渲染前净化(P0-1):防 CSI/OSC/双向符污染面板布局(truncWidth 不防转义)
	const title = truncWidth(sanitizeTerminalText(s.title), Math.max(20, 56 - conn.length));
	const dur = durText(s.started_at, s.finished_at);
	const durText_ = dur ? ` ${theme.fg("muted", `(${dur})`)}` : "";
	const depText =
		deps.length > 0 ? ` ${theme.fg("muted", `⛓ ${deps.join(",")}`)}` : "";
	// 连接线 dim + 空格 + 语义色字形(rpiv-todo 风格:├─ ✓ …)
	const glyph = (g: string, c: ThemeColor): string =>
		`${theme.fg("dim", conn)} ${theme.fg(c, g)}`;
	switch (s.status) {
		case "running":
		case "dispatched":
			return `${glyph(PLAN_ICON.running, "warning")} ${id}${theme.fg("accent", title)}${durText_}`;
		case "reported":
		case "waiting-verify":
			return `${glyph(PLAN_ICON.verify, "warning")} ${id}${theme.fg("accent", title)}${durText_} ${theme.fg("warning", "(待核对)")}`;
		case "failed":
		case "aborted":
			return `${glyph(PLAN_ICON.abnormal, "error")} ${id}${theme.fg("error", title)}${durText_} ${theme.fg("error", `(${s.status})`)}`;
		case "conflict":
			return `${glyph(PLAN_ICON.conflict, "error")} ${id}${theme.fg("error", title)}${durText_} ${theme.fg("error", "(冲突)")}`;
		case "needs-fix":
			return `${glyph(PLAN_ICON.needsFix, "error")} ${id}${theme.fg("error", title)}${durText_} ${theme.fg("error", "(待修复)")}`;
		case "done":
			return `${glyph(PLAN_ICON.done, "success")} ${id}${theme.strikethrough(theme.fg("muted", title))}${durText_}`;
		case "skipped":
			return `${glyph(PLAN_ICON.skipped, "dim")} ${id}${theme.fg("muted", `${title}(skipped)`)}`;
		default:
			return `${theme.fg("dim", conn)} ${theme.fg("dim", PLAN_ICON.pending)} ${id}${theme.fg("text", title)}${depText}`;
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
	theme: Theme,
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
		lines.push(planStepLine(node.step, node.dotted, deps, conn, theme));
		walkPlan(
			node.children,
			`${prefix}${isLast ? "  " : "│ "}`,
			db,
			wfId,
			theme,
			lines,
			budget,
		);
	}
}

/**
 * 计划概览面板(rpiv-todo 风格,纯函数可测):每个活动 workflow 一段。
 * 标题 `● <id> (done/total) 🔄N` → 树形连接线逐条任务(完成行删除线置顶,
 * running 显示已运行时长,完成行显示耗时)。
 * 折叠态(collapsed):仅标题 + `└─ <key> 展开` 提示行,不渲染任务行。(P0-2)
 * 完成行收起:本 turn 完成的行正常显示并记入 pendingHide;hideCompletedFromPreviousTurn
 * (agent_start)后收起——计数仍在标题,收起行计入「+N 步未显示」。(P1-3)
 * 行预算:getMaxWidgetLines()(含标题),超预算先收完成行再截断未完成尾部。(P0-2)
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
	theme: Theme,
	width = 120,
	opts: { collapsed?: boolean } = {},
): string[] {
	const lines: string[] = [];
	const fit = (line: string): string => truncWidth(line, width);
	// 完成行(终态)判定:done/skipped
	const isTerminal = (s: StepRow): boolean =>
		s.status === "done" || s.status === "skipped";
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
		// 标题:有活动(运行/待核对/异常) → accent 高亮 + ●;无活动 → dim + ○
		const hasActive = running + verify + abnormal > 0;
		const hc = hasActive ? "accent" : "dim";
		const head =
			`${theme.fg(hc, hasActive ? "●" : "○")} ` +
			`${theme.fg(hc, `${w.id} (${done}/${steps.length})`)}` +
			(running > 0 ? ` ${theme.fg("warning", `${PLAN_ICON.running}${running}`)}` : "") +
			(verify > 0 ? ` ${theme.fg("warning", `${PLAN_ICON.verify}${verify}`)}` : "") +
			(abnormal > 0 ? ` ${theme.fg("error", `${PLAN_ICON.abnormal}${abnormal}`)}` : "");
		lines.push(fit(head));

		// 折叠态:标题 + 展开提示行(参考 rpiv-todo 折叠渲染;折叠时不渲染任务行
		// 也不做完成行跟踪——没有展示就无需跟踪)
		if (opts.collapsed) {
			const key = resolveCollapseKey();
			const hint = key === COLLAPSE_KEY_OFF ? "已折叠" : `${key} 展开`;
			lines.push(fit(`${theme.fg("dim", "└─")} ${theme.fg("dim", hint)}`));
			continue;
		}

		// 完成行收起策略:先清理失效跟踪(重派后不再是终态 → 恢复显示),
		// 已收起的从可见集剔除;本 turn 新终态行记入 pendingHide(本 turn 显示)
		const terminalIds = new Set<string>();
		for (const s of steps) if (isTerminal(s)) terminalIds.add(s.id);
		for (const id of [...completedPendingHide]) {
			if (!terminalIds.has(id)) completedPendingHide.delete(id);
		}
		for (const id of [...hiddenCompleted]) {
			if (!terminalIds.has(id)) hiddenCompleted.delete(id);
		}
		const visible = steps.filter((s) => !hiddenCompleted.has(s.id));
		for (const s of visible) {
			if (isTerminal(s) && !completedPendingHide.has(s.id)) {
				completedPendingHide.add(s.id);
			}
		}

		// 完成行置顶(删除线),未完成在后;组内保持树序(sort_order 前缀序)
		const sorted = [
			...visible.filter(isTerminal),
			...visible.filter((s) => !isTerminal(s)),
		];
		const roots = buildPlanTree(sorted, w.id);
		const budget = lines.length + 1 + getMaxWidgetLines() - 1;
		walkPlan(roots, "", db, w.id, theme, lines, budget);
		const hidden = steps.length - (lines.length - 1);
		if (hidden > 0) {
			lines.push(
				fit(`${theme.fg("dim", `+${hidden} 步未显示(${PLAN_ICON.done} 折叠)`)}`),
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
