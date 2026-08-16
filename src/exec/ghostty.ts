/**
 * exec/ghostty.ts — 内部 Ghostty 窗口操作层(自给自足,不再依赖外部 ghostctl CLI)
 *
 * 只实现 workflow 真正用到的子集,专门为自己服务:
 *   - layoutJson:查询窗口/tab/终端布局(找当前窗口、反查 terminal id、tab 存活检测);
 *   - newWindow:新建 workflow 专属窗口(--no-focus 后台创建,绝不抢用户焦点);
 *   - newTab:在锁定窗口内开子任务 tab(--at-end 末尾顺序,--no-focus 不抢焦点);
 *   - closeTerminal / closeTab:清理终态 tab / 初始空白 tab;
 *   - inputText / sendKey:steer / inject 向指定终端注入文本与回车。
 *
 * 底层:macOS osascript 执行 Ghostty AppleScript 词典(系统自带,无第三方依赖)。
 * 实现细节沿用 ghostctl 的成熟序列(AppleScript 引用按窗口序号、新窗口/tab 的
 * id 解析、焦点捕获/恢复、窗口序号→id 映射防错位)。
 *
 * 注入口(测试/调试用,生产不设):
 *   - 子进程级:环境变量 WF_OSA_BIN 指定替代 osascript 的执行器(测试 fake);
 *   - 进程内:__setOsaRunnerForTest(runner) 注入(单测 fake)。
 */

import { run } from "./shell.ts";

// ────────────────────────────────────────────────────────────
// 布局模型(与 ghostctl layout --json 同构)
// ────────────────────────────────────────────────────────────

export interface GhosttyTerminal {
	id: string;
	name: string;
	cwd: string;
	focused: boolean;
}

export interface GhosttyTab {
	id: string;
	name: string;
	index: number;
	selected: boolean;
	focused_terminal: string;
	terminals: GhosttyTerminal[];
}

export interface GhosttyWindow {
	id: string;
	name: string;
	front: boolean;
	tabs: GhosttyTab[];
}

export interface GhosttyLayout {
	windows: GhosttyWindow[];
}

/** 遍历 layout 收集所有存活 terminal id(存活检测共用) */
export function collectTerminalIds(layout: GhosttyLayout): Set<string> {
	const ids = new Set<string>();
	for (const w of layout.windows) {
		for (const t of w.tabs) {
			for (const term of t.terminals) ids.add(term.id);
		}
	}
	return ids;
}

// ────────────────────────────────────────────────────────────
// 底层 osascript 执行
// ────────────────────────────────────────────────────────────

/** 窗口操作失败(含 osascript 失败/权限未授予/目标不存在等) */
export class GhosttyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GhosttyError";
	}
}

export interface OsaResult {
	code: number;
	stdout: string;
	stderr: string;
}

export type OsaRunner = (script: string) => Promise<OsaResult>;

let osaOverride: OsaRunner | null = null;

/**
 * 进程内注入(单测用):传入 fake runner 替换 osascript;传 null 恢复默认。
 * 子进程场景(CLI 测试)用 WF_OSA_BIN 环境变量,二者互不干扰。
 */
export function __setOsaRunnerForTest(runner: OsaRunner | null): void {
	osaOverride = runner;
}

const PERM_HINT =
	"错误: 自动化权限未授予。请在 系统设置 → 隐私与安全性 → 自动化 " +
	"中允许你的终端应用控制 Ghostty(或先手动用 系统设置 添加)。";

/**
 * 执行一段 AppleScript(作用于 Ghostty)。失败抛 GhosttyError:
 * 自动化权限类错误(-1743/-25211/not allowed)附加权限修复提示。
 */
async function osa(script: string): Promise<string> {
	let res: OsaResult;
	if (osaOverride) {
		res = await osaOverride(script);
	} else {
		// WF_OSA_BIN:测试/调试用 osascript 替代执行器(与 -e 参数同构)
		const bin = process.env.WF_OSA_BIN || "/usr/bin/osascript";
		res = await run(bin, ["-e", script], process.cwd());
	}
	if (res.code !== 0) {
		const err = (res.stderr || res.stdout).trim();
		const hint = /-1743|-25211|not allowed|不允许|not authorized/i.test(err)
			? `\n${PERM_HINT}`
			: "";
		throw new GhosttyError(`AppleScript 错误: ${err}${hint}`);
	}
	return res.stdout;
}

