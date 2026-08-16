/**
 * config.ts — pi-workflow 配置文件读取(参考 rpiv-todo config.ts)
 *
 * 配置文件:~/.config/pi-workflow/config.json(XDG_CONFIG_HOME 优先)
 * - maxWidgetLines:计划概览面板内容行预算(含标题行),默认 10,floor 3
 * - collapseKey:面板折叠/展开快捷键(pi 键位语法,如 ctrl+shift+t),默认
 *   ctrl+shift+t;"off" 禁用(不注册快捷键)
 * - silentWindows:静默开窗总开关(创建后恢复窗口级 + app 级焦点),默认 true
 * - restoreAppFocus:app 级焦点还原(需 System Events 权限;关掉则只还原
 *   窗口级焦点,避免首次授权弹窗),默认 true
 * - masterPathExtra:主控 tab 的 PATH 追加目录(默认已含 brew/~/.local/bin/
 *   wf skill bin),如 ["/opt/homebrew/bin/nvm-versions"]
 * - monitorIntervalMs:存活轮询间隔 ms,默认 5000
 * - plannerTimeoutMs:planner 自动拆解超时 ms,默认 10 分钟
 * - defaultTimeoutMin:步骤默认超时(分钟),默认 60
 *
 * 每次调用现读(per-render / per-registration,无需 /reload):
 * - getMaxWidgetLines:面板渲染时调用,改配置立即生效
 * - resolveCollapseKey:快捷键注册一次,改配置需 /reload 重绑(与 rpiv 一致:
 *   折叠面板的提示行按每次渲染现读,因此提示与真实绑定可能短暂不一致)
 *
 * 本文件只读配置,绝不写文件。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface WfConfig {
	/** 面板内容行预算(含标题行);非数字或 <3 回退默认 */
	maxWidgetLines?: number;
	/** 折叠快捷键键位(pi KeyId 语法);"off" 禁用 */
	collapseKey?: string;
	/** 静默开窗总开关(创建后恢复窗口级 + app 级焦点),默认 true */
	silentWindows?: boolean;
	/** app 级焦点还原(需 System Events 权限;false 只还原窗口级),默认 true */
	restoreAppFocus?: boolean;
	/** 主控 tab 的 PATH 追加目录(默认已含 brew/~/.local/bin/wf skill bin) */
	masterPathExtra?: string[];
	/** 存活轮询间隔 ms,默认 5000 */
	monitorIntervalMs?: number;
	/** planner 自动拆解超时 ms,默认 10 分钟 */
	plannerTimeoutMs?: number;
	/** 步骤默认超时(分钟),默认 60 */
	defaultTimeoutMin?: number;
}

/** 默认内容行预算(含标题行,原硬编码 10 保留为默认值) */
export const DEFAULT_MAX_WIDGET_LINES = 10;

/** 默认折叠/展开快捷键 */
export const DEFAULT_COLLAPSE_KEY = "ctrl+shift+t";

/** collapseKey 禁用哨兵 */
export const COLLAPSE_KEY_OFF = "off";

/** 配置文件目录名(与包名一致) */
export const CONFIG_DIR_NAME = "pi-workflow";

/**
 * 解析配置文件路径:XDG_CONFIG_HOME 为绝对路径时用
 * $XDG_CONFIG_HOME/pi-workflow/config.json,否则 ~/.config/pi-workflow/config.json。
 * 不存在的目录/文件返回 null。
 */
export function configPath(): string | null {
	const xdg = process.env.XDG_CONFIG_HOME;
	if (xdg && path.isAbsolute(xdg)) {
		return path.join(xdg, CONFIG_DIR_NAME, "config.json");
	}
	return path.join(os.homedir(), ".config", CONFIG_DIR_NAME, "config.json");
}

/** 读配置(每次现读);文件缺失/JSON 非法/非对象 → 空配置(静默,同 rpiv) */
export function loadConfig(): WfConfig {
	try {
		const p = configPath();
		if (!p || !fs.existsSync(p)) return {};
		const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
		return raw as WfConfig;
	} catch {
		return {};
	}
}

/** 默认存活轮询间隔 ms */
export const DEFAULT_MONITOR_INTERVAL_MS = 5000;

