/**
 * dispatch.ts — 子任务派发核心(设计文档 §5.3 / §6.1 / §7)
 *
 * 派发一个子任务:
 *   1. gittree create wf-<workflow>-<dotted>(冻结 base_sha,事件 worktree_created)
 *   2. 渲染 task_md(目标 + 本步任务 + 期望 + 输出契约 + worktree 约束,模板注入依赖结果)
 *      → 写入 workflow_steps.task_md;事件 step_dispatched
 *   3. 组装短指引 pointer → 写入 workflow_attempts.pointer
 *   4. ghostctl new-window --cwd <worktree> --command "env PI_WF_* pi" --input "<短指引>"
 *      (事件 step_tab_opened,记录 tab_id)
 *
 * 任务正文存库(--input 只注入短指引,杜绝长文本粘贴错乱)。
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
	EVT,
	type StepRow,
	type WorkflowRow,
	addEvent,
	buildUpdate,
	createAttempt,
	getLatestAttempt,
	getStep,
	getStepDeps,
	getStepMeta,
	getWorkflowMeta,
	setWorkflowMeta,
} from "./db.ts";

export interface DispatchResult {
	ok: boolean;
	stepId: string;
	worktree?: string;
	worktreePath?: string;
	attemptNo?: number;
	tabId?: string | null;
	pointer?: string;
	error?: string;
	dryRun?: boolean;
}

/** 依赖步骤的可注入结果(模板/看板共用) */
export interface DepSummary {
	dotted: string; // 点号 id,如 1.1
	summary: string | null;
	files: string[];
	status: string;
}

const MAX_INJECT = 8 * 1024; // 依赖注入截断(设计 §5.6)

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n…[截断 ${text.length - max} 字符]`;
}

export function worktreeName(workflowId: string, dotted: string): string {
	return `wf-${workflowId}-${dotted}`;
}

export function worktreePath(
	repoPath: string,
	workflowId: string,
	dotted: string,
): string {
	// gittree 约定:worktree 路径 <repo>/.worktrees/gittree-<name>
	return path.join(
		repoPath,
		".worktrees",
		`gittree-${worktreeName(workflowId, dotted)}`,
	);
}

/** 读取依赖步骤的摘要(供模板注入) */
export function getDepSummaries(db: DatabaseSync, step: StepRow): DepSummary[] {
	const out: DepSummary[] = [];
	for (const depId of getStepDeps(db, step.id)) {
		const dep = getStep(db, depId);
		if (!dep) continue;
		let files: string[] = [];
		if (dep.files_changed) {
			try {
				files = JSON.parse(dep.files_changed);
			} catch {
				files = [];
			}
		}
		out.push({
			dotted: depId.slice(dep.workflow_id.length + 1),
			summary: dep.summary,
			files,
			status: dep.status,
		});
	}
	return out;
}

/**
 * 模板注入:{{steps.<dotted>.summary|files|status}} / {{root}}
 * 引用未完成/不存在的依赖 → 占位提示(不静默注入空内容)。
 */
export function injectDeps(
	task: string,
	deps: DepSummary[],
	repoPath: string,
): string {
	let out = task;
	out = out.replace(/\{\{root\}\}/g, repoPath);
	out = out.replace(
		/\{\{steps\.([0-9.]+)\.(summary|files|status)\}\}/g,
		(_m, dotted: string, kind: string) => {
			const dep = deps.find((d) => d.dotted === dotted);
			if (!dep) return `(依赖 ${dotted} 不存在或未定义,请向编排者确认)`;
			if (kind === "summary")
				return dep.summary
					? truncate(dep.summary, MAX_INJECT)
					: "(该步骤无摘要)";
			if (kind === "files")
				return dep.files.length > 0 ? dep.files.join("\n") : "(无文件变更记录)";
			return dep.status;
		},
	);
	return out;
}

export function parseExpectations(raw: string | null): string[] {
	if (!raw) return [];
	try {
		const v = JSON.parse(raw);
		return Array.isArray(v)
			? v.filter((x): x is string => typeof x === "string")
			: [];
	} catch {
		return [];
	}
}

/** 渲染任务 markdown(设计 §6.1 模板) */
export function renderTaskMd(
	db: DatabaseSync,
	workflow: WorkflowRow,
	step: StepRow,
	waveSeq: number,
): string {
	// 原始任务文本:优先 step_metadata.task_raw(import 时写入),退化到 task_md
	const rawTask =
		(getStepMeta(db, step.id, "task_raw") as string | undefined) ??
		step.task_md;
	const renderedTask = injectDeps(
		rawTask,
		getDepSummaries(db, step),
		workflow.repo_path,
	);

	const expectations = parseExpectations(step.expectations);
	const expLines =
		expectations.length > 0
			? expectations.map((e) => `- ${e}`).join("\n")
			: "- (未设定,自主判断完成标准)";

	const dotted = step.id.slice(workflow.id.length + 1);
	const lines = [
		`# 任务 ${dotted}(workflow: ${workflow.id}, wave ${waveSeq})`,
		``,
		`## 需求目标`,
		workflow.goal.trim() || "(无)",
		``,
		`## 本步任务`,
		renderedTask.trim() || "(无任务描述,自行理解目标)",
		``,
		`## 期望/验收标准(执行前设定)`,
		expLines,
		``,
		`## 约束`,
		`- 你工作在 worktree ${step.worktree ?? worktreeName(workflow.id, dotted)} 内,只改动该目录下的文件`,
		`- 不要使用 git stash / 不要动 .worktrees/ 与主工作区`,
		`- 完成后在 worktree 内提交 git commit`,
		``,
		`## 输出契约`,
		`完成任务后,执行 /wf done ${dotted},参数为 JSON:`,
		`{"summary": "...", "filesChanged": [...], "issues": [...], "tests": "passed|failed|none"}`,
		`完成后可自行关闭本 tab。`,
	];

	// 重派上下文:needs-fix / failed / aborted 时注入上次失败原因与回报(设计 P3)
	if (["needs-fix", "failed", "aborted"].includes(step.status)) {
		const attempt = getLatestAttempt(db, step.id);
		const parts: string[] = [``, `## 上次尝试反馈(重派参考)`];
		if (attempt?.error) parts.push(`- 原因: ${attempt.error}`);
		else if (step.error) parts.push(`- 原因: ${step.error}`);
		if (attempt?.report) parts.push(`- 上次回报: ${attempt.report}`);
		else if (step.report) parts.push(`- 上次回报: ${step.report}`);
		if (parts.length > 2) lines.push(...parts);
	}

	return lines.join("\n");
}

