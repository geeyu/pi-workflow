/**
 * exec/window.ts — Ghostty 窗口/终端操作层(arch-refactor §3.5,自 src/dispatch.ts 同名迁移)
 *
 * - sendTextToTerminal:注入文本并自动回车(与 /wf steer 同构的共享注入序列);
 * - openStepTab:开子任务 tab(构造 env 命令 + pointer → new-tab 到绑定窗口 → 反查
 *   terminal id → 等就绪回车 → 写库);
 * - resolveWorkflowWindow / parseLayout:workflow 绑定窗口解析(按 id 定位,绝不回退焦点窗口);
 * - findTerminalId:反查 terminal id(优先 tab id,兜底 cwd / 终端名)。
 */
import type { DatabaseSync } from "node:sqlite";
import * as path from "node:path";
import {
	EVT,
	type StepRow,
	type WorkflowRow,
	addEvent,
	buildUpdate,
	getWorkflowMeta,
	setWorkflowMeta,
} from "../db.ts";
import {
	piInvocation,
	resolveBin,
	run,
	worktreePath,
	type RunResult,
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
	/** 新 tab 就绪后到回车提交 pointer 的等待毫秒数(测试可传 0) */
	enterDelayMs?: number;
	/** 事件 payload 标 manual=true(open-tab 命令传,自动派发不传) */
	manual?: boolean;
}

/**
 * 开子任务 tab(dispatchStep §4 抽取的共享序列,dispatch 与 open-tab 共用):
 *   1. 构造 env 命令 + pointer,new-tab 到 workflow 绑定窗口(锁定窗口 id,绝不裸开);
 *   2. 反查 terminal id(findTerminalId),等就绪后 key enter 提交 pointer;
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
	const pointer = buildPointer(
		workflow.id,
		dotted,
		workflow.current_wave || 1,
	);

	const cmd = `env PI_WF_WORKFLOW=${workflow.id} PI_WF_STEP=${dotted} ${piInvocation()}`;
	const tabArgs = [
		"new-tab",
		"--cwd",
		wtPath,
		"--command",
		cmd,
		"--input",
		pointer,
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

	// pointer 已注入子 pi 编辑器(--input 不带回车);等 pi 就绪后补回车提交为首条消息
	if (tabId) {
		await new Promise((r) => setTimeout(r, opts.enterDelayMs ?? 4000));
		await run(ghostctlBin, ["key", "enter", "--to", tabId], workflow.repo_path);
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

/**
 * workflow 绑定窗口(设计:一次 workflow 一个完整窗口流程):
 * 首次派发把当前焦点窗口记为绑定窗口(存 workflow_metadata.ghostty_window_id),
 * 之后所有子任务 tab 固定开进该窗口 —— 按窗口 id 定位(ghostctl new-tab --window-id),
 * 不依赖窗口序号/焦点,窗口开合不会漂移;
 * 绑定窗口已关闭则返回错误,绝不静默回退焦点窗口。
 */
async function resolveWorkflowWindow(
	db: DatabaseSync,
	ghostctlBin: string,
	cwd: string,
	workflowId: string,
): Promise<{ ok: true; winId: string } | { ok: false; error: string }> {
	const res = await run(ghostctlBin, ["layout", "--json"], cwd);
	if (res.code !== 0) {
		return {
			ok: false,
			error: `ghostctl layout 失败: ${res.stderr || res.stdout}`,
		};
	}
	const windows = parseLayout(res.stdout);
	if (!windows || windows.length === 0) {
		return { ok: false, error: "ghostctl layout 无窗口信息" };
	}

	const bound = getWorkflowMeta(db, workflowId, WF_WINDOW_META_KEY) as
		| string
		| undefined;
	if (bound) {
		// 已锁定 → 直接按 id 返回(不再查焦点);窗口已关闭 → 报错,绝不静默回退
		if (windows.some((w) => w.id === bound)) return { ok: true, winId: bound };
		return {
			ok: false,
			error: `绑定窗口 ${bound} 已关闭,无法定位;请 /wf rebind-window 重新绑定当前焦点窗口,或清除 workflow_metadata.ghostty_window_id 后重试(绝不回退焦点窗口)`,
		};
	}

	// 未绑定 → 锁定当前焦点窗口(首次派发语义)
	const target = windows.find((w) => w.front) ?? windows[0];
	setWorkflowMeta(db, workflowId, WF_WINDOW_META_KEY, target.id);
	return { ok: true, winId: target.id };
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
