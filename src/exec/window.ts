/**
 * exec/window.ts — Ghostty 窗口/终端操作层(arch-refactor §3.5,自 src/exec/dispatch.ts 同名迁移)
 *
 * - sendTextToTerminal:注入文本并自动回车(与 /wf steer 同构的共享注入序列);
 * - openStepTab:开子任务 tab(构造 env 命令 + pointer 位置参数 → new-tab 到绑定窗口 →
 *   反查 terminal id → 写库);pointer 经 `pi '<msg>'` 位置参数交付,由 pi 自身在 UI
 *   就绪后自动发送,无需 --input 注入、盲等或补回车(设计 §0);
 * - resolveWorkflowWindow / parseLayout:workflow 绑定窗口解析(按 id 定位,绝不回退焦点窗口);
 * - findTerminalId:反查 terminal id(优先 tab id,兜底 cwd / 终端名)。
 */

import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
	addEvent,
	buildUpdate,
	EVT,
	getWorkflowMeta,
	type StepRow,
	setWorkflowMeta,
	type WorkflowRow,
} from "../core/db.ts";
import {
	piInvocation,
	type RunResult,
	resolveBin,
	run,
	worktreePath,
} from "./shell.ts";
import { buildPointer } from "./template.ts";

/**
 * 向终端注入文本并自动回车(与 /wf steer 同构的共享注入序列,设计 §0):
 *   1. ghostctl input <text> --to <terminalId>
 *   2. ghostctl key enter --to <terminalId>
 * 返回 input 步骤的结果(inject/steer 均以它判定成败;enter 失败由调用方自行判断)。
 */
export async function sendTextToTerminal(
	ghostctlBin: string,
	terminalId: string,
	text: string,
	cwd: string,
): Promise<RunResult> {
	const res = await run(ghostctlBin, ["input", text, "--to", terminalId], cwd);
	await run(ghostctlBin, ["key", "enter", "--to", terminalId], cwd);
	return res;
}

export interface OpenStepTabResult {
	ok: boolean;
	tabId?: string | null;
	/** 失败阶段:window = 绑定窗口不可用;tab = new-tab 失败 */
	phase?: "window" | "tab";
	error?: string;
}

export interface OpenStepTabOptions {
	ghostctlBin?: string;
	/** 已创建的 attempt id(dispatchStep 传入;成功后回写 tab_id/running) */
	attemptId?: number;
	/** 事件 payload 标 manual=true(open-tab 命令传,自动派发不传) */
	manual?: boolean;
}

/**
 * 开子任务 tab(dispatchStep §4 抽取的共享序列,dispatch 与 open-tab 共用):
 *   1. 构造 env 命令 + pointer 位置参数,new-tab 到 workflow 绑定窗口(锁定窗口 id,
 *      绝不裸开)。pointer 以 `pi '<pointer>'` 位置参数传给子 pi,pi 在 UI 就绪后
 *      自动发送为首条消息 —— 不再 --input 注入 + 盲等 + 补回车,零时序风险;
 *   2. 反查 terminal id(findTerminalId);
 *   3. 写库:step → running + tab_id;事件 step_tab_opened(manual 标记区分人工补开);
 *   4. 传入 attemptId 时成功后回写 attempt(tab_id/running)。
 * 失败返回 {ok:false, phase, error},步骤状态不动(是否中止由调用方决定)。
 */