/** 组装短指引(注入子 pi 首条消息,不传长任务正文) */
/**
 * 组装短指引(注入子 pi 首条消息,不传长任务正文)。
 * 纯 ASCII:中文经 AppleScript input text 注入会乱码(编码问题);
 * 任务详情(markdown,可含中文)存 DB,子 agent 经 /wf context 读取。
 */
export function buildPointer(
	workflowId: string,
	dotted: string,
	waveSeq: number,
): string {
	return [
		`[wf] task ready`,
		`workflow: ${workflowId} | step: ${dotted} | wave: ${waveSeq}`,
		`-> run /wf context to view task (markdown stored in DB)`,
		`-> when done: /wf done ${dotted} <JSON>`,
		`-> on failure: /wf fail ${dotted} <reason>`,
	].join("\n");
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
async function findTerminalId(
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

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

export function run(
	cmd: string,
	args: string[],
	cwd: string,
): Promise<RunResult> {
	return new Promise((resolve) => {
		// Ghostty 新窗口的非交互 shell 的 PATH 极简(无 brew),会命中系统旧版
		// python3(3.9,不支持 str | None 语法导致 ghostctl 报错)。补充常用目录。
		const env = {
			...process.env,
			PATH: [
				"/opt/homebrew/bin",
				"/usr/local/bin",
				process.env.PATH ?? "",
			].join(":"),
		};
		execFile(
			cmd,
			args,
			{ cwd, timeout: 120_000, env },
			(err, stdout, stderr) => {
				if (!err) {
					resolve({
						code: 0,
						stdout: String(stdout ?? ""),
						stderr: String(stderr ?? ""),
					});
					return;
				}
				const errCode = (err as NodeJS.ErrnoException).code;
				const code = typeof errCode === "number" ? errCode : 1;
				resolve({
					code,
					stdout: String(stdout ?? ""),
					stderr: String(stderr ?? ""),
				});
			},
		);
	});
}

/**
 * 子 pi 启动命令(绝对路径,子 tab 的非交互 shell PATH 不可靠):
 * - 运行在 pi 插件内(argv[1] 为 pi 入口,如 dist/cli.js):复用当前进程的 node + pi 脚本;
 * - 运行在 wf CLI 下(argv[1] 为 src/cli.ts):解析真实 pi 入口
 *   (env PI_BIN → PATH → ~/.local/bin),若为 js 脚本则 realpath 后交给显式 node 启动——
 *   pi 通常是指向 dist/cli.js 的符号链接,其 shebang 为 `#!/usr/bin/env node`,
 *   子 shell PATH 无 node 时会直接启动失败(tab 秒关)。
 */
export function piInvocation(): string {
	const script = process.argv[1];
	if (script && !script.startsWith("/$bunfs/") && fs.existsSync(script)) {
		const isWfCli =
			path.basename(script) === "cli.ts" &&
			script.includes(`${path.sep}extensions${path.sep}workflow${path.sep}`);
		if (!isWfCli) {
			return `"${process.execPath}" "${script}"`;
		}
	}
	const envBin = process.env.PI_BIN;
	if (envBin) {
		// 显式覆盖:信任调用方,不做存在性校验
		return `"${envBin}"`;
	}
	const found = resolveOnPath("pi") ?? path.join(os.homedir(), ".local", "bin", "pi");
	try {
		fs.accessSync(found, fs.constants.X_OK);
		const real = fs.realpathSync(found);
		return real.endsWith(".js")
			? `"${process.execPath}" "${real}"`
			: `"${real}"`;
	} catch {
		return "pi";
	}
}

/** 在 PATH 上找可执行文件(返回绝对路径;找不到返回 null) */
function resolveOnPath(name: string): string | null {
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!dir) continue;
		const candidate = path.join(dir, name);
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			return candidate;
		} catch {
			/* 尝试下一个 */
		}
	}
	return null;
}