/** AppleScript 字符串字面量转义(反斜杠 + 双引号) */
function esc(s: string): string {
	return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// ────────────────────────────────────────────────────────────
// 布局查询
// ────────────────────────────────────────────────────────────

const LAYOUT_SCRIPT = String.raw`
tell application "Ghostty"
  set out to ""
  repeat with w in windows
    set frontmark to "false"
    try
      if (id of w) is (id of front window) then set frontmark to "true"
    end try
    set out to out & "W\t" & (id of w as text) & "\t" & (name of w as text) & "\t" & frontmark & "\n"
    repeat with t in tabs of w
      set sel to "false"
      if selected of t is true then set sel to "true"
      set fterm to ""
      try
        set fterm to (id of focused terminal of t) as text
      end try
      set out to out & "T\t" & (id of w as text) & "\t" & (id of t as text) & "\t" & (name of t as text) & "\t" & (index of t as text) & "\t" & sel & "\t" & fterm & "\n"
      repeat with term in terminals of t
        set out to out & "S\t" & (id of w as text) & "\t" & (id of t as text) & "\t" & (id of term as text) & "\t" & (name of term as text) & "\t" & (working directory of term as text) & "\n"
      end repeat
    end repeat
  end repeat
  return out
end tell
`;

/** 解析 layout TSV(W/T/S 行)→ GhosttyLayout */
export function parseLayoutTsv(out: string): GhosttyLayout {
	const windows: GhosttyWindow[] = [];
	const byId = new Map<string, GhosttyWindow>();
	for (const line of out.split("\n")) {
		if (!line) continue;
		const parts = line.split("\t");
		if (parts[0] === "W" && parts.length >= 4) {
			const w: GhosttyWindow = {
				id: parts[1],
				name: parts[2],
				front: parts[3] === "true",
				tabs: [],
			};
			windows.push(w);
			byId.set(w.id, w);
		} else if (parts[0] === "T" && parts.length >= 7) {
			const w = byId.get(parts[1]);
			if (!w) continue;
			w.tabs.push({
				id: parts[2],
				name: parts[3],
				index: Number(parts[4]),
				selected: parts[5] === "true",
				focused_terminal: parts[6],
				terminals: [],
			});
		} else if (parts[0] === "S" && parts.length >= 6) {
			const w = byId.get(parts[1]);
			if (!w) continue;
			const t = w.tabs.find((x) => x.id === parts[2]);
			if (!t) continue;
			t.terminals.push({
				id: parts[3],
				name: parts[4],
				cwd: parts[5],
				focused: parts[3] === t.focused_terminal,
			});
		}
	}
	return { windows };
}

/**
 * 查询完整布局(窗口 → tab → 终端树)。失败抛 GhosttyError
 * (调用方按"查询失败 ≠ 任何 tab 关闭"的口径自行 catch)。
 */
export async function layoutJson(): Promise<GhosttyLayout> {
	return parseLayoutTsv(await osa(LAYOUT_SCRIPT));
}

// ────────────────────────────────────────────────────────────
// 定位(按 id 前缀;与 ghostctl 同口径:不唯一/找不到都报清晰错误)
// ────────────────────────────────────────────────────────────

/** 按 id 前缀找终端,返回 (winId, terminal);找不到/不唯一 → GhosttyError */
function findTerminal(
	layout: GhosttyLayout,
	prefix: string,
): { winId: string; terminal: GhosttyTerminal } {
	const hits: Array<{ winId: string; terminal: GhosttyTerminal }> = [];
	for (const w of layout.windows) {
		for (const t of w.tabs) {
			for (const term of t.terminals) {
				if (term.id.startsWith(prefix)) hits.push({ winId: w.id, terminal: term });
			}
		}
	}
	if (hits.length === 0) {
		throw new GhosttyError(
			`找不到 terminal id 前缀为 ${JSON.stringify(prefix)} 的终端`,
		);
	}
	if (hits.length > 1) {
		throw new GhosttyError(
			`terminal id 前缀 ${JSON.stringify(prefix)} 不唯一: ${hits
				.map((h) => h.terminal.id)
				.join(", ")},请提供更长的前缀`,
		);
	}
	return hits[0];
}

/** 按 tab id 前缀定位 tab,返回 (winId, tab);找不到/不唯一 → GhosttyError */
function resolveTab(
	layout: GhosttyLayout,
	spec: string,
): { winId: string; tab: GhosttyTab } {
	if (/^\d+$/.test(spec)) {
		// 数字 = 索引(仅前置窗口/唯一窗口内)
		const n = Number(spec);
		const wins =
			layout.windows.filter((w) => w.front).length > 0
				? layout.windows.filter((w) => w.front)
				: layout.windows;
		for (const w of wins) {
			for (const t of w.tabs) {
				if (t.index === n) return { winId: w.id, tab: t };
			}
		}
		throw new GhosttyError(`前置窗口没有第 ${n} 个标签页`);
	}
	const hits: Array<{ winId: string; tab: GhosttyTab }> = [];
	for (const w of layout.windows) {
		for (const t of w.tabs) {
			if (t.id.startsWith(spec)) hits.push({ winId: w.id, tab: t });
		}
	}
	if (hits.length === 0) {
		throw new GhosttyError(
			`找不到 tab id 前缀为 ${JSON.stringify(spec)} 的标签页`,
		);
	}
	if (hits.length > 1) {
		throw new GhosttyError(`tab id 前缀 ${JSON.stringify(spec)} 不唯一`);
	}
	return hits[0];
}

/**
 * AppleScript 窗口序号 → 窗口 id 映射。
 * 注意:此序号与 layout 枚举顺序可能不一致(AppleScript windows 枚举顺序 ≠
 * window {N} 索引顺序,焦点变化后可能漂移)——所有按序号操作必须经此映射
 * 实时校验后按 id 执行,绝不能直接用 layout 数组下标,否则会关错窗口
 * (真实事故:两次误关用户窗口;-1728 引用失败)。
 */
async function windowIndexMap(): Promise<Map<number, string>> {
	const script = String.raw`
tell application "Ghostty"
set out to ""
set n to count of windows
repeat with i from 1 to n
set out to out & i as text & "\t" & (id of window i) & "\n"
end repeat
return out
end tell
`;
	const out = await osa(script);
	const mapping = new Map<number, string>();
	for (const line of out.split("\n")) {
		const parts = line.split("\t");
		if (parts.length === 2 && /^\d+$/.test(parts[0])) {
			mapping.set(Number(parts[0]), parts[1]);
		}
	}
	return mapping;
}

/**
 * 实时解析窗口 id → AppleScript 窗口序号(window {N} 引用一律经此映射,
 * 杜绝 layout 枚举顺序与索引顺序漂移导致的 -1728 错位)。
 */
async function winIndexFor(winId: string): Promise<number> {
	const mapping = await windowIndexMap();
	const hits = [...mapping.entries()].filter(([, id]) => id.startsWith(winId));
	if (hits.length === 0) {
		throw new GhosttyError(
			`找不到窗口 id 前缀为 ${JSON.stringify(winId)} 的窗口(当前共 ${mapping.size} 个)`, 
		);
	}
	if (hits.length > 1) {
		throw new GhosttyError(
			`窗口 id 前缀 ${JSON.stringify(winId)} 不唯一: ${hits
				.map(([, id]) => id)
				.join(", ")}`,
		);
	}
	return hits[0][0];
}

// ────────────────────────────────────────────────────────────
// 焦点捕获/恢复(--no-focus 创建后把输入焦点还给原终端,不打扰用户)
// ────────────────────────────────────────────────────────────

/** 当前全局输入焦点:前置窗口选中 tab 的聚焦终端 id(无则 null) */
function captureFocus(layout: GhosttyLayout): string | null {
	const wins =
		layout.windows.filter((w) => w.front).length > 0
			? layout.windows.filter((w) => w.front)
			: layout.windows;
	for (const w of wins) {
		for (const t of w.tabs) {
			if (t.selected && t.focused_terminal) return t.focused_terminal;
		}
	}
	return null;
}

/** 把输入焦点恢复到指定终端(窗口前置 + 终端聚焦);原终端已消失则静默放弃 */
async function restoreFocus(termId: string): Promise<void> {
	if (!termId) return;
	try {
		const layout = await layoutJson();
		const { winId, terminal } = findTerminal(layout, termId);
		const winIdx = await winIndexFor(winId);
		await osa(
			`tell application "Ghostty" to focus (terminal id "${terminal.id}" of window ${winIdx})`,
		);
	} catch {
		/* 原终端已消失,静默放弃 */
	}
}

// ────────────────────────────────────────────────────────────
// 创建:new-window / new-tab
// ────────────────────────────────────────────────────────────

export interface SurfaceOptions {
	/** 初始工作目录 */
	cwd?: string;
	/** 启动命令(替代 shell,如 env PI_WF_* pi '<pointer>') */
	command?: string;
}

/**
 * 构造 surface configuration 的 AppleScript 片段。
 * 注意:record-type 字段名是 "initial working directory"(sdef 显示名),
 * 且 record 不可变,必须用字面量构造,不能用 set 赋值。
 */
function surfaceConfigScript(opts: SurfaceOptions): string {
	if (!opts.cwd && !opts.command) return "";
	const fields = ["class:surface configuration"];
	if (opts.cwd) fields.push(`initial working directory:"${esc(opts.cwd)}"`);
	if (opts.command) fields.push(`command:"${esc(opts.command)}"`);
	return `set cfg to {${fields.join(", ")}}`;
}

const WINDOW_ID_RE = /id=(tab-group-[0-9a-f]+)/;
const TAB_ID_RE = /id=(tab-[0-9a-f]+)/;

/** 解析 new-window/new-tab 输出中的 id(真实 osascript 返回裸 id;兜底正则) */
function parseSurfaceId(stdout: string, re: RegExp, label: string): string {
	const m = re.exec(stdout);
	if (m) return m[1];
	// 兜底 1:输出中任意 id=(...) 形式(如测试 fake 的"已创建标签页 (id=tab-xyz)")
	const generic = /id=([a-z0-9-]+)/i.exec(stdout);
	if (generic) return generic[1];
	// 兜底 2:整段输出即为裸 id
	const raw = stdout.trim();
	if (/^[a-z0-9-]+$/i.test(raw)) return raw;
	throw new GhosttyError(`${label} 输出无法解析: ${stdout.slice(0, 200)}`);
}

/**
 * 新建窗口(--no-focus:创建后把输入焦点恢复到原终端,不打扰当前工作)。
 * 返回新窗口 id。
 */
export async function newWindow(
	opts: SurfaceOptions & { noFocus?: boolean } = {},
): Promise<{ windowId: string }> {
	const focusId = opts.noFocus ? captureFocus(await layoutJson()) : null;
	const cfg = surfaceConfigScript(opts);
	let script = `tell application "Ghostty"\n${cfg}\nset w to new window`;
	if (cfg) script += " with configuration cfg";
	script += "\nreturn id of w\nend tell";
	const out = await osa(script);
	const windowId = parseSurfaceId(out, WINDOW_ID_RE, "new-window");
	if (opts.noFocus && focusId) await restoreFocus(focusId);
	return { windowId };
}

export interface NewTabOptions extends SurfaceOptions {
	/** 目标窗口 id(按 id 定位,与窗口序号/焦点解耦) */
	windowId: string;
	/** 先切到窗口末尾再创建,新 tab 总插在末尾(顺序创建) */
	atEnd?: boolean;
	/** 创建后把输入焦点恢复到原终端 */
	noFocus?: boolean;
}

/**
 * 在指定窗口内新建标签页,返回新 tab id。
 * 窗口序号经 windowIndexMap 实时映射;last_tab 的目标 terminal 在同一个
 * AppleScript 脚本内从 window {N} 取——序号与引用同源,杜绝 layout 枚举
 * 顺序与索引顺序漂移导致的 -1728 错位。
 */
export async function newTab(opts: NewTabOptions): Promise<{ tabId: string }> {
	const layout = await layoutJson();
	const focusId = opts.noFocus ? captureFocus(layout) : null;
	if (layout.windows.length === 0) {
		throw new GhosttyError("Ghostty 当前没有任何窗口");
	}
	let widx: number;
	try {
		widx = await winIndexFor(opts.windowId);
	} catch (e) {
		const diag = e instanceof GhosttyError ? e.message : String(e);
		throw new GhosttyError(
			`${diag}\n[诊断] 目标窗口=${opts.windowId} layout 枚举=${layout.windows
				.map((w) => `${w.id.slice(-6)}(${w.front ? "front" : ""})`)
				.join(", ")}`,
		);
	}

	const cfg = surfaceConfigScript(opts);
	const parts: string[] = [];
	if (cfg) parts.push(cfg);
	if (opts.atEnd) {
		// AppleScript new tab 无插入位置参数,新 tab 总插在"当前选中 tab"之后;
		// 先切到窗口最后一个 tab,新 tab 才总插到窗口末尾(顺序创建)。
		// 目标 terminal 必须在同一脚本内从 window {widx} 取(序号与引用同源,
		// 不依赖 layout 快照的枚举位置——焦点变化后二者会漂移,曾 -1728 错位)。
		parts.push(
			`set tgt to missing value\n` +
				`repeat with t in tabs of window ${widx}\n` +
				`  if (count of terminals of t) > 0 then\n` +
				`    set tgt to first terminal of t\n` +
				`    exit repeat\n` +
				`  end if\n` +
				`end repeat\n` +
				`if tgt is missing value then error "窗口 ${widx} 没有终端面"\n` +
				`perform action "last_tab" on (tgt)`,
		);
	}
	parts.push(
		`set t to new tab in window ${widx}${cfg ? " with configuration cfg" : ""}`,
	);
	parts.push("return id of t");
	const out = await osa(
		`tell application "Ghostty"\n${parts.join("\n")}\nend tell`,
	);
	const tabId = parseSurfaceId(out, TAB_ID_RE, "new-tab");
	if (opts.noFocus && focusId) await restoreFocus(focusId);
	return { tabId };
}

// ────────────────────────────────────────────────────────────
// 关闭:close-terminal / close-tab
// ────────────────────────────────────────────────────────────

/** 关闭指定终端面(按 id 前缀定位) */
export async function closeTerminal(terminalId: string): Promise<void> {
	const layout = await layoutJson();
	const { winId, terminal } = findTerminal(layout, terminalId);
	const winIdx = await winIndexFor(winId);
	await osa(
		`tell application "Ghostty" to close (terminal id "${terminal.id}" of window ${winIdx})`,
	);
}

/** 关闭标签页(按 id 前缀定位:先切到该 tab 再执行 close_tab) */
export async function closeTab(tabId: string): Promise<void> {
	const layout = await layoutJson();
	const { winId, tab } = resolveTab(layout, tabId);
	if (tab.terminals.length === 0) {
		throw new GhosttyError(`标签页 ${tab.id} 没有终端面`);
	}
	const winIdx = await winIndexFor(winId);
	const ref = `terminal id "${tab.terminals[0].id}" of window ${winIdx}`;
	await osa(
		`tell application "Ghostty"\n` +
			`perform action "goto_tab:${tab.index}" on (${ref})\n` +
			`perform action "close_tab" on (${ref})\n` +
			`end tell`,
	);
}

// ────────────────────────────────────────────────────────────
// 注入:input / key(steer、inject 用)
// ────────────────────────────────────────────────────────────

/** 向指定终端输入文本(如同粘贴;文本受控为 ASCII,中文经 AppleScript 会乱码) */
export async function inputText(
	terminalId: string,
	text: string,
): Promise<void> {
	const layout = await layoutJson();
	const { winId, terminal } = findTerminal(layout, terminalId);
	const winIdx = await winIndexFor(winId);
	await osa(
		`tell application "Ghostty" to input text "${esc(text)}" to (terminal id "${terminal.id}" of window ${winIdx})`,
	);
}

/** 向指定终端发送按键(如 enter) */
export async function sendKey(terminalId: string, key: string): Promise<void> {
	const layout = await layoutJson();
	const { winId, terminal } = findTerminal(layout, terminalId);
	const winIdx = await winIndexFor(winId);
	await osa(
		`tell application "Ghostty" to send key "${esc(key)}" to (terminal id "${terminal.id}" of window ${winIdx})`,
	);
}