/** 默认 planner 拆解超时 ms(10 分钟) */
export const DEFAULT_PLANNER_TIMEOUT_MS = 10 * 60_000;

/** 默认步骤超时(分钟) */
export const DEFAULT_STEP_TIMEOUT_MIN = 60;

/** 静默开窗开关:创建后恢复窗口级 + app 级焦点(默认开) */
export function getSilentWindows(): boolean {
	const v = loadConfig().silentWindows;
	return typeof v === "boolean" ? v : true;
}

/** app 级焦点还原(需 System Events 权限;默认开) */
export function getRestoreAppFocus(): boolean {
	const v = loadConfig().restoreAppFocus;
	return typeof v === "boolean" ? v : true;
}

/** 主控 tab PATH 追加目录(字符串数组,默认空) */
export function getMasterPathExtra(): string[] {
	const v = loadConfig().masterPathExtra;
	return Array.isArray(v) && v.every((x) => typeof x === "string" && x.length > 0)
		? v
		: [];
}

/** 存活轮询间隔 ms(非正数回退默认) */
export function getMonitorIntervalMs(): number {
	const v = loadConfig().monitorIntervalMs;
	return typeof v === "number" && v > 0 ? v : DEFAULT_MONITOR_INTERVAL_MS;
}

/** planner 拆解超时 ms(非正数回退默认) */
export function getPlannerTimeoutMs(): number {
	const v = loadConfig().plannerTimeoutMs;
	return typeof v === "number" && v > 0 ? v : DEFAULT_PLANNER_TIMEOUT_MS;
}

/** 步骤默认超时分钟(非正数回退默认) */
export function getDefaultTimeoutMin(): number {
	const v = loadConfig().defaultTimeoutMin;
	return typeof v === "number" && v > 0 ? v : DEFAULT_STEP_TIMEOUT_MIN;
}

/**
 * 面板内容行预算(含标题行)。非数字或 <3 → 默认;无上限。
 * 每次渲染现读,改配置下一帧生效(无需 /reload)。
 */
export function getMaxWidgetLines(): number {
	const lines = loadConfig().maxWidgetLines;
	if (typeof lines !== "number" || lines < 3) return DEFAULT_MAX_WIDGET_LINES;
	return lines;
}

// pi-tui KeyId 语法校验(移植 rpiv-todo config.ts 的校验器):
// 零个或多个互异修饰键 + 单个可打印字符或命名特殊键。
// 必须严格校验:pi-tui 取最后一个 + 段为键、忽略未知段,宽松校验会让
// 形如 ctr+] 的笔误静默捕获所有裸 ] 按键。
const SPECIAL_KEYS = new Set([
	"escape",
	"esc",
	"enter",
	"return",
	"tab",
	"space",
	"backspace",
	"delete",
	"insert",
	"clear",
	"home",
	"end",
	"pageup",
	"pagedown",
	"up",
	"down",
	"left",
	"right",
	...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
]);

const MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);

/** 校验 collapseKey 键位语法(导出供单元测试) */
export function isValidCollapseKeySpec(spec: string): boolean {
	if (!spec) return false;
	if (spec.startsWith("+") || spec.endsWith("+") || spec.includes("++")) return false;
	const parts = spec.split("+");
	const base = parts.at(-1) ?? "";
	const modifiers = parts.slice(0, -1);
	if (modifiers.length !== new Set(modifiers).size) return false;
	if (!modifiers.every((m) => MODIFIERS.has(m))) return false;
	return base.length === 1 ? /[a-z0-9_\-!@#$%^&*()|~`'":;,./<>?[\]{}=\\]/.test(base) : SPECIAL_KEYS.has(base);
}

/**
 * 解析折叠快捷键:缺失/空串/非字符串/非法语法 → 默认;哨兵 "off" → 禁用;
 * 否则小写化返回合法键位。每次调用现读。
 */
export function resolveCollapseKey(): string {
	const config = loadConfig();
	const raw = typeof config.collapseKey === "string" ? config.collapseKey.trim().toLowerCase() : undefined;
	if (raw === undefined || raw === "") return DEFAULT_COLLAPSE_KEY;
	if (raw === COLLAPSE_KEY_OFF) return COLLAPSE_KEY_OFF;
	return isValidCollapseKeySpec(raw) ? raw : DEFAULT_COLLAPSE_KEY;
}