export async function openStepTab(
	db: DatabaseSync,
	workflow: WorkflowRow,
	step: StepRow,
	opts: OpenStepTabOptions = {},
): Promise<OpenStepTabResult> {
	const dotted = step.id.slice(workflow.id.length + 1);
	const wtPath = worktreePath(workflow.repo_path, workflow.id, dotted);
	const ghostctlBin = opts.ghostctlBin ?? resolveBin("ghostctl");
	const pointer = buildPointer(workflow.id, dotted, workflow.current_wave || 1);

	const cmd = `env PI_WF_WORKFLOW=${workflow.id} PI_WF_STEP=${dotted} ${piInvocation()} ${shellQuote(pointer)}`;
	const tabArgs = [
		"new-tab",
		"--cwd",
		wtPath,
		"--command",
		cmd,
		// 顺序开 tab(先切到窗口末尾再创建,插在末尾,不乱插)
		"--at-end",
		// 后台创建,不抢焦点(恢复原终端焦点,不打扰当前开发)
		"--no-focus",
	];
	const win = await resolveWorkflowWindow(
		db,
		ghostctlBin,
		workflow.repo_path,
		workflow.id,
	);
	if (!win.ok) return { ok: false, phase: "window", error: win.error };
	tabArgs.splice(1, 0, "--window-id", win.winId);

	const tabRes = await run(ghostctlBin, tabArgs, workflow.repo_path);
	if (tabRes.code !== 0) {
		return {
			ok: false,
			phase: "tab",
			error: tabRes.stderr || tabRes.stdout,
		};
	}

	// new-tab 输出稳定 tab id;反查 terminal id 存库(P2 监听用)
	const tabMatch = TAB_ID_RE.exec(tabRes.stdout);
	const tabIdFromOutput = tabMatch ? tabMatch[1] : null;
	const tabId = await findTerminalId(
		ghostctlBin,
		workflow.repo_path,
		tabIdFromOutput,
		wtPath,
	);

	// 本次新建窗口(Ghostty new window 自带初始空白 tab)→ 清理非业务 tab
	if (win.created && tabId) {
		await sweepInitialTabs(ghostctlBin, workflow.repo_path, win.winId, tabId);
	}

	if (opts.attemptId !== undefined) {
		buildUpdate(
			db,
			"workflow_attempts",
			{ tab_id: tabId, status: "running" },
			{ id: opts.attemptId },
		);
	}
	buildUpdate(
		db,
		"workflow_steps",
		{
			tab_id: tabId,
			status: "running",
			// 派发即开始计时(面板时长/超时护栏均依赖 started_at)
			started_at: Date.now(),
			updated_at: Date.now(),
		},
		{ id: step.id },
	);
	addEvent(db, {
		workflowId: workflow.id,
		stepId: step.id,
		type: EVT.stepTabOpened,
		payload: { tabId, dotted, manual: opts.manual ? true : undefined },
	});
	return { ok: true, tabId };
}

/** new-tab 输出的 tab id(稳定,layout 中可定位) */
const TAB_ID_RE = /id=(tab-[0-9a-f]+)/;

/**
 * POSIX shell 单引号包裹(pointer 经 --command 进入 shell 解析):
 * 嵌入的 ' 转义为 '\''(关引号 + 转义引号 + 重开引号)。
 * pointer 为受控 ASCII 内容,此转义仅作防御。
 */
export function shellQuote(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}

/** workflow 绑定的 Ghostty 窗口 meta key */
export const WF_WINDOW_META_KEY = "ghostty_window_id";

interface WfWindowInfo {
	id: string;
	front: boolean;
}

function parseLayout(raw: string): WfWindowInfo[] | null {
	try {
		const l = JSON.parse(raw) as {
			windows: Array<{ id: string; front?: boolean }>;
		};
		return l.windows.map((w) => ({ id: w.id, front: Boolean(w.front) }));
	} catch {
		return null;
	}
}

/** new-window 输出的窗口 id(与 new-tab 同构,稳定) */
const WINDOW_ID_RE = /id=(tab-group-[0-9a-f]+)/;

/**
 * workflow 绑定窗口(设计:一次 workflow 一个专属窗口):
 * 首次派发 ghostctl new-window --no-focus 创建专属窗口(绝不借用用户的焦点窗口),
 * 创建所得窗口 id 存 workflow_metadata.ghostty_window_id;之后所有子任务 tab 固定
 * 开进该窗口 —— 按窗口 id 定位(ghostctl new-tab --window-id),不依赖窗口序号/焦点,
 * 窗口开合不会漂移;
 * 绑定窗口已关闭则返回错误,绝不静默回退(重建由 /wf rebind-window 或清 meta 重试)。
 * created=true 表示本次新建窗口(含 Ghostty 自带的初始空白 tab,调用方开完业务
 * tab 后应 sweepInitialTabs 清理,否则窗口会多一个空白 tab)。
 */
export async function resolveWorkflowWindow(
	db: DatabaseSync,
	ghostctlBin: string,
	cwd: string,
	workflowId: string,
): Promise<
	{ ok: true; winId: string; created?: boolean } | { ok: false; error: string }