/**
 * 解析 gittree/ghostctl 可执行文件:
 * 优先 PATH,兜底 ~/.local/bin(Ghostty 新窗口的非交互 shell 不含该路径)。
 */
export function resolveBin(name: "gittree" | "ghostctl"): string {
	const local = path.join(os.homedir(), ".local", "bin", name);
	for (const c of [name, local]) {
		try {
			fs.accessSync(c, fs.constants.X_OK);
			return c;
		} catch {
			/* 尝试下一个 */
		}
	}
	return name; // 让 execFile 报错更直观
}

/**
 * 派发中止公共路径:attempt → aborted,step → failed(可重派,避免卡在 dispatched),
 * 事件 step_aborted。绑定窗口不可用 / new-tab 失败共用。
 */
function abortDispatch(
	db: DatabaseSync,
	attemptId: number,
	step: StepRow,
	workflowId: string,
	reason: string,
	detail: string,
): void {
	const errText = `${reason}: ${detail}`;
	buildUpdate(
		db,
		"workflow_attempts",
		{ status: "aborted", error: errText },
		{ id: attemptId },
	);
	buildUpdate(
		db,
		"workflow_steps",
		{ status: "failed", error: errText, updated_at: Date.now() },
		{ id: step.id },
	);
	addEvent(db, {
		workflowId,
		stepId: step.id,
		attemptId,
		type: EVT.stepAborted,
		payload: { reason, detail },
	});
}

export interface DispatchOptions {
	dryRun?: boolean;
	/** fresh=true:先 gittree clean --branch --force 重建 worktree(设计 §7.1) */
	fresh?: boolean;
	/** 覆盖 gittree/ghostctl 可执行文件(测试用) */
	gittreeBin?: string;
	ghostctlBin?: string;
}

const DISPATCHABLE = new Set([
	"pending",
	"ready",
	"failed",
	"aborted",
	"needs-fix",
]);

