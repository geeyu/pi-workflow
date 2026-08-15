/**
 * ui/board.ts — P5 看板(设计 §8:看板即查询)
 *
 * buildBoard:按状态列分组(5 列映射,层级 id 缩进)
 * renderBoardText:终端文本列布局(pi widget / CLI 输出)
 * renderBoardHtml:单文件静态 HTML 看板(内嵌样式,可分享)
 *
 * 列映射(§8.1):pending/ready→待办,dispatched/running→进行中,
 * reported/waiting-verify→待核对,done/skipped→完成,
 * failed/aborted/conflict/needs-fix→异常。
 */
import type { DatabaseSync } from "node:sqlite";
import { getStepsByWave, getStepsByWorkflow } from "../core/db.ts";
import { STATUS_ICON } from "../core/state.ts";
import { sanitizeTerminalText } from "../sanitize.ts";

export interface BoardCard {
	id: string; // <workflowId>-<dotted>
	dotted: string;
	title: string;
	agent: string;
	status: string;
	gate: boolean;
	depth: number; // 层级深度(1 起)
	summary: string | null;
}

export interface BoardColumn {
	key: string;
	label: string;
	cards: BoardCard[];
}

export interface Board {
	workflowId: string;
	title: string;
	goal: string;
	status: string;
	wave: number | null;
	columns: BoardColumn[];
	total: number;
	done: number;
}

const COLUMNS: Array<{ key: string; label: string; statuses: string[] }> = [
	{ key: "todo", label: "待办", statuses: ["pending", "ready"] },
	{ key: "running", label: "进行中", statuses: ["dispatched", "running"] },
	{ key: "verify", label: "待核对", statuses: ["reported", "waiting-verify"] },
	{ key: "done", label: "完成", statuses: ["done", "skipped"] },
	{
		key: "abnormal",
		label: "异常",
		statuses: ["failed", "aborted", "conflict", "needs-fix"],
	},
];

/** 兼容导出名(单一来源 core/state.ts STATUS_ICON,arch-refactor §5.2) */
export const STATUS_ICON_BOARD: Record<string, string> = STATUS_ICON;

/** 收集看板数据(可按 wave 过滤) */
export function buildBoard(
	db: DatabaseSync,
	workflowId: string,
	waveSeq?: number,
): Board | null {
	const wf = db
		.prepare("SELECT id, title, goal, status FROM workflow WHERE id = ?")
		.get(workflowId) as
		| { id: string; title: string; goal: string; status: string }
		| undefined;
	if (!wf) return null;

	const steps = waveSeq
		? getStepsByWave(db, waveSeq)
		: getStepsByWorkflow(db, workflowId);
	const cards: BoardCard[] = steps.map((s) => ({
		id: s.id,
		dotted: s.id.slice(workflowId.length + 1),
		title: sanitizeTerminalText(s.title),
		agent: s.agent,
		status: s.status,
		gate: Boolean(s.gate),
		depth: s.id.slice(workflowId.length + 1).split(".").length,
		summary: s.summary ? sanitizeTerminalText(s.summary) : null,
	}));

	const columns: BoardColumn[] = COLUMNS.map((c) => ({
		key: c.key,
		label: c.label,
		cards: cards.filter((card) => c.statuses.includes(card.status)),
	}));

	const done = columns.find((c) => c.key === "done")?.cards.length ?? 0;
	return {
		workflowId,
		title: sanitizeTerminalText(wf.title),
		goal: sanitizeTerminalText(wf.goal),
		status: wf.status,
		wave: waveSeq ?? null,
		columns,
		total: cards.length,
		done,
	};
}

function cardLine(card: BoardCard): string {
	const icon = STATUS_ICON_BOARD[card.status] ?? "?";
	const indent = "  ".repeat(card.depth - 1);
	const meta = [card.agent, card.gate ? "gate" : null]
		.filter(Boolean)
		.join("/");
	const summary = card.summary ? ` · ${card.summary.slice(0, 12)}` : "";
	return `${indent}${icon} ${card.dotted} ${card.title} [${meta}]${summary}`;
}