> {
	const bound = getWorkflowMeta(db, workflowId, WF_WINDOW_META_KEY) as
		| string
		| undefined;
	if (bound) {
		// 已绑定 → 查 layout 验证窗口仍存在;已关闭 → 报错,绝不静默回退
		const res = await run(ghostctlBin, ["layout", "--json"], cwd);
		if (res.code !== 0) {
			return {
				ok: false,
				error: `ghostctl layout 失败: ${res.stderr || res.stdout}`,
			};
		}
		const windows = parseLayout(res.stdout);
		if (windows && windows.some((w) => w.id === bound)) {
			return { ok: true, winId: bound };
		}
		return {
			ok: false,
			error: `绑定窗口 ${bound} 已关闭,无法定位;请 /wf rebind-window 重新绑定当前焦点窗口,或清除 workflow_metadata.ghostty_window_id 后重试(绝不回退焦点窗口)`,
		};
	}

	// 未绑定 → 创建 workflow 专属窗口(后台创建,不抢焦点,不打扰当前开发)
	const res = await run(
		ghostctlBin,
		["new-window", "--cwd", cwd, "--no-focus"],
		cwd,
	);
	if (res.code !== 0) {
		return {
			ok: false,
			error: `ghostctl new-window 失败: ${res.stderr || res.stdout}`,
		};
	}
	const m = WINDOW_ID_RE.exec(res.stdout);
	if (!m) {
		return {
			ok: false,
			error: `new-window 输出无法解析窗口 id: ${res.stdout.slice(0, 200)}`,
		};
	}
	setWorkflowMeta(db, workflowId, WF_WINDOW_META_KEY, m[1]);
	return { ok: true, winId: m[1], created: true };
}

/**
 * 清理窗口内非业务 tab(Ghostty new window 自带一个初始空白 tab,会在专属窗口
 * 里多出一个空白 tab)。按 terminal id 判定保留 tab:keepTerminalId 为 null 时
 * 不清理(无法定位业务 tab,宁留不误关)。清理失败不影响主流程。
 */
export async function sweepInitialTabs(
	ghostctlBin: string,
	cwd: string,
	winId: string,
	keepTerminalId: string | null,
	opts: { retryDelaysMs?: number[] } = {},
): Promise<void> {
	if (!keepTerminalId) return;
	const res = await run(ghostctlBin, ["layout", "--json"], cwd);
	if (res.code !== 0) return;
	let tabs: Array<{ id: string; terminals: Array<{ id: string }> }> = [];
	try {
		const layout = JSON.parse(res.stdout) as {
			windows: Array<{
				id: string;
				tabs: Array<{ id: string; terminals: Array<{ id: string }> }>;
			}>;
		};
		const win = layout.windows.find((w) => w.id === winId);
		if (!win) return;
		tabs = win.tabs;
	} catch {
		/* 解析失败不影响主流程 */
		return;
	}
	// 刚创建的窗口/tab 在 AppleScript 侧引用会失败(-1728:不能获得 terminal id
	// of window N),close-tab 失败后按退避重试,总耗时 ≤ 重试间隔之和。
	const retryDelaysMs = opts.retryDelaysMs ?? [500, 1000, 2000];
	for (const t of tabs) {
		const termIds = t.terminals.map((x) => x.id);
		if (termIds.includes(keepTerminalId)) continue;
		for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
			if (attempt > 0) {
				await new Promise((r) => setTimeout(r, retryDelaysMs[attempt - 1]));
			}
			const closeRes = await run(ghostctlBin, ["close-tab", t.id], cwd);
			if (closeRes.code === 0) break;
		}
	}
}

/**
 * 反查 terminal id(ghostctl layout --json):
 * 优先按 new-tab 返回的 tab id;兜底按 cwd / 终端名(worktree 目录名)匹配。
 * 新开终端的 cwd 字段常为空(AppleScript 限制),故 name 匹配是主要兜底。
 */
export async function findTerminalId(
	ghostctlBin: string,
	cwd: string,
	tabId: string | null,
	wtPath: string,
): Promise<string | null> {
	const res = await run(ghostctlBin, ["layout", "--json"], cwd);
	if (res.code !== 0) return null;
	try {
		const layout = JSON.parse(res.stdout) as {
			windows: Array<{
				tabs: Array<{
					id: string;
					terminals: Array<{ id: string; cwd?: string; name?: string }>;
				}>;
			}>;
		};
		const wtBase = path.basename(wtPath);
		for (const w of layout.windows) {
			for (const t of w.tabs) {
				if (tabId && t.id === tabId && t.terminals.length > 0) {
					return t.terminals[0].id;
				}
				for (const term of t.terminals) {
					if (term.cwd && path.resolve(term.cwd) === path.resolve(wtPath)) {
						return term.id;
					}
					if (term.name && term.name.endsWith(wtBase)) {
						return term.id;
					}
				}
			}
		}
	} catch {
		return null;
	}
	return null;
}
