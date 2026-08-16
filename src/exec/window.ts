/**
 * exec/window.ts — workflow 窗口编排层(自 src/exec/dispatch.ts 同名迁移,
 * 底层窗口操作已内化为 exec/ghostty.ts,不再依赖外部 ghostctl CLI)
 *
 * - sendTextToTerminal:注入文本并自动回车(与 /wf steer 同构的共享注入序列);
 * - openStepTab:开子任务 tab(构造 env 命令 + pointer 位置参数 → new-tab 到绑定窗口 →
 *   反查 terminal id → 写库);pointer 经 `pi '<msg>'` 位置参数交付,由 pi 自身在 UI
 *   就绪后自动发送,无需 --input 注入、盲等或补回车(设计 §0);
 * - resolveWorkflowWindow / resolveMasterWindow:workflow 绑定窗口解析(按 id 定位,绝不回退焦点窗口);
 * - findTerminalId:反查 terminal id(优先 tab id,兜底 cwd / 终端名)。
 */

import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
	addEvent,
	buildUpdate,
	EVT,
	getWorkflowMeta,
	MASTER_MODE_KEY,
	MASTER_MODE_VALUE,
	MASTER_TAB_KEY,
	type StepRow,
	setWorkflowMeta,
	type WorkflowRow,
} from "../core/db.ts";
import {
	closeTab,
	collectTerminalIds,
	GhosttyError,
	inputText,
	layoutJson,
	newTab,
	newWindow,
	sendKey,
	type GhosttyLayout,
} from "./ghostty.ts";
import { getRestoreAppFocus, getSilentWindows } from "../config.ts";
import { piInvocation, worktreePath } from "./shell.ts";
import { buildPointer } from "./template.ts";

/** 错误对象 → 可读消息 */
function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/**
 * 向终端注入文本并自动回车(与 /wf steer 同构的共享注入序列,设计 §0):
 *   input text → send key enter。
 * 返回 {ok, error}:input 步骤判定成败;enter 失败由调用方自行判断。
 */
export async function sendTextToTerminal(
	terminalId: string,
	text: string,
): Promise<{ ok: boolean; error?: string }> {
	let ok = true;
	let error: string | undefined;
	try {
		await inputText(terminalId, text);
	} catch (e) {
		ok = false;
		error = errMsg(e);
	}
	try {
		await sendKey(terminalId, "enter");
	} catch {
		/* enter 失败不阻断(与 ghostctl 时代同口径) */
	}
	return { ok, error };
}

export interface OpenStepTabResult {
	ok: boolean;
	tabId?: string | null;
	/** 失败阶段:window = 绑定窗口不可用;tab = new-tab 失败 */
	phase?: "window" | "tab";
	error?: string;
}

export interface OpenStepTabOptions {
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
	const pointer = buildPointer(workflow.id, dotted, workflow.current_wave || 1);

	const cmd = `env PI_WF_WORKFLOW=${workflow.id} PI_WF_STEP=${dotted} ${piInvocation()} ${shellQuote(pointer)}`;
	// master-agent 模式:子任务 tab 直接开在主控所在窗口(主控只需在自己窗口
	// 创建 tab,无需专属窗口绑定);经典模式:workflow 专属窗口(首次 new-window 绑定)。
	const isMaster =
		getWorkflowMeta(db, workflow.id, MASTER_MODE_KEY) === MASTER_MODE_VALUE;
	const win = isMaster
		? await resolveMasterWindow(db, workflow.id)
		: await resolveWorkflowWindow(db, workflow.repo_path, workflow.id);
	if (!win.ok) return { ok: false, phase: "window", error: win.error };

	let tabIdFromOutput: string;
	try {
		// 顺序开 tab(--at-end 插在窗口末尾)+ 静默创建(不抢焦点,配置可关)
		const res = await newTab({
			windowId: win.winId,
			cwd: wtPath,
			command: cmd,
			atEnd: true,
			noFocus: getSilentWindows(),
			restoreApp: getRestoreAppFocus(),
		});
		tabIdFromOutput = res.tabId;
	} catch (e) {
		return {
			ok: false,
			phase: "tab",
			error: `new-tab 失败: ${errMsg(e)}`,
		};
	}

	// new-tab 输出稳定 tab id;反查 terminal id 存库(P2 监听用)
	const tabId = await findTerminalId(tabIdFromOutput, wtPath);

