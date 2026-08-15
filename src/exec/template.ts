/**
 * exec/template.ts — 任务模板渲染层(arch-refactor §3.6,自 src/dispatch.ts 同名迁移)
 *
 * - renderTaskMd:任务 markdown 渲染(目标 + 本步任务 + 期望 + 输出契约 + 约束,模板注入依赖结果);
 * - injectDeps:{{steps.<dotted>.summary|files|status}} / {{root}} 模板注入;
 * - getDepSummaries / parseExpectations / truncate:注入数据来源与截断;
 * - buildPointer:子 pi 短指引(纯 ASCII,任务详情走 /wf context 读库)。
 */
import type { DatabaseSync } from "node:sqlite";
import {
	type StepRow,
	type WorkflowRow,
	getLatestAttempt,
	getStep,
	getStepDeps,
	getStepMeta,
} from "../db.ts";
import { worktreeName } from "./shell.ts";

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
