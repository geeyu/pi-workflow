/**
 * dispatch.ts — 子任务派发核心(设计文档 §5.3 / §6.1 / §7)
 *
 * 派发一个子任务:
 *   1. gittree create wf-<workflow>-<dotted>(冻结 base_sha,事件 worktree_created)
 *   2. 渲染 task_md(目标 + 本步任务 + 期望 + 输出契约 + worktree 约束,模板注入依赖结果)
 *      → 写入 workflow_steps.task_md;事件 step_dispatched
 *   3. 组装短指引 pointer → 写入 workflow_attempts.pointer
 *   4. ghostctl new-tab --cwd <worktree> --command "env PI_WF_* pi" --input "<短指引>"
 *      (事件 step_tab_opened,记录 tab_id)
 *
 * 任务正文存库(--input 只注入短指引,杜绝长文本粘贴错乱)。
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
	EVT,
	type StepRow,
	type WorkflowRow,
	addEvent,
	buildUpdate,
	createAttempt,
	getStep,
	getStepDeps,
	getStepMeta,
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

	return [
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
	].join("\n");
}

/** 组装短指引(注入子 pi 首条消息,不传长任务正文) */
export function buildPointer(
	workflowId: string,
	dotted: string,
	waveSeq: number,
): string {
	return [
		`[wf] 任务已就绪`,
		`workflow: ${workflowId} | step: ${dotted} | wave: ${waveSeq}`,
		`→ 运行 /wf context 查看任务详情(markdown 已存数据库)`,
		`→ 完成后运行 /wf done ${dotted} <JSON> 回报`,
		`→ 失败运行 /wf fail ${dotted} <原因>`,
	].join("\n");
}

interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

function run(cmd: string, args: string[], cwd: string): Promise<RunResult> {
	return new Promise((resolve) => {
		execFile(cmd, args, { cwd, timeout: 120_000 }, (err, stdout, stderr) => {
			if (!err) {
				resolve({
					code: 0,
					stdout: String(stdout ?? ""),
					stderr: String(stderr ?? ""),
				});
				return;
			}
			const code =
				typeof (err as NodeJS.ErrnoException).code === "number"
					? ((err as NodeJS.ErrnoException).code as number)
					: 1;
			resolve({
				code,
				stdout: String(stdout ?? ""),
				stderr: String(stderr ?? ""),
			});
		});
	});
}

/** 与官方 subagent 示例一致:优先复用当前进程的 node + pi 脚本(绝对路径),退化到 PATH 上的 pi */
export function piInvocation(): string {
	const script = process.argv[1];
	if (script && !script.startsWith("/$bunfs/") && fs.existsSync(script)) {
		return `"${process.execPath}" "${script}"`;
	}
	return "pi";
}

const TAB_ID_RE = /id=([0-9A-Fa-f-]{8,})/;

export interface DispatchOptions {
	dryRun?: boolean;
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

	// 1. worktree(事件 worktree_created)
	const createRes = await run(
		opts.gittreeBin ?? "gittree",
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
			updated_at: Date.now(),
		},
		{ id: step.id },
	);
	addEvent(db, {
		workflowId: workflow.id,
		stepId: step.id,
		type: EVT.stepDispatched,
		payload: { dotted, worktree: wtName },
	});

	// 3. attempt 行(冻结 task_md + pointer)
	const attempt = createAttempt(db, step.id, { taskMd, pointer });

	// 4. ghostctl new-tab(事件 step_tab_opened,记录 tab_id)
	const cmd = `env PI_WF_WORKFLOW=${workflow.id} PI_WF_STEP=${dotted} ${piInvocation()}`;
	const tabRes = await run(
		opts.ghostctlBin ?? "ghostctl",
		["new-tab", "--cwd", wtPath, "--command", cmd, "--input", pointer],
		workflow.repo_path,
	);
	if (tabRes.code !== 0) {
		buildUpdate(
			db,
			"workflow_attempts",
			{
				status: "aborted",
				error: `new-tab 失败: ${tabRes.stderr || tabRes.stdout}`,
			},
			{ id: attempt.id },
		);
		return {
			ok: false,
			stepId: step.id,
			worktree: wtName,
			error: `ghostctl new-tab 失败: ${tabRes.stderr || tabRes.stdout}`,
		};
	}
	const tabMatch = TAB_ID_RE.exec(tabRes.stdout);
	const tabId = tabMatch ? tabMatch[1] : null;

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