	// 本次新建窗口(经典模式首次派发,Ghostty new window 自带初始空白 tab)
	// → 清理非业务 tab;master 模式无 created 标记(主控 tab 一步创建,无空白 tab)。
	if (win.ok && "created" in win && win.created && tabId) {
		await sweepInitialTabs(win.winId, tabId);
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

/**
 * master-agent 模式:反查主控 tab 所在窗口(主控在自己所在窗口创建子任务 tab)。
 * 按 master_tab_id(主控 terminal id)在 layout 中定位;找不到 → 报错(主控
 * 会话可能已关闭,绝不在其他窗口裸开)。
 */
export async function resolveMasterWindow(
	db: DatabaseSync,
	workflowId: string,
): Promise<{ ok: true; winId: string } | { ok: false; error: string }> {
	const masterTab = getWorkflowMeta(db, workflowId, MASTER_TAB_KEY) as
		| string
		| undefined;
	if (!masterTab) {
		return {
			ok: false,
			error: `workflow ${workflowId} 未记录主控 tab(master_tab_id),无法定位窗口`,
		};
	}
	let layout: GhosttyLayout;
	try {
		layout = await layoutJson();
	} catch (e) {
		return { ok: false, error: `Ghostty layout 查询失败: ${errMsg(e)}` };
	}
	for (const w of layout.windows) {
		for (const t of w.tabs) {
			if (t.terminals.some((x) => x.id === masterTab)) {
				return { ok: true, winId: w.id };
			}
		}
	}
	return {
		ok: false,
		error: `主控 tab(${masterTab.slice(0, 8)}…) 不在 Ghostty 布局中,无法定位窗口;主控会话可能已关闭`,
	};
}

/**
 * workflow 绑定窗口(设计:一次 workflow 一个专属窗口):
 * 首次派发 new-window --no-focus 创建专属窗口(绝不借用用户的焦点窗口),
 * 创建所得窗口 id 存 workflow_metadata.ghostty_window_id;之后所有子任务 tab 固定
 * 开进该窗口 —— 按窗口 id 定位(new-tab --window-id),不依赖窗口序号/焦点,
 * 窗口开合不会漂移;
 * 绑定窗口已关闭则返回错误,绝不静默回退(重建由 /wf rebind-window 或清 meta 重试)。
 * created=true 表示本次新建窗口(含 Ghostty 自带的初始空白 tab,调用方开完业务
 * tab 后应 sweepInitialTabs 清理,否则窗口会多一个空白 tab)。
 */
export async function resolveWorkflowWindow(
	db: DatabaseSync,
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
		let layout: GhosttyLayout;
		try {
			layout = await layoutJson();
		} catch (e) {
			return {
				ok: false,
				error: `Ghostty layout 查询失败: ${errMsg(e)}`,
			};
		}
		if (layout.windows.some((w) => w.id === bound)) {
			return { ok: true, winId: bound };
		}
		return {
			ok: false,
			error: `绑定窗口 ${bound} 已关闭,无法定位;请 /wf rebind-window 重新绑定当前焦点窗口,或清除 workflow_metadata.ghostty_window_id 后重试(绝不回退焦点窗口)`,
		};
	}

	// 未绑定 → 创建 workflow 专属窗口(静默创建,不抢焦点,配置可关)
	try {
		const { windowId } = await newWindow({
			cwd,
			noFocus: getSilentWindows(),
			restoreApp: getRestoreAppFocus(),
		});
		setWorkflowMeta(db, workflowId, WF_WINDOW_META_KEY, windowId);
		return { ok: true, winId: windowId, created: true };
	} catch (e) {
		return {
			ok: false,
			error: `创建专属窗口失败: ${errMsg(e)}`,
		};
	}
}

/**
 * 清理窗口内非业务 tab(Ghostty new window 自带一个初始空白 tab,会在专属窗口
 * 里多出一个空白 tab)。按 terminal id 判定保留 tab:keepTerminalId 为 null 时
 * 不清理(无法定位业务 tab,宁留不误关)。清理失败不影响主流程。
 */
export async function sweepInitialTabs(
	winId: string,
	keepTerminalId: string | null,
	opts: { retryDelaysMs?: number[] } = {},
): Promise<void> {
	if (!keepTerminalId) return;
	let layout: GhosttyLayout;
	try {
		layout = await layoutJson();
	} catch {
		return;
	}
	const win = layout.windows.find((w) => w.id === winId);
	if (!win) return;
	// 刚创建的窗口/tab 在 AppleScript 侧引用会失败(-1728:不能获得 terminal id
	// of window N),close-tab 失败后按退避重试,总耗时 ≤ 重试间隔之和。
	const retryDelaysMs = opts.retryDelaysMs ?? [500, 1000, 2000];
	for (const t of win.tabs) {
		const termIds = t.terminals.map((x) => x.id);
		if (termIds.includes(keepTerminalId)) continue;
		for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
			if (attempt > 0) {
				await new Promise((r) => setTimeout(r, retryDelaysMs[attempt - 1]));
			}
			try {
				await closeTab(t.id);
				break;
			} catch {
				/* 退避重试 */
			}
		}
	}
}

/**
 * 反查 terminal id(layout 查询):
 * 优先按 new-tab 返回的 tab id;兜底按 cwd / 终端名(worktree 目录名)匹配。
 * 新开终端的 cwd 字段常为空(AppleScript 限制),故 name 匹配是主要兜底。
 */
export async function findTerminalId(
	tabId: string | null,
	wtPath: string,
): Promise<string | null> {
	let layout: GhosttyLayout;
	try {
		layout = await layoutJson();
	} catch {
		return null;
	}
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
	return null;
}

export { collectTerminalIds, GhosttyError };
