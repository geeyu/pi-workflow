/**
 * planner.ts — 智能编排:P4 自动拆解(设计 §5.2 / §11 P4)
 *
 * 一条需求目标 → headless 调 planner agent(pi --mode json 子进程,复用官方
 * subagent 模式)→ JSON 契约输出 → 校验 → 落库。
 *
 * 输出契约:
 *   {"name": "<kebab-case>", "title": "...", "goal": "...",
 *    "steps": [{"id": "1", "title": "...", "agent": "worker", "task": "...",
 *               "deps": [...], "expectations": [...], "gate": false}]}
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverAgents } from "./agents.ts";

export const PLANNER_TASK_TEMPLATE = `你的任务:把下面的需求目标拆解成可执行的 workflow 计划。

需求目标:
<REQUEST>

约束:
- 任务拆分遵循层级点号 id(1、1.1、1.2.3),并行/串行由依赖关系(deps)决定;
- 每个步骤给出:title / agent(worker|reviewer|planner)/ task(明确任务描述,
  可含 {{steps.<id>.summary}} 模板引用依赖步骤结果)/ deps / expectations(期望验收标准)
  / gate(是否需要人工核对);
- 仓库上下文自行查看当前目录代码,不要臆测不存在的文件;
- 拆解粒度:每个步骤是子 agent 能在独立 worktree 中完成的一个功能点,尽量并行化。

最终回答只输出一个 JSON 对象,不要输出围栏以外的多余文字:
{"name":"<kebab-case workflow id>","title":"...","goal":"<需求目标>","steps":[{...}]}`;

export interface PlannerResult {
	/** planner 的最终回答原文 */
	output: string;
	/** 解析出的计划 JSON(未校验) */
	plan: unknown;
}

/** 从 planner 输出文本提取 JSON(容错:```json 围栏 / 前后文夹杂) */
export function parsePlannerOutput(text: string): unknown {
	const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
	const candidate = fence ? fence[1] : text;
	const start = candidate.indexOf("{");
	const end = candidate.lastIndexOf("}");
	if (start === -1 || end === -1 || end <= start) {
		throw new Error("planner 输出中未找到 JSON 对象");
	}
	const json = candidate.slice(start, end + 1);
	try {
		return JSON.parse(json);
	} catch (e) {
		throw new Error(`planner JSON 解析失败: ${(e as Error).message}`);
	}
}

/** 构造 pi 子进程调用:当前进程是 pi 时复用其 node+脚本;否则走 PATH 的 pi(CLI 场景) */
export function piCommand(): { command: string; args: string[] } {
	const script = process.argv[1];
	if (
		script &&
		!script.startsWith("/$bunfs/") &&
		fs.existsSync(script) &&
		path.basename(script) === "pi"
	) {
		return { command: process.execPath, args: [script] };
	}
	return { command: "pi", args: [] };
}

export interface PlannerOptions {
	/** 测试注入:替代 pi 子进程调用 */
	plannerBin?: { command: string; args: string[] };
	/** 超时,默认 10 分钟 */
	timeoutMs?: number;
}

interface PlannerAgentConfig {
	name: string;
	model?: string;
	tools?: string[];
	systemPrompt: string;
}

function findPlannerAgent(cwd: string): PlannerAgentConfig {
	const agents = discoverAgents(cwd, "user").agents;
	const planner = agents.find((a) => a.name === "planner");
	if (!planner) {
		throw new Error("未找到 planner agent(需要 ~/.pi/agent/agents/planner.md)");
	}
	return {
		name: planner.name,
		model: planner.model,
		tools: planner.tools,
		systemPrompt: planner.systemPrompt,
	};
}

/**
 * headless 运行 planner agent:spawn pi --mode json -p --no-session --no-skills,
 * 解析 stdout JSON 事件流,返回最终 assistant 文本。
 */
export async function runPlanner(
	cwd: string,
	request: string,
	opts: PlannerOptions = {},
): Promise<string> {
	const agent = findPlannerAgent(cwd);
	const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
	const invocation = opts.plannerBin ?? piCommand();

	const args = [
		...invocation.args,
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--no-skills",
	];
	if (agent.model) args.push("--model", agent.model);
	if (agent.tools && agent.tools.length > 0) {
		args.push("--tools", agent.tools.join(","));
	}

	let tmpDir: string | null = null;
	let tmpPrompt: string | null = null;
	if (agent.systemPrompt.trim()) {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-planner-"));
		tmpPrompt = path.join(tmpDir, "system-prompt.md");
		fs.writeFileSync(tmpPrompt, agent.systemPrompt, "utf-8");
		args.push("--append-system-prompt", tmpPrompt);
	}

	args.push(PLANNER_TASK_TEMPLATE.replace("<REQUEST>", request));

	try {
		return await new Promise<string>((resolve, reject) => {
			const proc = spawn(invocation.command, args, {
				cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";
			let stderr = "";
			const assistantParts: string[] = [];
			const timeout = setTimeout(() => {
				proc.kill("SIGTERM");
				reject(new Error(`planner 超时(${Math.round(timeoutMs / 60000)}min)`));
			}, timeoutMs);

			const onLine = (line: string): void => {
				if (!line.trim()) return;
				let event: {
					type?: string;
					message?: {
						role?: string;
						content?: Array<{ type: string; text?: string }>;
					};
				};
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}
				if (event.type === "message_end" && event.message?.role === "assistant") {
					const text = (event.message.content ?? [])
						.filter((p) => p.type === "text" && p.text)
						.map((p) => p.text)
						.join("\n");
					if (text.trim()) assistantParts.push(text);
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) onLine(line);
			});
			proc.stderr.on("data", (data) => {
				stderr += data.toString();
			});
			proc.on("close", (code) => {
				clearTimeout(timeout);
				if (buffer.trim()) onLine(buffer);
				const output = assistantParts.join("\n").trim();
				if (code === 0 && output) {
					resolve(output);
				} else {
					reject(
						new Error(
							`planner 子进程退出(code=${code}): ${stderr.trim().slice(0, 500) || "无输出"}`,
						),
					);
				}
			});
			proc.on("error", (err) => {
				clearTimeout(timeout);
				reject(new Error(`planner 启动失败: ${err.message}`));
			});
		});
	} finally {
		if (tmpPrompt) {
			try {
				fs.unlinkSync(tmpPrompt);
			} catch {
				/* ignore */
			}
		}
		if (tmpDir) {
			try {
				fs.rmdirSync(tmpDir);
			} catch {
				/* ignore */
			}
		}
	}
}

/** 便捷入口:runPlanner + parsePlannerOutput */
export async function planFromGoal(
	cwd: string,
	request: string,
	opts: PlannerOptions = {},
): Promise<PlannerResult> {
	const output = await runPlanner(cwd, request, opts);
	return { output, plan: parsePlannerOutput(output) };
}