/** 终端文本看板:5 列并排(列宽自适应,窄终端回退为逐列) */
export function renderBoardText(board: Board): string[] {
	if (board.total === 0) return [`[${board.workflowId}] (无步骤)`];
	const header = `[${board.workflowId}] ${board.title} | ${board.status} | ${board.done}/${board.total} 完成${board.wave ? ` | wave ${board.wave}` : ""}`;
	const lines: string[] = [header, ""];

	const bodyOf = (c: BoardColumn): string[] => c.cards.map(cardLine);
	const bodies = board.columns.map(bodyOf);
	const contentWidth = Math.max(
		6,
		...board.columns.map((c, i) =>
			Math.max(c.label.length + 2, ...bodies[i].map((l) => l.length)),
		),
	);
	const width = Math.min(24, contentWidth);
	const cols = board.columns.map((c, i) => ({
		...c,
		body: bodies[i],
		width,
	}));

	// 预估总宽:5 列 × (width+3) 若 > 100 则逐列输出
	const totalWidth = cols.reduce((s, c) => s + c.width + 3, 1);
	if (totalWidth <= 150) {
		const rows = Math.max(...cols.map((c) => c.body.length), 1);
		const top = "┌" + cols.map((c) => "─".repeat(c.width)).join("┬") + "┐";
		const mid = "├" + cols.map((c) => "─".repeat(c.width)).join("┼") + "┤";
		const bottom = "└" + cols.map((c) => "─".repeat(c.width)).join("┴") + "┘";
		lines.push(top);
		lines.push(cols.map((c) => `│${c.label.padEnd(c.width)}`).join("") + "│");
		lines.push(mid);
		for (let i = 0; i < rows; i++) {
			lines.push(
				cols
					.map((c) => {
						const text = c.body[i] ?? "";
						return `│${text.padEnd(c.width).slice(0, c.width)}`;
					})
					.join("") + "│",
			);
		}
		lines.push(bottom);
	} else {
		for (const c of cols) {
			lines.push(`── ${c.label}(${c.cards.length}) ──`);
			lines.push(...(c.body.length > 0 ? c.body : ["(空)"]));
			lines.push("");
		}
	}
	return lines;
}

/** 单文件静态 HTML 看板(内嵌样式,浏览器直接打开) */
export function renderBoardHtml(board: Board): string {
	const colColor: Record<string, string> = {
		todo: "#64748b",
		running: "#3b82f6",
		verify: "#f59e0b",
		done: "#22c55e",
		abnormal: "#ef4444",
	};
	const cards = (c: BoardColumn): string =>
		c.cards.length === 0
			? `<div class="empty">(空)</div>`
			: c.cards
					.map(
						(
							card,
						) => `<div class="card" style="margin-left:${(card.depth - 1) * 14}px;border-left-color:${colColor[c.key]}">
  <div class="card-title">${esc(card.dotted)} ${esc(card.title)}${card.gate ? " <span class='tag'>gate</span>" : ""}</div>
  <div class="card-meta">${esc(card.agent)} · ${esc(card.status)}</div>
  ${card.summary ? `<div class="card-summary">${esc(card.summary)}</div>` : ""}
</div>`,
					)
					.join("\n");
	return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>wf ${esc(board.workflowId)} 看板</title>
<style>
  body { font-family: -apple-system, "PingFang SC", sans-serif; background:#0f172a; color:#e2e8f0; margin:0; padding:24px; }
  h1 { font-size:18px; margin:0 0 4px; }
  .sub { color:#94a3b8; font-size:13px; margin-bottom:20px; }
  .goal { background:#1e293b; border-radius:8px; padding:12px 16px; font-size:13px; color:#cbd5e1; margin-bottom:20px; }
  .board { display:flex; gap:12px; align-items:flex-start; overflow-x:auto; }
  .col { background:#1e293b; border-radius:10px; min-width:240px; max-width:300px; flex:1; padding:10px; }
  .col h2 { font-size:13px; margin:0 0 10px; }
  .col h2 .n { color:#94a3b8; font-weight:normal; }
  .card { background:#0f172a; border-left:3px solid #334155; border-radius:6px; padding:8px 10px; margin-bottom:8px; }
  .card-title { font-size:13px; font-weight:600; }
  .card-meta { font-size:11px; color:#94a3b8; margin-top:2px; }
  .card-summary { font-size:12px; color:#cbd5e1; margin-top:4px; }
  .tag { background:#7c3aed; color:#fff; font-size:10px; padding:1px 6px; border-radius:4px; }
  .empty { color:#475569; font-size:12px; padding:8px; }
</style>
</head>
<body>
  <h1>wf ${esc(board.workflowId)} 看板</h1>
  <div class="sub">${esc(board.title)} · ${esc(board.status)} · ${board.done}/${board.total} 完成${board.wave ? ` · wave ${board.wave}` : ""}</div>
  <div class="goal">🎯 ${esc(board.goal)}</div>
  <div class="board">
${board.columns
	.map(
		(c) => `    <div class="col">
      <h2 style="color:${colColor[c.key]}">${esc(c.label)} <span class="n">${c.cards.length}</span></h2>
${cards(c)}
    </div>`,
	)
	.join("\n")}
  </div>
</body>
</html>`;
}

function esc(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}