/**
 * 派发单个步骤。
 * 前置:step 存在且状态允许派发(pending/ready/failed/aborted/needs-fix)。
 */
export async function dispatchStep(
	db: DatabaseSync,
	workflow: WorkflowRow,
	step: StepRow,
	opts: DispatchOptions = {},
): Promise<DispatchResult> {
	const dotted = step.id.slice(workflow.id.length + 1);
	const wtName = worktreeName(workflow.id, dotted);
	const wtPath = worktreePath(workflow.repo_path, workflow.id, dotted);
	const dryRun = Boolean(opts.dryRun);
	const waveSeq = workflow.current_wave || 1;

	if (!DISPATCHABLE.has(step.status)) {
		return {
			ok: false,
			stepId: step.id,
			error: `状态 ${step.status} 不允许派发(仅 ${[...DISPATCHABLE].join("/")})`,
		};
	}

	// 重试上限(设计 P3:超过 max_retries 拒绝,提示人工处理)
	const isRetry = ["failed", "aborted", "needs-fix"].includes(step.status);
	if (isRetry && step.retries_done >= step.max_retries) {
		return {
			ok: false,
			stepId: step.id,
			error: `已重试 ${step.retries_done}/${step.max_retries} 次,超过上限;请人工处理后 /wf skip 或调整计划`,
		};
	}

	// 依赖未完成拒绝派发(设计 §4.3 wave 顺序语义:先依赖,后并行,再后续)
	if (!depsDone(db, step)) {
		const pending = getStepDeps(db, step.id).filter((depId) => {
			const dep = getStep(db, depId);
			return !dep || !["done", "skipped"].includes(dep.status);
		});
		return {
			ok: false,
			stepId: step.id,
			error: `依赖未完成,先完成: ${pending.join(", ")}`,
		};
	}

	const pointer = buildPointer(workflow.id, dotted, waveSeq);

	if (dryRun) {
		return {
			ok: true,
			stepId: step.id,
			worktree: wtName,
			worktreePath: wtPath,
			pointer,
			dryRun: true,
		};
	}

	// 0. 冻结 base_sha(首次派发)
	await ensureBaseSha(db, workflow);

	// 0.5 fresh:先清理旧 worktree 重建(事件 worktree_cleaned,设计 §7.1)
	if (opts.fresh) {
		const cleanRes = await run(
			opts.gittreeBin ?? resolveBin("gittree"),
			["clean", wtName, "--branch", "--force"],
			workflow.repo_path,
		);
		if (cleanRes.code !== 0) {
			return {
				ok: false,
				stepId: step.id,
				error: `gittree clean 失败(可能仍被占用): ${cleanRes.stderr || cleanRes.stdout}`,
			};
		}
		addEvent(db, {
			workflowId: workflow.id,
			stepId: step.id,
			type: EVT.worktreeCleaned,
			payload: { worktree: wtName, fresh: true },
		});
	}

	// 1. worktree(事件 worktree_created)
	const createRes = await run(
		opts.gittreeBin ?? resolveBin("gittree"),
		["create", wtName],
		workflow.repo_path,
	);
	if (
		createRes.code !== 0 &&
		!/已存在|存在/.test(createRes.stdout + createRes.stderr)
	) {
		return {
			ok: false,
			stepId: step.id,
			error: `gittree create 失败: ${createRes.stderr || createRes.stdout}`,
		};
	}
	addEvent(db, {
		workflowId: workflow.id,
		stepId: step.id,
		type: EVT.worktreeCreated,
		payload: { worktree: wtName, path: wtPath },
	});

	// 2. 渲染 task_md 入库 + 状态 dispatched(事件 step_dispatched)
	const taskMd = renderTaskMd(db, workflow, step, waveSeq);
	buildUpdate(
		db,
		"workflow_steps",
		{
			task_md: taskMd,
			worktree: wtName,
			status: "dispatched",
			retries_done: isRetry ? step.retries_done + 1 : step.retries_done,
			updated_at: Date.now(),
		},
		{ id: step.id },
	);
	addEvent(db, {
		workflowId: workflow.id,
		stepId: step.id,
		type: EVT.stepDispatched,
		payload: {
			dotted,
			worktree: wtName,
			retry: isRetry ? step.retries_done + 1 : undefined,
		},
	});

	// 3. attempt 行(冻结 task_md + pointer)
	const attempt = createAttempt(db, step.id, { taskMd, pointer });

	// 4. ghostctl new-tab(事件 step_tab_opened,记录 tab_id)
	// 子任务开 tab,固定开进 workflow 绑定窗口(不受用户切焦点影响)
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
		opts.ghostctlBin ?? resolveBin("ghostctl"),
		workflow.repo_path,
		workflow.id,
	);
	if (!win.ok) {
		// 绑定窗口不可用(含已关闭)→ 中止派发,绝不无窗口参数裸开 tab
		abortDispatch(
			db,
			attempt.id,
			step,
			workflow.id,
			"绑定窗口不可用",
			win.error,
		);
		return { ok: false, stepId: step.id, worktree: wtName, error: win.error };
	}
	tabArgs.splice(1, 0, "--window-id", win.winId);
	const tabRes = await run(
		opts.ghostctlBin ?? resolveBin("ghostctl"),
		tabArgs,
		workflow.repo_path,
	);
	if (tabRes.code !== 0) {
		const detail = tabRes.stderr || tabRes.stdout;
		abortDispatch(db, attempt.id, step, workflow.id, "new-tab 失败", detail);
		return {
			ok: false,
			stepId: step.id,
			worktree: wtName,
			error: `ghostctl new-tab 失败: ${detail}`,
		};
	}

	// new-tab 输出稳定 tab id;反查 terminal id 存库(P2 监听用)
	const tabMatch = TAB_ID_RE.exec(tabRes.stdout);
	const tabIdFromOutput = tabMatch ? tabMatch[1] : null;
	const tabId = await findTerminalId(
		opts.ghostctlBin ?? resolveBin("ghostctl"),
		workflow.repo_path,
		tabIdFromOutput,
		wtPath,
	);

	// pointer 已注入子 pi 编辑器(--input 不带回车);等 pi 就绪后补回车提交为首条消息
	if (tabId) {
		await new Promise((r) => setTimeout(r, 4000));
		await run(
			opts.ghostctlBin ?? resolveBin("ghostctl"),
			["key", "enter", "--to", tabId],
			workflow.repo_path,
		);
	}

	buildUpdate(
		db,
		"workflow_attempts",
		{ tab_id: tabId, status: "running" },
		{ id: attempt.id },
	);
	buildUpdate(
		db,
		"workflow_steps",
		{ tab_id: tabId, status: "running", updated_at: Date.now() },
		{ id: step.id },
	);
	addEvent(db, {
		workflowId: workflow.id,
		stepId: step.id,
		attemptId: attempt.id,
		type: EVT.stepTabOpened,
		payload: { tabId, dotted },
	});

	return {
		ok: true,
		stepId: step.id,
		worktree: wtName,
		worktreePath: wtPath,
		attemptNo: attempt.attempt_no,
		tabId,
	};
}

/** 步骤的依赖是否全部终态(done/skipped)— P2 就绪集查询用 */
export function depsDone(db: DatabaseSync, step: StepRow): boolean {
	const depIds = getStepDeps(db, step.id);
	if (depIds.length === 0) return true;
	const stmt = db.prepare("SELECT status FROM workflow_steps WHERE id = ?");
	for (const depId of depIds) {
		const row = stmt.get(depId) as { status: string } | undefined;
		if (!row || !["done", "skipped"].includes(row.status)) return false;
	}
	return true;
}

/** 冻结 base_sha(首次派发时记录当前 HEAD) */
export async function ensureBaseSha(
	db: DatabaseSync,
	workflow: WorkflowRow,
): Promise<void> {
	if (workflow.base_sha) return;
	const res = await run("git", ["rev-parse", "HEAD"], workflow.repo_path);
	if (res.code === 0) {
		const sha = res.stdout.trim();
		if (/^[0-9a-f]{7,40}$/.test(sha)) {
			buildUpdate(
				db,
				"workflow",
				{ base_sha: sha, updated_at: Date.now() },
				{ id: workflow.id },
			);
		}
	}
}
