/**
 * command.ts — 命令注册表(双入口 /wf 与 wf CLI 共享 CommandDef)
 *
 * 全部命令体集中于此,由 cli.ts(main)与 index.ts(handler)两个适配器查表派发:
 * 统一参数解析(parseArgs)、统一错误处理(UsageError / env.fail)、统一退出码
 * (0 成功 / 1 业务失败 / 2 poll 不可达 / 3 用法错误)。
 *
 * 命令体三段式:① 解析段(parseArgs + resolveWorkflowId/resolveStepId)
 *             ② 执行段(调用 orchestrator/dispatch/monitor/board 等,双入口零分支)
 *             ③ 输出段(按 env.kind 渲染与重构前逐字一致的两套文案)
 * 入口特有逻辑(现状行为差异)仅允许在输出段或显式 kind 分支中体现,见
 * docs/arch-refactor.md §2.6 入口差异表。
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { StepRow } from "./core/db.ts";
import {
	ATTEMPT_STATUS,
	addEvent,
	buildUpdate,
	createAttempt,
	createWave,
	DB_PATH,
	EVT,
	getAttemptsByStep,
	getEvents,
	getLatestAttempt,
	getRunningSteps,
	getStep,
	getStepsByWorkflow,
	getWorkflow,
	getWorkflowMeta,
	listActiveWorkflows,
	listWaves,
	listWorkflows,
	MASTER_TAB_KEY,
	STEP_STATUS,
	setWorkflowMeta,
	stepStatusCounts,
	updateStepStatus,
	updateWorkflowStatus,
	WORKFLOW_STATUS,
	workflowCost,
} from "./core/db.ts";
import { canTransition, legalTargets, stepIcon } from "./core/state.ts";
import {
	buildPointer,
	dispatchStep,
	findTerminalId,
	openStepTab,
	parseExpectations,
	resolveBin,
	run,
	sendTextToTerminal,
	WF_WINDOW_META_KEY,
	worktreePath,
} from "./exec/dispatch.ts";
import { closeTerminal, layoutJson } from "./exec/ghostty.ts";
import {
	createWorkflowWithMaster,
	isMasterMode,
	markMasterFailed,
	masterBranch,
	masterName,
	mergeMaster,
} from "./master.ts";
import {
	fetchLiveTabIds,
	getReadySteps,
	markNotified,
	mergeWave,
	pollTargetReached,
} from "./observe/monitor.ts";
import {
	appendSteps,
	checkBudget,
	goalCheckApprove,
	goalCheckEnter,
	goalCheckReject,
	importPlan,
	nextWave,
	reportDone,
	reportFail,
	verifyStep,
} from "./orchestrator.ts";
import { planFromGoal } from "./planner.ts";
import { sanitizeTerminalLines, sanitizeTerminalText } from "./sanitize.ts";
import {
	encodeSessionDir,
	findLatestSessionFile,
	parseSessionLine,
} from "./session.ts";
import { buildBoard, renderBoardHtml, renderBoardText } from "./ui/board.ts";
import { statusCountsLine } from "./ui/status.ts";
import type { PlanInput } from "./validate.ts";

// ────────────────────────────────────────────────────────────
// 空态引导(plan/import 无参时的 plan.json 模板,P0-5)
// JSON 本身不支持注释,故模板用纯 JSON + 字段说明表;模板同时服务于
// plan-init 缺参、import 缺文件、plan 缺目标的空态提示。
// ────────────────────────────────────────────────────────────
const PLAN_TEMPLATE_JSON = `{
  "name": "demo-wf",
  "title": "演示工作流",
  "goal": "要达成的目标",
  "repoPath": "/path/to/repo",
  "waveNote": "本 wave 说明",
  "concurrency": 1,
  "steps": [
    {
      "id": "1",
      "title": "输出方案",
      "agent": "planner",
      "task": "分析现状,输出方案,写入 {{root}}/docs/plan.md"
    },
    {
      "id": "1.1",
      "title": "实现第一步",
      "agent": "worker",
      "task": "按 {{steps.1.summary}} 实现",
      "deps": ["1"],
      "expectations": ["验收点 1", "测试通过"],
      "gate": false
    }
  ]
}`;

const PLAN_TEMPLATE_FIELDS = `字段说明:
- name: workflow 唯一 id(必填)
- title / goal: 标题与需求目标(必填)
- repoPath: 目标仓库路径(缺省=当前目录)
- waveNote: 本 wave 说明(可选);concurrency: 并发数(可选)
- steps[].id: 点号 id,支持层级(1 / 1.1 / 1.2 …)
- steps[].agent: planner|worker|reviewer(必填)
- steps[].task: 任务描述,支持 {{root}} 与 {{steps.<id>.summary}} 占位
- steps[].deps: 依赖步骤 id 列表(可选,须已存在且无环)
- steps[].expectations: 期望/验收标准数组(可选)
- steps[].gate: true = gate 步骤,回报后需 /wf verify 才能合并(可选)`;

/** 空态提示正文:plan.json 模板 + 字段说明(plan/import/plan-init 共用) */
export const PLAN_TEMPLATE_HINT = `plan.json 模板(保存为 plan.json 后 /wf import plan.json):\n${PLAN_TEMPLATE_JSON}\n\n${PLAN_TEMPLATE_FIELDS}`;

// ────────────────────────────────────────────────────────────
// 类型与注册表
// ────────────────────────────────────────────────────────────
/**
 * 命令上下文:适配器提供宿主能力。
 * kind 用于「输出文案差异」分支(§2.6),禁止用于任何逻辑分支。
 */
export interface CmdEnv {
	readonly kind: "cli" | "pi";
	readonly cwd: string;
	readonly db: DatabaseSync;
	/** 多行展示。CLI:console.log 逐行;pi:渲染到 def.widget(widget 缺省时 notify(info) 合并行) */
	show(lines: string[]): void;
	/** 成功结果行。CLI:console.log;pi:notify(info) */
	info(line: string): void;
	/** 警告行。CLI:console.warn;pi:notify(warning) */
	warn(line: string): void;
	/** 业务失败。CLI:console.error + exitCode=1;pi:notify(error) */
	fail(line: string): void;
	/** pi 专属提示(widget 命令的"已显示/已更新"toast)。CLI:no-op */
	notifyPi(line: string): void;
	/** 特殊退出码(仅 CLI 生效):poll 的 0/1/2、SIGINT 130 等。pi:no-op */
	setExitCode(code: number): void;
}

/** 用法/参数错误:run 内 throw,适配器统一处理(CLI:stderr + exitCode=3;pi:notify warning) */
export class UsageError extends Error {}

export interface CommandDef {
	/** 命令名(CLI 子命令名,也是 /wf 第一个参数) */
	name: string;
	/** 一句话描述(help / 补全列表) */
	description: string;
	/** 用法行(UsageError 时展示) */
	usage: string;
	/** 可用入口,缺省 "both" */
	entry?: "cli" | "pi" | "both";
	/** pi widget 名(命令调用 env.show() 时,pi 适配器渲染到该 widget) */
	widget?: string;
	/** 执行体 */
	run(args: string[], env: CmdEnv): Promise<void> | void;
}

const registry = new Map<string, CommandDef>();

/** 注册命令;name 重复抛错(防双入口各自注册导致覆盖) */
export function register(def: CommandDef): void {
	if (registry.has(def.name)) {
		throw new Error(`命令重复注册: ${def.name}`);
	}
	registry.set(def.name, def);
}

export function getCommand(name: string): CommandDef | undefined {
	return registry.get(name);
}

/** 列出命令(可按入口过滤),按 name 排序;help 与补全共用 */
export function listCommands(entry?: "cli" | "pi"): CommandDef[] {
	return [...registry.values()]
		.filter((d) => {
			const e = d.entry ?? "both";
			return !entry || e === entry || e === "both";
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

// ────────────────────────────────────────────────────────────
// 参数解析
// ────────────────────────────────────────────────────────────
/** flag 定义 */
export interface FlagSpec {
	/** 完整名,含前缀,如 "--until" */
	name: string;
	/** 短别名,如 "-n"(可省) */
	alias?: string;
	/**
	 * false/缺省 = boolean flag(只记出现);
	 * true = 消费下一个 token 作为值;
	 * "greedy" = 消费剩余全部 token(如 --note 的多词说明)
	 */
	value?: boolean | "greedy";
}

export class Args {
	readonly values: Map<string, string | undefined> = new Map(); // 带值 flag:名(含前缀)→ 值(可 undefined)
	readonly bools: Set<string> = new Set(); // 出现的 boolean flag 名(含前缀)
	readonly positionals: string[] = []; // 位置参数(跳过全部 flag 及其值)

	/** 带值 flag 取值:flag 出现且带值 → 值;出现但缺值 → undefined(与现状 flagValue 一致);未出现 → 默认 */
	value(name: string, def?: string): string | undefined {
		if (!this.values.has(name)) return def;
		return this.values.get(name);
	}

	/** boolean flag 是否出现 */
	bool(name: string): boolean {
		return this.bools.has(name);
	}
}

export function parseArgs(args: string[], specs: FlagSpec[]): Args {
	const out = new Args();
	const byName = new Map<string, FlagSpec>();
	for (const s of specs) {
		byName.set(s.name, s);
		if (s.alias) byName.set(s.alias, s);
	}
	let i = 0;
	while (i < args.length) {
		const tok = args[i];
		const spec = tok.startsWith("-") ? byName.get(tok) : undefined;
		if (spec && spec.value === true) {
			out.values.set(spec.name, args[i + 1]); // 与现状 flagValue 一致:取下一个 token,可为 undefined
			i += 2;
		} else if (spec && spec.value === "greedy") {
			out.values.set(spec.name, args.slice(i + 1).join(" "));
			break; // 消费剩余全部
		} else if (spec) {
			out.bools.add(spec.name);
			i += 1;
		} else {
			// 未命中 spec 的 token:以 "-" 开头 → 丢弃(与现状 positionalArgs 一致:
			// 凡以 - 开头未命中 spec 不落入 positionals,见 §2.2 等价性说明);否则为位置参数
			if (!tok.startsWith("-")) out.positionals.push(tok);
			i += 1;
		}
	}
	return out;
}

// ────────────────────────────────────────────────────────────
// 共享解析助手
// ────────────────────────────────────────────────────────────
/** 子 pi 身份(自 index.ts 移入;index.ts 保留再导出兼容) */
export interface WfIdentity {
	workflowId: string;
	dotted: string | null;
	stepId: string | null;
	/** master-agent 模式:该会话是 workflow 的主控 agent(非子步骤) */
	master?: boolean;
}

/**
 * 子 pi 身份:环境变量优先,cwd(worktree 路径)兜底。
 * 识别顺序:① 步骤 env(PI_WF_WORKFLOW/PI_WF_STEP)→ ② 主控 env(PI_WF_MASTER)
 * → ③ cwd 段(步骤正则优先,主控正则兜底)。歧义场景(wf-master-<x>-<digits>
 * 既可能是 workflow <x>-<digits> 的主控,也可能是 workflow master-<x> 的步骤)
 * 有 db 时按 workflow 存在性判定;无 db 时优先步骤解释(与旧行为一致)。
 */
export function resolveIdentity(
	cwd: string,
	db?: DatabaseSync,
): WfIdentity | null {
	const envWf = process.env.PI_WF_WORKFLOW;
	const envStep = process.env.PI_WF_STEP;
	if (envWf && envStep) {
		return {
			workflowId: envWf,
			dotted: envStep,
			stepId: `${envWf}-${envStep}`,
		};
	}
	const envMaster = process.env.PI_WF_MASTER;
	if (envMaster) {
		return { workflowId: envMaster, dotted: null, stepId: null, master: true };
	}
	for (const seg of cwd.split("/")) {
		const masterM = /^(?:gittree-)?wf-master-(.+)$/.exec(seg);
		if (masterM) {
			const masterWfId = masterM[1];
			// 歧义:形如 wf-master-<x>-<digits>(主控 id 以数字结尾)也可能是
			// workflow master-<x> 的步骤。有 db 时按 workflow 存在性判定。
			const stepM = /^(?:gittree-)?wf-(.+)-([0-9.]+)$/.exec(seg);
			if (
				stepM &&
				stepM[1] !== masterWfId &&
				(!db || !getWorkflow(db, masterWfId) || getWorkflow(db, stepM[1]))
			) {
				return {
					workflowId: stepM[1],
					dotted: stepM[2],
					stepId: `${stepM[1]}-${stepM[2]}`,
				};
			}
			return {
				workflowId: masterWfId,
				dotted: null,
				stepId: null,
				master: true,
			};
		}
		const stepM = /^(?:gittree-)?wf-(.+)-([0-9.]+)$/.exec(seg);
		if (stepM) {
			return {
				workflowId: stepM[1],
				dotted: stepM[2],
				stepId: `${stepM[1]}-${stepM[2]}`,
			};
		}
	}
	return null;
}

/**
 * workflow 解析:显式参数(支持唯一前缀匹配)→ 身份 env → cwd 所在仓库的活动 workflow。
 * 前缀匹配:唯一命中返回完整 id;多个候选 warn 列出(防手输写错);无命中返回 null。
 */
export function resolveWorkflowId(
	env: CmdEnv,
	explicit?: string,
): string | null {
	if (explicit) {
		if (getWorkflow(env.db, explicit)) return explicit; // 完整 id 直接命中
		const hits = listWorkflows(env.db).filter((w) => w.id.startsWith(explicit));
		if (hits.length === 1) return hits[0].id;
		if (hits.length > 1) {
			env.warn(
				`workflow id 前缀 ${explicit} 不唯一: ${hits.map((w) => w.id).join(", ")}(请用完整 id)`,
			);
			return null;
		}
		// 无命中:原样返回,由下游报「workflow 不存在: <id>」(更准确的错误)
		return explicit;
	}
	const ident = resolveIdentity(env.cwd, env.db);
	if (ident) return ident.workflowId;
	const cwd = path.resolve(env.cwd);
	const matches = listActiveWorkflows(env.db).filter((w) => {
		const repo = path.resolve(w.repo_path);
		return repo === cwd || cwd.startsWith(repo + path.sep);
	});
	if (matches.length === 1) return matches[0].id;
	return null;
}

/**
 * 步骤解析:完整 id 直接命中 → 点号 id 按身份/活动 workflow 兜底 → 当前 workflow 内唯一前缀匹配。
 * 前缀匹配防手输写错(typo 少写/多写字符仍能命中);多个候选 warn 列出。
 */
export function resolveStepId(env: CmdEnv, token: string): StepRow | null {
	const direct = getStep(env.db, token);
	if (direct) return direct;
	const wfId = resolveWorkflowId(env);
	if (!wfId) return null;
	const full = getStep(env.db, `${wfId}-${token}`);
	if (full) return full;
	// 唯一前缀匹配(限定当前 workflow,避免跨 workflow 混乱)
	const hits = getStepsByWorkflow(env.db, wfId).filter((s) =>
		s.id.startsWith(token),
	);
	if (hits.length === 1) return hits[0];
	if (hits.length > 1) {
		env.warn(
			`步骤 id 前缀 ${token} 不唯一: ${hits.map((s) => s.id).join(", ")}(请用完整 id)`,
		);
	}
	return null;
}

/** JSON 参数解析(自 index.parseJsonArg 收敛) */
export function parseJsonArg(raw: string): {
	ok: boolean;
	value?: unknown;
	error?: string;
} {
	try {
		return { ok: true, value: JSON.parse(raw) };
	} catch (e) {
		return { ok: false, error: `JSON 解析失败: ${(e as Error).message}` };
	}
}

// ────────────────────────────────────────────────────────────
// CLI 独有渲染助手(printStatusJson/printStatusText/printTree 原样迁移)
// ────────────────────────────────────────────────────────────
function printStatusJson(env: CmdEnv, wfId?: string): void {
	const workflows = wfId
		? [getWorkflow(env.db, wfId)].filter((w): w is NonNullable<typeof w> =>
				Boolean(w),
			)
		: listWorkflows(env.db);
	const out = workflows.map((w) => {
		const counts = stepStatusCounts(env.db, w.id);
		const steps = getStepsByWorkflow(env.db, w.id);
		const cost = workflowCost(env.db, w.id);
		const winId = getWorkflowMeta(env.db, w.id, WF_WINDOW_META_KEY);
		return {
			id: w.id,
			title: w.title,
			status: w.status,
			wave: w.current_wave,
			repoPath: w.repo_path,
			baseSha: w.base_sha,
			boundWindow: winId ?? null,
			steps: steps.map((s) => ({
				id: s.id,
				status: s.status,
				agent: s.agent,
				gate: Boolean(s.gate),
			})),
			counts,
			costCents: cost?.cost_cents ?? 0,
		};
	});
	env.info(JSON.stringify(out, null, 2));
}

function printStatusText(env: CmdEnv, wfId?: string): void {
	const workflows = wfId
		? [getWorkflow(env.db, wfId)].filter((w): w is NonNullable<typeof w> =>
				Boolean(w),
			)
		: listWorkflows(env.db);
	if (workflows.length === 0) {
		env.info("(无 workflow,先用 wf import <plan.json> 导入计划)");
		return;
	}
	for (const w of workflows) {
		const counts = stepStatusCounts(env.db, w.id);
		const steps = getStepsByWorkflow(env.db, w.id);
		const cost = workflowCost(env.db, w.id);
		const winId = getWorkflowMeta(env.db, w.id, WF_WINDOW_META_KEY) as
			| string
			| undefined;
		const done = (counts.done ?? 0) + (counts.skipped ?? 0);
		const running = (counts.dispatched ?? 0) + (counts.running ?? 0);
		const abnormal =
			(counts.failed ?? 0) +
			(counts.aborted ?? 0) +
			(counts.conflict ?? 0) +
			(counts["needs-fix"] ?? 0);
		const costText =
			cost && cost.cost_cents > 0 ? ` $${(cost.cost_cents / 100).toFixed(2)}` : "";
		env.info(
			`[${w.id}] ${sanitizeTerminalText(w.title)} | ${w.status} | 进度 ${done}/${steps.length} 运行${running} 异常${abnormal}${costText}`,
		);
		if (w.goal) env.info(`  goal: ${sanitizeTerminalText(w.goal)}`);
		if (isMasterMode(env.db, w.id)) {
			const hint =
				w.status === WORKFLOW_STATUS.awaitingMerge
					? " → /wf master-merge 合并回主分支"
					: "(主控 agent 自主编排中)";
			env.info(`  mode: master(master gittree: ${masterBranch(w.id)})${hint}`);
		}
		env.info(
			`  repo: ${w.repo_path} | base: ${w.base_sha ?? "-"} | 绑定窗口: ${winId ?? "-"}`,
		);
		for (const s of getRunningSteps(env.db, w.id)) {
			env.info(
				`  ▶ ${s.id} ${sanitizeTerminalText(s.title)} tab=${s.tab_id ? s.tab_id.slice(0, 8) : "?"}`,
			);
		}
	}
}

function printTree(env: CmdEnv, wfIdArg?: string): void {
	const wf = wfIdArg ?? resolveWorkflowId(env);
	if (!wf) {
		env.fail("无法确定 workflow(传 id 或在仓库根目录运行)");
		return;
	}
	const steps = getStepsByWorkflow(env.db, wf);
	for (const s of steps) {
		const depth = s.id.slice(wf.length + 1).split(".").length;
		const icon = stepIcon(s.status);
		env.info(
			`${"  ".repeat(depth - 1)}${icon} ${s.id.slice(wf.length + 1)} ${sanitizeTerminalText(s.title)} [${s.agent}${s.gate ? "/gate" : ""}]${s.error ? ` ✗ ${sanitizeTerminalText(s.error)}` : ""}`,
		);
	}
}

// ────────────────────────────────────────────────────────────
// 命令定义(31 条)
// ────────────────────────────────────────────────────────────

// ── plan-init(CLI 独有)────────────────────────────────────
register({
	name: "plan-init",
	description: "生成 plan.json 模板",
	usage: 'wf plan-init <name> "<目标>" [--repo <path>] [--steps N]',
	entry: "cli",
	run: (args, env) => {
		const parsed = parseArgs(args, [
			{ name: "--repo", value: true },
			{ name: "--steps", value: true },
		]);
		const [name, goal] = parsed.positionals;
		const repo = parsed.value("--repo") ?? env.cwd;
		const n = Number(parsed.value("--steps", "4"));
		if (!name || !goal) {
			// 空态引导(P0-5):缺参时展示 plan.json 模板,而非只报用法
			throw new UsageError(PLAN_TEMPLATE_HINT);
		}
		const steps = Array.from({ length: n }, (_, i) => ({
			id: String(i + 1),
			title: `步骤 ${i + 1}`,
			agent: i === 0 ? "planner" : i === n - 1 ? "reviewer" : "worker",
			task: `描述第 ${i + 1} 步要做什么`,
		}));
		const plan: PlanInput = { name, title: name, goal, repoPath: repo, steps };
		const out = path.join(env.cwd, "plan.json");
		fs.writeFileSync(out, JSON.stringify(plan, null, 2) + "\n");
		env.info(`已生成 ${out}(编辑 steps 后 /wf import 或 wf import)`);
	},
});

// ── import(双入口)──────────────────────────────────────────
register({
	name: "import",
	description: "校验 + 落库(--workflow <id>:追加到已有 workflow 的当前 wave)",
	usage: "wf import <plan.json> [--workflow <id>]",
	run: (args, env) => {
		const parsed = parseArgs(args, [{ name: "--workflow", value: true }]);
		const explicitWf = parsed.value("--workflow");
		const file = parsed.positionals[0];
		if (!file) {
			// 空态引导(P0-5):缺文件时给出 plan.json 模板,而非只报用法
			if (env.kind === "cli") throw new UsageError(PLAN_TEMPLATE_HINT);
			env.warn(`用法: /wf import <plan.json>\n\n${PLAN_TEMPLATE_HINT}`);
			return;
		}
		const abs = path.resolve(env.cwd, file);
		if (env.kind === "pi" && !fs.existsSync(abs)) {
			env.fail(`文件不存在: ${abs}`);
			return;
		}
		let raw: string;
		try {
			raw = fs.readFileSync(abs, "utf-8");
		} catch (e) {
			if (env.kind === "pi") {
				env.fail(`读取失败: ${(e as Error).message}`);
				return;
			}
			throw e; // CLI:与现状一致,读取失败向上抛 → main catch("执行失败:" + exit 1)
		}
		const parsedPlan = parseJsonArg(raw);
		if (!parsedPlan.ok) {
			env.fail(
				env.kind === "cli"
					? `✗ 计划文件不是合法 JSON: ${sanitizeTerminalText(parsedPlan.error ?? "")}`
					: sanitizeTerminalText(parsedPlan.error ?? ""),
			);
			return;
		}
		const plan = parsedPlan.value as PlanInput;
		// master-agent 模式:主控在 worktree 内自研拆解后,把计划导入已有
		// workflow(空 workflow 自动建 wave 1;非空则追加到当前 wave)
		if (explicitWf) {
			const wf = getWorkflow(env.db, explicitWf);
			if (!wf) {
				env.fail(`${env.kind === "cli" ? "✗ " : ""}workflow 不存在: ${explicitWf}`);
				return;
			}
			const appRes = appendSteps(
				env.db,
				explicitWf,
				wf.current_wave || 1,
				plan,
				env.cwd,
			);
			if (!appRes.ok) {
				if (env.kind === "cli") {
					env.fail("追加失败:");
					for (const e of appRes.errors ?? []) env.fail(`  ✗ ${e}`);
					return;
				}
				env.fail(`追加失败:\n${appRes.errors?.slice(0, 10).join("\n")}`);
				return;
			}
			env.info(
				env.kind === "cli"
					? `✓ 已向 ${explicitWf} 导入 ${appRes.added} 个步骤(wave ${wf.current_wave || 1})`
					: `已向 ${explicitWf} 导入 ${appRes.added} 个步骤(wave ${wf.current_wave || 1}),可 /wf dispatch 派发`,
			);
			return;
		}
		const result = importPlan(env.db, plan, env.cwd);
		if (!result.ok) {
			if (env.kind === "cli") {
				env.fail("导入失败:");
				for (const e of result.errors ?? []) env.fail(`  ✗ ${e}`);
				return;
			}
			env.fail(`计划校验失败:\n${result.errors!.slice(0, 10).join("\n")}`);
			return;
		}
		env.info(
			env.kind === "cli"
				? `✓ 已导入 ${result.workflowId}:${result.stepCount} 个步骤(wave ${result.wave})`
				: `已导入 ${result.workflowId}:${result.stepCount} 个步骤(wave ${result.wave}),可用 /wf dispatch 派发`,
		);
	},
});

// ── create(master-agent 模式,双入口)───────────────────────
/** workflow id kebab 化(从标题/目标提取,唯一化后缀) */
function kebabId(title: string): string {
	const kebab = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return kebab || "wf";
}

function uniqueWorkflowId(db: DatabaseSync, base: string): string {
	if (!getWorkflow(db, base)) return base;
	for (let i = 2; ; i++) {
		const cand = `${base}-${i}`;
		if (!getWorkflow(db, cand)) return cand;
	}
}

register({
	name: "create",
	description:
		"创建 master-agent 模式 workflow(主控 agent 自主编排,发起方不阻塞)",
	usage:
		'wf create "<需求目标>" [--repo <path>] [--id <id>] [--title <title>] [--dry-run]',
	run: async (args, env) => {
		const parsed = parseArgs(args, [
			{ name: "--dry-run" },
			{ name: "--repo", value: true },
			{ name: "--id", value: true },
			{ name: "--title", value: true },
		]);
		const dryRun = parsed.bool("--dry-run");
		const repoPath = path.resolve(parsed.value("--repo") ?? env.cwd);
		const goal = parsed.positionals.join(" ").trim();
		if (!goal) {
			if (env.kind === "cli") throw new UsageError();
			env.warn(
				`用法: /wf create "<需求目标>" [--repo <path>] [--id <id>] [--title <title>]\n创建后主控 agent 在独立 gittree 自主完成:分析→拆解→派发→合并→目标把关;完成后通知你,由你决定 /wf master-merge <id> 合并回主分支。`,
			);
			return;
		}
		const explicitId = parsed.value("--id");
		const title = parsed.value("--title") ?? goal.slice(0, 40);
		const baseId = explicitId ?? kebabId(title);
		if (!/^[a-z0-9][a-z0-9-]*$/.test(baseId)) {
			env.fail(
				`workflow id 不合法: ${baseId}(仅小写字母/数字/连字符,建议英文 kebab-case)`,
			);
			return;
		}
		const workflowId = explicitId ? baseId : uniqueWorkflowId(env.db, baseId);
		const res = await createWorkflowWithMaster(env.db, {
			repoPath,
			ownerCwd: env.cwd,
			workflowId,
			title,
			goal,
			dryRun,
		});
		if (!res.ok) {
			env.fail(`${env.kind === "cli" ? "✗ " : ""}${res.error}`);
			return;
		}
		if (dryRun) {
			env.info(`[dry-run] 将创建 workflow ${workflowId}(repo: ${repoPath}):`);
			env.info(`  master gittree: ${res.masterBranchName}(${res.masterWorktree})`);
			env.info(`  专属窗口开主控 tab,主控自主完成 plan→dispatch→merge→goal-check`);
			return;
		}
		env.info(
			`✓ workflow ${workflowId} 已创建,主控 agent 已在专属窗口启动(master gittree: ${res.masterBranchName})`,
		);
		env.info(
			`  主控将自主完成:分析→拆解→派发子任务→合并→目标把关;全部完成后通知你,届时 /wf master-merge ${workflowId} 合并回主分支。`, //
		);
	},
});

// ── master-merge(发起方决策点,双入口)──────────────────────
register({
	name: "master-merge",
	description: "合并主控 gittree 回主分支(主控完成后的发起方决策点)",
	usage: "wf master-merge <id>",
	run: async (args, env) => {
		const [wfId] = args;
		if (!wfId) {
			if (env.kind === "cli") throw new UsageError();
			env.warn(
				"用法: /wf master-merge <id>\n把主控 gittree 分支合并回当前分支并清理(workflow 置 completed)。",
			);
			return;
		}
		const res = await mergeMaster(env.db, wfId);
		if (!res.ok) {
			env.fail(`${env.kind === "cli" ? "✗ " : ""}${res.error}`);
			return;
		}
		env.info(
			res.error
				? `✓ ${res.error}`
				: `✓ workflow ${wfId} 主控 gittree 已合并回主分支并清理(completed)`,
		);
	},
});

// ── master-fail(主控放弃/发起方确认结束,双入口)────────────
register({
	name: "master-fail",
	description: "主控无法继续时标记失败(通知发起方人工介入)",
	usage: "wf master-fail <id> <原因...>",
	run: (args, env) => {
		const [wfId, ...rest] = args;
		if (!wfId) {
			if (env.kind === "cli") throw new UsageError();
			env.warn(
				"用法: /wf master-fail <id> <原因...>\n把 workflow 置 failed,通知发起方人工介入(主控会话内使用)。",
			);
			return;
		}
		const res = markMasterFailed(env.db, wfId, rest.join(" "));
		if (!res.ok) {
			env.fail(`${env.kind === "cli" ? "✗ " : ""}${res.error}`);
			return;
		}
		env.info(`✗ workflow ${wfId} 已标记失败(发起方将收到通知)`);
	},
});

// ── delete(双入口:agent 清理误建/废弃 workflow 的唯一正道,禁止手动改库)──
register({
	name: "delete",
	description: "删除 workflow(关 tab + 清 gittree + 级联删库)",
	usage: "wf delete <workflowId>",
	run: async (args, env) => {
		const wfId = args[0];
		if (!wfId) throw new UsageError();
		const wf = getWorkflow(env.db, wfId);
		if (!wf) {
			env.fail(`${env.kind === "cli" ? "✗ " : ""}workflow 不存在: ${wfId}`);
			return;
		}
		const steps = getStepsByWorkflow(env.db, wfId);
		// 1. 关 tab(主控 tab + 各步骤 tab;已关则跳过)
		const masterTab = getWorkflowMeta(env.db, wfId, MASTER_TAB_KEY) as
			| string
			| undefined;
		for (const tid of [
			masterTab,
			...steps.map((s) => s.tab_id ?? null),
		]) {
			if (!tid) continue;
			try {
				await closeTerminal(tid);
			} catch {
				/* 已关/查询失败,忽略 */
			}
		}
		// 2. 清 gittree(尽力而为;占用中的由 gittree clean 跳过,不阻断)
		const gittreeBin = resolveBin("gittree");
		const gittrees = [
			isMasterMode(env.db, wfId) ? masterName(wfId) : null,
			...steps.map((s) => s.worktree ?? null),
		].filter((n): n is string => Boolean(n));
		for (const n of gittrees) {
			await run(
				gittreeBin,
				["clean", n, "--branch", "--force"],
				wf.repo_path,
			);
		}
		// 3. 级联删库(按引用依赖序,禁手动改库的替代品)
		env.db.exec("BEGIN");
		try {
			env.db.prepare("DELETE FROM workflow_events WHERE workflow_id=?").run(wfId);
			env.db.prepare("DELETE FROM workflow_goal_items WHERE workflow_id=?").run(wfId);
			env.db.prepare("DELETE FROM workflow_metadata WHERE workflow_id=?").run(wfId);
			env.db
				.prepare(
					"DELETE FROM workflow_step_metadata WHERE step_id IN (SELECT id FROM workflow_steps WHERE workflow_id=?)",
				)
				.run(wfId);
			env.db
				.prepare(
					"DELETE FROM workflow_attempts WHERE step_id IN (SELECT id FROM workflow_steps WHERE workflow_id=?)",
				)
				.run(wfId);
			env.db
				.prepare(
					"DELETE FROM workflow_step_deps WHERE step_id IN (SELECT id FROM workflow_steps WHERE workflow_id=?) OR dep_id IN (SELECT id FROM workflow_steps WHERE workflow_id=?)",
				)
				.run(wfId, wfId);
			env.db.prepare("DELETE FROM workflow_steps WHERE workflow_id=?").run(wfId);
			env.db.prepare("DELETE FROM workflow_waves WHERE workflow_id=?").run(wfId);
			env.db.prepare("DELETE FROM workflow WHERE id=?").run(wfId);
			env.db.exec("COMMIT");
		} catch (e) {
			env.db.exec("ROLLBACK");
			env.fail(`${env.kind === "cli" ? "✗ " : ""}删除失败: ${(e as Error).message}`);
			return;
		}
		env.info(`✓ workflow ${wfId} 已删除(tab/数据库/worktree 已清理)`);
	},
});

// ────────────────────────────────────────────────────────────
// .pi-glla 启动即忽略(根治 gittree merge 干净检查拦截)
// ────────────────────────────────────────────────────────────
/**
 * 确保仓库根 .gitignore 包含 .pi-glla/(子 pi 运行时目录,非代码产出)。
 * 任何 pi 会话启动时调用:主控/子任务会话在 worktree 内启动会生成 .pi-glla,
 * 若未被忽略,git status 会出现 untracked 改动,拦截 gittree merge 的干净检查
 * (master-merge 卡点之一)。幂等;非 git 仓库/写入失败静默跳过。
 * @returns 本次是否追加了条目
 */
export function ensureGllaIgnored(repoPath: string): boolean {
	let root: string;
	try {
		root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
			cwd: repoPath,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return false; // 非 git 仓库
	}
	if (!root) return false;
	try {
		const giPath = path.join(root, ".gitignore");
		const giContent = fs.existsSync(giPath)
			? fs.readFileSync(giPath, "utf-8")
			: "";
		const hasEntry = giContent
			.split("\n")
			.some((l) => l.trim() === ".pi-glla/" || l.trim() === ".pi-glla");
		if (hasEntry) return false;
		const add = `${giContent && !giContent.endsWith("\n") ? "\n" : ""}# pi-workflow: 子 pi 运行时状态(防 merge 冲突)\n.pi-glla/\n`;
		fs.appendFileSync(giPath, add);
		return true;
	} catch {
		return false;
	}
}

// ── status(双入口)──────────────────────────────────────────
register({
	name: "status",
	description: "状态全景",
	usage: "wf status [--json] [wfId]",
	widget: "workflow-status",
	run: (args, env) => {
		const parsed = parseArgs(args, [{ name: "--json" }, { name: "--all" }]);
		const explicit = parsed.positionals[0];
		if (env.kind === "cli") {
			if (parsed.bool("--json")) {
				printStatusJson(env, explicit);
				return;
			}
			printStatusText(env, explicit);
			return;
		}
		// pi:--all + waves/最近事件;行内容与重构前一致
		const showAll = parsed.bool("--all");
		const lines: string[] = [];
		const workflows = explicit
			? [getWorkflow(env.db, explicit)].filter((w): w is NonNullable<typeof w> =>
					Boolean(w),
				)
			: showAll
				? listWorkflows(env.db)
				: listActiveWorkflows(env.db);
		if (workflows.length === 0) {
			lines.push("(无 workflow,先用 /wf import <plan.json> 导入计划)");
		}
		for (const w of workflows) {
			const counts = stepStatusCounts(env.db, w.id);
			const steps = getStepsByWorkflow(env.db, w.id);
			const cost = workflowCost(env.db, w.id);
			const costText =
				cost && cost.cost_cents > 0
					? ` $${(cost.cost_cents / 100).toFixed(2)}`
					: "";
			const waves = listWaves(env.db, w.id);
			lines.push(
				`[${w.id}] ${w.title} | ${w.status} | repo: ${w.repo_path} | base: ${w.base_sha ?? "-"}`,
				`  ${statusCountsLine(counts, steps.length)}${costText} | waves: ${waves.map((x) => `${x.seq}:${x.status}`).join(", ")}`,
			);
			if (w.goal) lines.push(`  goal: ${w.goal}`);
			if (isMasterMode(env.db, w.id)) {
				const hint =
					w.status === WORKFLOW_STATUS.awaitingMerge
						? " → /wf master-merge 合并回主分支"
						: "(主控 agent 自主编排中)";
				lines.push(`  mode: master(master gittree: ${masterBranch(w.id)})${hint}`);
			}
			for (const s of getRunningSteps(env.db, w.id)) {
				lines.push(`  ▶ ${s.id} ${s.title} tab=${s.tab_id ?? "?"}`);
			}
			const recent = getEvents(env.db, { workflowId: w.id, limit: 5 });
			if (recent.length > 0) {
				lines.push(`  最近事件: ${recent.map((e) => `${e.type}`).join(" → ")}`);
			}
		}
		env.show(lines);
		env.notifyPi(`[wf] 状态已更新(${workflows.length} 个 workflow)`);
	},
});

// ── tree(双入口)────────────────────────────────────────────
register({
	name: "tree",
	description: "层级任务树",
	usage: "wf tree [wfId]",
	widget: "workflow-tree",
	run: (args, env) => {
		const parsed = parseArgs(args, []);
		if (env.kind === "cli") {
			printTree(env, parsed.positionals[0]);
			return;
		}
		const wfId = resolveWorkflowId(env, parsed.positionals[0]);
		if (!wfId) {
			env.fail("无法确定 workflow(在仓库根目录运行,或显式传 workflow id)");
			return;
		}
		const steps = getStepsByWorkflow(env.db, wfId);
		if (steps.length === 0) {
			env.fail(`workflow ${wfId} 没有步骤`);
			return;
		}
		const lines = steps.map((s) => {
			const depth = s.id.slice(wfId.length + 1).split(".").length;
			const indent = "  ".repeat(depth - 1);
			const exp = parseExpectations(s.expectations);
			const meta = [
				s.agent,
				s.gate === 1 ? "gate" : null,
				exp.length > 0 ? `期望${exp.length}` : null,
				s.worktree ?? null,
			]
				.filter(Boolean)
				.join(" ");
			return `${indent}${stepIcon(s.status)} ${s.id.slice(wfId.length + 1)} ${s.title} [${meta}] ${s.error ? `✗ ${s.error}` : ""}`;
		});
		env.show(lines);
		env.notifyPi(`[wf] ${wfId} 任务树(${steps.length} 步)`);
	},
});

// ── board(双入口)───────────────────────────────────────────
register({
	name: "board",
	description: "看板(终端列布局/导出 HTML)",
	usage: "wf board [wfId] [--wave N] [--html out.html]",
	widget: "workflow-board",
	run: (args, env) => {
		const parsed = parseArgs(args, [
			{ name: "--html", value: true },
			{ name: "--wave", value: true },
		]);
		const htmlPath = parsed.value("--html");
		const waveSeq =
			parsed.value("--wave") === undefined
				? undefined
				: Number(parsed.value("--wave"));
		const wfId = resolveWorkflowId(
			env,
			parsed.positionals.find((a) => !/^\d+$/.test(a)),
		);
		if (!wfId) {
			env.fail(
				env.kind === "cli"
					? "无法确定 workflow(传 id 或在仓库根目录运行)"
					: "无法确定 workflow(在仓库根目录运行,或显式传 workflow id)",
			);
			return;
		}
		const board = buildBoard(env.db, wfId, waveSeq);
		if (!board) {
			env.fail(
				env.kind === "cli"
					? `✗ workflow 不存在: ${wfId}`
					: `workflow 不存在: ${wfId}`,
			);
			return;
		}
		if (htmlPath) {
			if (env.kind === "cli") {
				const out = path.resolve(env.cwd, htmlPath);
				fs.writeFileSync(out, renderBoardHtml(board), "utf-8");
				env.info(`✓ 看板已导出: ${out}`);
				return;
			}
			try {
				const out = path.resolve(env.cwd, htmlPath);
				fs.writeFileSync(out, renderBoardHtml(board), "utf-8");
				env.info(`看板已导出: ${out}`);
			} catch (e) {
				env.fail(`导出失败: ${(e as Error).message}`);
			}
			return;
		}
		env.show(renderBoardText(board));
		if (env.kind === "pi") {
			env.notifyPi(`[wf] ${wfId} 看板:${board.done}/${board.total} 完成`);
		}
	},
});

// ── step(双入口)────────────────────────────────────────────
register({
	name: "step",
	description: "单步详情",
	usage: "wf step <id>",
	widget: "workflow-step",
	run: (args, env) => {
		const token = args[0];
		if (!token) {
			if (env.kind === "cli") throw new UsageError();
			env.warn("用法: /wf step <id>");
			return;
		}
		const step = resolveStepId(env, token);
		if (!step) {
			env.fail(
				env.kind === "cli" ? `✗ 步骤不存在: ${token}` : `步骤不存在: ${token}`,
			);
			return;
		}
		if (env.kind === "cli") {
			env.info(`[${step.id}] ${sanitizeTerminalText(step.title)}`);
			env.info(
				`  状态: ${step.status} | agent: ${step.agent} | gate: ${step.gate} | worktree: ${step.worktree ?? "-"} | tab: ${step.tab_id ?? "-"}`,
			);
			env.info(`  期望: ${sanitizeTerminalText(step.expectations ?? "-")}`);
			env.info(`  回报: ${sanitizeTerminalText(step.report ?? "-")}`);
			env.info(`  错误: ${sanitizeTerminalText(step.error ?? "-")}`);
			for (const a of getAttemptsByStep(env.db, step.id)) {
				env.info(
					`  attempt#${a.attempt_no} ${a.status} tab=${a.tab_id ? a.tab_id.slice(0, 8) : "-"}${a.error ? ` 错误: ${sanitizeTerminalText(a.error)}` : ""}`,
				);
			}
			const events = getEvents(env.db, { stepId: step.id, limit: 10 });
			if (events.length > 0) {
				env.info(`  事件: ${events.map((e) => e.type).join(" → ")}`);
			}
			return;
		}
		// pi:widget 渲染(行内容与重构前一致;模型可控字段过 sanitize)
		const attempts = getAttemptsByStep(env.db, step.id);
		const events = getEvents(env.db, { stepId: step.id, limit: 20 });
		const expectations = parseExpectations(step.expectations).map(
			sanitizeTerminalText,
		);
		const lines = [
			`${stepIcon(step.status)} ${step.id} ${sanitizeTerminalText(step.title)}`,
			`  状态: ${step.status} | agent: ${step.agent} | wave: ${step.wave_id ?? "-"} | gate: ${step.gate}`,
			`  worktree: ${step.worktree ?? "-"} | tab: ${step.tab_id ?? "-"} | 重试: ${step.retries_done}/${step.max_retries}`,
			`  期望: ${expectations.length > 0 ? expectations.join(" | ") : "(未设定)"}`,
			`  回报: ${sanitizeTerminalText(step.report ?? "(无)")}`,
			`  错误: ${sanitizeTerminalText(step.error ?? "(无)")}`,
		];
		if (attempts.length > 0) {
			lines.push(`  尝试(${attempts.length}):`);
			for (const a of attempts) {
				lines.push(
					`    #${a.attempt_no} ${a.status} tab=${a.tab_id ?? "-"} ${a.finished_at ? `完成于 ${new Date(a.finished_at).toLocaleString()}` : ""}${a.error ? ` 错误: ${sanitizeTerminalText(a.error)}` : ""}`,
				);
			}
		}
		if (events.length > 0) {
			lines.push(
				`  事件: ${events.map((e) => `${e.type}${e.attempt_id ? `#${e.attempt_id}` : ""}`).join(" → ")}`,
			);
		}
		if (step.task_md) {
			lines.push(
				`  ── 任务正文 ──`,
				// 逐行净化:task_md 是多行 markdown,整段净化会把换行也吞掉
				...step.task_md.split("\n").map((l) => `  ${sanitizeTerminalText(l)}`),
			);
		}
		env.show(lines);
		env.notifyPi(`[wf] ${step.id} 详情已显示`);
	},
});

// ── events(双入口;CLI 含 --follow 轮询 + SIGINT)────────────
register({
	name: "events",
	description: "审计流",
	usage: "wf events [wfId] [N] [--follow]",
	widget: "workflow-events",
	run: (args, env) => {
		if (env.kind === "cli") {
			const parsed = parseArgs(args, [{ name: "--follow" }]);
			const follow = parsed.bool("--follow");
			const nums = parsed.positionals.filter((a) => /^\d+$/.test(a));
			const limit = nums[0] ? Number(nums[0]) : 30;
			const wfId = parsed.positionals.find((a) => !/^\d+$/.test(a));
			const show = (afterId: number): number => {
				const events = getEvents(env.db, {
					workflowId: wfId ?? undefined,
					limit,
					afterId: afterId || undefined,
				});
				for (const e of events.reverse()) {
					env.info(
						`${new Date(e.created_at).toLocaleTimeString()} ${e.type}${e.step_id ? ` ${e.step_id}` : ""}${e.attempt_id ? ` #${e.attempt_id}` : ""}`,
					);
				}
				return events.length > 0 ? events[events.length - 1].id : afterId;
			};
			let last = show(0);
			if (!follow) return;
			env.info("(跟随中,Ctrl+C 退出)");
			const timer = setInterval(() => {
				last = show(last);
			}, 3000);
			process.on("SIGINT", () => {
				clearInterval(timer);
				env.setExitCode(0);
			});
			return;
		}
		// pi:widget 渲染(无 follow)
		const limit = args.length > 1 && /^\d+$/.test(args[1]) ? Number(args[1]) : 30;
		const wfId =
			args[0] && !/^\d+$/.test(args[0])
				? resolveWorkflowId(env, args[0])
				: resolveWorkflowId(env);
		const events = getEvents(env.db, { workflowId: wfId ?? undefined, limit });
		const lines = events.map((e) => {
			const ts = new Date(e.created_at).toLocaleTimeString();
			return `${ts} ${e.type}${e.step_id ? ` ${e.step_id}` : ""}${e.attempt_id ? ` #${e.attempt_id}` : ""}`;
		});
		if (lines.length === 0) lines.push("(无事件)");
		env.show(lines);
		env.notifyPi(
			`[wf] 最近 ${lines.length} 条事件${wfId ? `(${wfId})` : "(全部)"}`,
		);
	},
});

// ── dispatch(双入口;入口差异见 §2.6 表 #1)──────────────────
register({
	name: "dispatch",
	description: "派发子任务(真实开 tab)",
	usage: "wf dispatch <dotted...> [--workflow <id>] [--dry-run]",
	run: async (args, env) => {
		const parsed = parseArgs(args, [
			{ name: "--dry-run" },
			{ name: "--workflow", value: true },
		]);
		const dryRun = parsed.bool("--dry-run");
		const explicitWf = parsed.value("--workflow");
		const tokens = parsed.positionals;
		const wfId = resolveWorkflowId(env, explicitWf);
		if (!wfId) {
			if (env.kind === "cli") {
				env.fail("无法确定 workflow(传 --workflow <id> 或在仓库根目录运行)");
				return;
			}
			const all = listWorkflows(env.db);
			env.warn(
				`无法确定 workflow(不在仓库根目录?):\n${all.map((w) => `  ${w.id} [${w.status}] ${w.repo_path}`).join("\n")}\n或显式 --workflow <id>`,
			);
			return;
		}
		const workflow = getWorkflow(env.db, wfId);
		if (!workflow) {
			env.fail(`workflow 不存在: ${wfId}`);
			return;
		}
		if (env.kind === "cli") {
			// CLI:逐 token 输出;无参数 = 派发当前 wave 全部就绪步骤(与 pi 分支一致);
			// per-token 错误只打印不置退出码(现状)
			const readyTokens =
				tokens.length === 0
					? getReadySteps(env.db, wfId).map((s) => s.id.slice(wfId.length + 1))
					: tokens;
			if (readyTokens.length === 0) {
				env.info(
					`wave ${workflow.current_wave} 无就绪步骤(依赖未完成或已全部派发)`,
				);
				return;
			}
			for (const token of readyTokens) {
				const step = getStep(env.db, token) ?? getStep(env.db, `${wfId}-${token}`);
				if (!step) {
					env.warn(`✗ ${token}: 步骤不存在`);
					continue;
				}
				const res = await dispatchStep(env.db, workflow, step, { dryRun });
				if (res.ok) {
					if (res.reused) {
						env.info(`✓ ${token}: tab 仍存活(可能误判),已恢复 running,未重开新 tab`);
					} else {
						env.info(
							res.dryRun
								? `◦ ${token}: [dry-run] worktree=${res.worktree}\n${res.pointer}`
								: `✓ ${token}: running tab=${res.tabId ? res.tabId.slice(0, 8) : "?"} worktree=${res.worktree}`,
						);
					}
				} else {
					env.warn(`✗ ${token}: ${res.error}`);
				}
			}
			return;
		}
		// pi:预算护栏(checkBudget→paused);无参数 = 派发当前 wave 全部就绪步骤;step.workflow_id 归属检查
		if (!dryRun) {
			const budget = checkBudget(env.db, workflow);
			if (!budget.ok) {
				updateWorkflowStatus(env.db, wfId, WORKFLOW_STATUS.paused);
				addEvent(env.db, {
					workflowId: wfId,
					type: EVT.workflowPaused,
					payload: { reason: budget.reason },
				});
				env.warn(`${budget.reason};workflow 已暂停(/wf resume 恢复)`);
				return;
			}
		}
		const readyTokens =
			tokens.length === 0
				? getReadySteps(env.db, wfId).map((s) => s.id.slice(wfId.length + 1))
				: tokens;
		if (readyTokens.length === 0) {
			env.info(`wave ${workflow.current_wave} 无就绪步骤(依赖未完成或已全部派发)`);
			return;
		}
		const results: string[] = [];
		for (const token of readyTokens) {
			const step: StepRow | undefined =
				getStep(env.db, token) ?? getStep(env.db, `${wfId}-${token}`);
			if (!step) {
				results.push(`✗ ${token}: 步骤不存在`);
				continue;
			}
			if (step.workflow_id !== wfId) {
				results.push(`✗ ${token}: 属于其他 workflow(${step.workflow_id})`);
				continue;
			}
			const res = await dispatchStep(env.db, workflow, step, { dryRun });
			if (res.ok) {
				results.push(
					res.dryRun
						? `◦ ${token}: [dry-run] worktree=${res.worktree} pointer:\n${res.pointer}`
						: `✓ ${token}: tab=${res.tabId ?? "?"} attempt=${res.attemptNo ?? "?"} worktree=${res.worktree}`,
				);
			} else {
				results.push(`✗ ${token}: ${res.error}`);
			}
		}
		env.info(results.join("\n\n"));
	},
});

// ── verify(双入口;pi 缺省 action = approve)─────────────────
register({
	name: "verify",
	description: "期望核对",
	usage: "wf verify <id> approve|reject [原因]",
	run: (args, env) => {
		const [token, action, ...rest] = args;
		if (!token) {
			if (env.kind === "cli") throw new UsageError();
			env.warn("用法: /wf verify <dotted> [approve|reject <原因>]");
			return;
		}
		const step = resolveStepId(env, token);
		if (!step) {
			env.fail(
				env.kind === "cli" ? `✗ 步骤不存在: ${token}` : `步骤不存在: ${token}`,
			);
			return;
		}
		if (env.kind === "pi") {
			if (action === "reject") {
				const res = verifyStep(env.db, step.id, "reject", rest.join(" "));
				if (!res.ok) {
					env.warn(res.error!);
					return;
				}
				env.warn(`已驳回 ${step.id} → needs-fix`);
			} else if (action === undefined || action === "approve") {
				const res = verifyStep(env.db, step.id, "approve");
				if (!res.ok) {
					env.warn(res.error!);
					return;
				}
				env.info(`已核对通过 ${step.id} → done`);
			} else {
				env.warn(`未知动作: ${action}(approve|reject)`);
			}
			return;
		}
		if (action !== "approve" && action !== "reject") throw new UsageError();
		const res = verifyStep(env.db, step.id, action, rest.join(" "));
		if (!res.ok) {
			env.fail(`✗ ${res.error}`);
			return;
		}
		env.info(`✓ ${step.id} → ${res.status}`);
	},
});

// ── merge(双入口;pi 成功行追加 skipped)─────────────────────
register({
	name: "merge",
	description: "合并 wave 回主分支",
	usage: "wf merge [--wave N]",
	run: async (args, env) => {
		const parsed = parseArgs(args, [{ name: "--wave", value: true }]);
		const explicitWave =
			parsed.value("--wave") === undefined
				? undefined
				: Number(parsed.value("--wave"));
		const explicitWf = parsed.positionals.find((a) => !/^\d+$/.test(a));
		const wfId = resolveWorkflowId(env, explicitWf);
		if (!wfId) {
			env.fail(
				env.kind === "cli"
					? "无法确定 workflow(传 id 或在仓库根目录运行)"
					: "无法确定 workflow(在仓库根目录运行,或显式传 workflow id)",
			);
			return;
		}
		const workflow = getWorkflow(env.db, wfId);
		if (!workflow) {
			env.fail(`workflow 不存在: ${wfId}`);
			return;
		}
		const waveSeq = explicitWave ?? workflow.current_wave;
		const res = await mergeWave(env.db, workflow, waveSeq);
		if (res.ok) {
			if (env.kind === "cli") {
				env.info(
					`✓ wave ${res.wave} 合并完成:${res.merged.length} 个步骤合回主分支`,
				);
			} else {
				env.info(
					`wave ${waveSeq} 合并完成:${res.merged.length} 个步骤合回主分支${res.skipped > 0 ? `,${res.skipped} 个跳过` : ""}`,
				);
			}
			return;
		}
		if (env.kind === "cli") {
			env.fail(`✗ wave ${res.wave} 合并未完成: ${res.error}`);
			return;
		}
		env.warn(`wave ${waveSeq} 合并未完成: ${res.error}`);
	},
});

// ── retry(双入口)───────────────────────────────────────────
register({
	name: "retry",
	description: "重派失败/中止/待修步骤(--fresh 重建 worktree)",
	usage: "wf retry <id> [--fresh]",
	run: async (args, env) => {
		const parsed = parseArgs(args, [{ name: "--fresh" }]);
		const fresh = parsed.bool("--fresh");
		const token = parsed.positionals[0];
		if (!token) {
			if (env.kind === "cli") throw new UsageError();
			env.warn("用法: /wf retry <dotted> [--fresh]");
			return;
		}
		const step = resolveStepId(env, token);
		if (!step) {
			env.fail(
				env.kind === "cli" ? `✗ 步骤不存在: ${token}` : `步骤不存在: ${token}`,
			);
			return;
		}
		if (!["failed", "aborted", "needs-fix"].includes(step.status)) {
			if (env.kind === "cli") {
				env.fail(`✗ 状态 ${step.status} 无需重试(仅 failed/aborted/needs-fix)`);
				return;
			}
			env.warn(`状态 ${step.status} 无需重试(仅 failed/aborted/needs-fix)`);
			return;
		}
		const workflow = getWorkflow(env.db, step.workflow_id);
		if (!workflow) {
			env.fail(
				env.kind === "cli"
					? `✗ workflow 不存在: ${step.workflow_id}`
					: `workflow 不存在: ${step.workflow_id}`,
			);
			return;
		}
		const res = await dispatchStep(env.db, workflow, step, { fresh });
		if (res.ok) {
			if (res.reused) {
				env.info(`✓ ${step.id} tab 仍存活(可能误判),已恢复 running,未重开新 tab`);
			} else if (env.kind === "cli") {
				env.info(
					`✓ 已重派 ${step.id}${fresh ? "(--fresh)" : ""} tab=${res.tabId ? res.tabId.slice(0, 8) : "?"}`,
				);
			} else {
				env.info(
					`已重派 ${step.id}${fresh ? "(--fresh 重建 worktree)" : ""} tab=${res.tabId ? res.tabId.slice(0, 8) : "?"}`,
				);
			}
			return;
		}
		if (env.kind === "cli") {
			env.fail(`✗ 重派失败: ${res.error}`);
			return;
		}
		env.warn(`重派失败: ${res.error}`);
	},
});

// ── rebind-window(双入口;取焦点窗口的机制 CLI=execFileSync / pi=run,文案一致)──
register({
	name: "rebind-window",
	description: "重新绑定窗口(绑定窗口已关闭时)",
	usage: "wf rebind-window [wfId]",
	run: async (args, env) => {
		const explicitWf = args.find((a) => !a.startsWith("--"));
		const wfId = resolveWorkflowId(env, explicitWf);
		if (!wfId) {
			env.fail(
				env.kind === "cli"
					? "无法确定 workflow(传 <id> 或在仓库根目录运行)"
					: "无法确定 workflow(不在仓库根目录?或显式 /wf rebind-window <workflow-id>)",
			);
			return;
		}
		const workflow = getWorkflow(env.db, wfId);
		if (!workflow) {
			env.fail(`workflow 不存在: ${wfId}`);
			return;
		}
		// 取当前焦点窗口 id(layout 查询的 front 标记)
		let layout;
		try {
			layout = await layoutJson();
		} catch (e) {
			env.fail(`Ghostty layout 查询失败: ${(e as Error).message}`);
			return;
		}
		const windows = layout.windows;
		if (windows.length === 0) {
			env.fail("Ghostty layout 无窗口信息");
			return;
		}
		const target = windows.find((w) => w.front) ?? windows[0];
		const old =
			(getWorkflowMeta(env.db, wfId, WF_WINDOW_META_KEY) as string | undefined) ??
			"(未绑定)";
		setWorkflowMeta(env.db, wfId, WF_WINDOW_META_KEY, target.id);
		addEvent(env.db, {
			workflowId: wfId,
			type: EVT.workflowWindowRebound,
			payload: { key: WF_WINDOW_META_KEY, from: old, to: target.id },
		});
		env.info(`✓ ${wfId} 绑定窗口: ${old} → ${target.id}(当前焦点窗口)`);
	},
});

// ── plan(双入口;dry-run 与成功文案差异见 §2.6 表 #6)─────────
register({
	name: "plan",
	description: "planner 自动拆解(无 id=新建,有 id=追加 gap wave)",
	usage: 'wf plan "<需求目标>" [--repo <path>] [--workflow <id>] [--dry-run]',
	widget: "workflow-plan",
	run: async (args, env) => {
		const parsed = parseArgs(args, [
			{ name: "--dry-run" },
			{ name: "--repo", value: true },
			{ name: "--workflow", value: true },
		]);
		const dryRun = parsed.bool("--dry-run");
		const repoPath = parsed.value("--repo") ?? env.cwd;
		const explicitWf = parsed.value("--workflow");
		const request = parsed.positionals.join(" ");
		if (!request.trim()) {
			// 空态引导(P0-5):无目标时给出用法 + plan.json 模板
			if (env.kind === "cli") throw new UsageError(PLAN_TEMPLATE_HINT);
			env.warn(
				`用法: /wf plan "<需求目标>" [--repo <path>] [--workflow <id>] [--dry-run]\n\n${PLAN_TEMPLATE_HINT}`,
			);
			return;
		}
		env.info(`[wf] planner 拆解中:"${request.slice(0, 60)}"…`);
		let result;
		try {
			result = await planFromGoal(repoPath, request);
		} catch (e) {
			env.fail(
				env.kind === "cli"
					? `✗ planner 失败: ${(e as Error).message}`
					: `planner 失败: ${(e as Error).message}`,
			);
			return;
		}
		const planText = JSON.stringify(result.plan, null, 2);
		if (dryRun) {
			env.show(sanitizeTerminalLines(planText.split("\n")));
			if (env.kind === "pi") {
				env.notifyPi("[wf] planner 输出已显示(--dry-run,未落库)");
			}
			return;
		}
		const plan = result.plan as PlanInput;
		if (
			typeof plan !== "object" ||
			plan === null ||
			!plan.name ||
			!Array.isArray(plan.steps)
		) {
			env.fail(
				`${env.kind === "cli" ? "✗ " : ""}planner 输出缺少 name/steps:\n${result.output.slice(0, 500)}`,
			);
			return;
		}
		if (explicitWf) {
			const wf = getWorkflow(env.db, explicitWf);
			const appendRes = appendSteps(
				env.db,
				explicitWf,
				wf?.current_wave ?? 1,
				plan,
				env.cwd,
			);
			if (!appendRes.ok) {
				env.fail(
					`${env.kind === "cli" ? "✗ " : ""}追加失败:\n${appendRes.errors?.slice(0, 10).join("\n")}`,
				);
				return;
			}
			if (env.kind === "cli") {
				env.info(`✓ 已向 ${explicitWf} 追加 ${appendRes.added} 个步骤`);
				return;
			}
			env.info(
				`✓ 已向 ${explicitWf} 追加 ${appendRes.added} 个步骤(wave ${getWorkflow(env.db, explicitWf)?.current_wave}),可 /wf dispatch 派发`,
			);
			return;
		}
		const importRes = importPlan(env.db, plan, repoPath);
		if (!importRes.ok) {
			env.fail(
				`${env.kind === "cli" ? "✗ " : ""}计划校验失败:\n${importRes.errors?.slice(0, 10).join("\n")}`,
			);
			return;
		}
		if (env.kind === "cli") {
			env.info(
				`✓ 已生成 workflow ${importRes.workflowId}:${importRes.stepCount} 步(wave ${importRes.wave})`,
			);
			return;
		}
		env.info(
			`✓ 已生成 workflow ${importRes.workflowId}:${importRes.stepCount} 步(wave ${importRes.wave}),可 /wf dispatch 派发`,
		);
	},
});

// ── goal-check(双入口;CLI 直写库,pi 走 orchestrator,现状保留)──
register({
	name: "goal-check",
	description: "目标把关(verifying→completed/gap wave)",
	usage: "wf goal-check [approve|reject <原因>]",
	widget: "workflow-goal-check",
	run: (args, env) => {
		const parsed = parseArgs(args, [{ name: "--workflow", value: true }]);
		const explicitWf = parsed.value("--workflow");
		const [action, ...rest] = parsed.positionals;
		const wfId = resolveWorkflowId(env, explicitWf);
		if (!wfId) {
			env.fail(
				env.kind === "cli"
					? "无法确定 workflow(传 id 或在仓库根目录运行)"
					: "无法确定 workflow(在仓库根目录运行,或显式传 workflow id)",
			);
			return;
		}
		const workflow = getWorkflow(env.db, wfId);
		if (!workflow) {
			env.fail(`workflow 不存在: ${wfId}`);
			return;
		}
		if (action === undefined) {
			if (env.kind === "cli") {
				updateWorkflowStatus(env.db, wfId, WORKFLOW_STATUS.verifying);
				addEvent(env.db, {
					workflowId: wfId,
					type: EVT.workflowGoalCheckStarted,
				});
				env.info(`[${wfId}] 已进入目标核对(verifying)`);
				env.info(`最初目标: ${workflow.goal}`);
				for (const s of getStepsByWorkflow(env.db, wfId)) {
					env.info(
						`  ${s.id} [${s.status}] summary=${s.summary ?? "-"} issues=${s.issues ?? "-"} tests=${s.tests ?? "-"}`,
					);
				}
				env.info(`核对: wf goal-check approve | wf goal-check reject <原因>`);
				return;
			}
			const r = goalCheckEnter(env.db, wfId);
			if (!r.ok) {
				env.fail(r.error!);
				return;
			}
			const steps = getStepsByWorkflow(env.db, wfId);
			const lines = [
				`[${wfId}] 目标核对(verifying)`,
				``,
				`最初目标: ${workflow.goal}`,
				``,
				...steps.map(
					(s) =>
						`${stepIcon(s.status)} ${s.id} ${s.title}\n    summary: ${s.summary ?? "-"}\n    issues: ${s.issues ?? "-"} | tests: ${s.tests ?? "-"}`,
				),
				``,
				`核对通过 → /wf goal-check approve;未达成 → /wf goal-check reject <原因>(拆 gap wave)`,
			];
			env.show(lines);
			env.notifyPi(
				"[wf] 已进入目标核对(verifying),请对照最初目标 approve / reject",
			);
			return;
		}
		if (action === "approve") {
			if (env.kind === "cli") {
				buildUpdate(
					env.db,
					"workflow",
					{
						goal_check: JSON.stringify({
							result: "passed",
							reason: rest.join(" "),
							checkedAt: Date.now(),
						}),
						updated_at: Date.now(),
					},
					{ id: wfId },
				);
				addEvent(env.db, {
					workflowId: wfId,
					type: EVT.workflowGoalCheckPassed,
					payload: { reason: rest.join(" ") },
				});
				// master-agent 模式:目标把关通过 → awaiting-merge(等发起方决定合并)
				if (isMasterMode(env.db, wfId)) {
					updateWorkflowStatus(env.db, wfId, WORKFLOW_STATUS.awaitingMerge);
					addEvent(env.db, {
						workflowId: wfId,
						type: EVT.masterDone,
						payload: { reason: rest.join(" ") },
					});
				} else {
					updateWorkflowStatus(env.db, wfId, WORKFLOW_STATUS.completed);
				}
				// 目标把关已完成 → 标记 workflow-done 已通知(防下次会话补发过时提醒)
				markNotified(env.db, {
					workflowId: wfId,
					kind: "workflow-done",
					text: "",
				});
			} else {
				const r = goalCheckApprove(env.db, wfId, rest.join(" "));
				if (!r.ok) {
					env.fail(r.error!);
					return;
				}
			}
			env.info(
				isMasterMode(env.db, wfId)
					? `✓ ${wfId} 目标核对通过 → 已通知发起方(awaiting-merge,发起方可 /wf master-merge ${wfId})`
					: `✓ ${wfId} 目标核对通过 → completed`,
			);
			return;
		}
		if (action === "reject") {
			if (env.kind === "cli") {
				const reason = rest.join(" ") || "(未说明)";
				buildUpdate(
					env.db,
					"workflow",
					{
						goal_check: JSON.stringify({
							result: "failed",
							reason,
							checkedAt: Date.now(),
						}),
						updated_at: Date.now(),
					},
					{ id: wfId },
				);
				updateWorkflowStatus(env.db, wfId, WORKFLOW_STATUS.running);
				addEvent(env.db, {
					workflowId: wfId,
					type: EVT.workflowGoalCheckFailed,
					payload: { reason },
				});
				env.info(`✗ ${wfId} 目标未达成 → 回到 running;/wf next 拆 gap wave`);
				return;
			}
			const r = goalCheckReject(env.db, wfId, rest.join(" "));
			if (!r.ok) {
				env.fail(r.error!);
				return;
			}
			env.warn(`${wfId} 目标未达成 → 回到 running;/wf next 拆 gap wave 补齐`);
			return;
		}
		if (env.kind === "cli") throw new UsageError();
		env.warn("用法: /wf goal-check [approve|reject <原因>]");
	},
});

// ── next(双入口;CLI 直写库,pi 走 orchestrator)──────────────
register({
	name: "next",
	description: "滚动到下一 wave",
	usage: "wf next [--note <说明>]",
	run: (args, env) => {
		const parsed = parseArgs(args, [{ name: "--note", value: "greedy" }]);
		const note = parsed.value("--note");
		const wfId = resolveWorkflowId(env, parsed.positionals[0]);
		if (!wfId) {
			env.fail(
				env.kind === "cli"
					? "无法确定 workflow(传 id 或在仓库根目录运行)"
					: "无法确定 workflow(在仓库根目录运行,或显式传 workflow id)",
			);
			return;
		}
		if (env.kind === "cli") {
			const workflow = getWorkflow(env.db, wfId);
			if (!workflow) {
				env.fail(`✗ workflow 不存在: ${wfId}`);
				return;
			}
			const waves = listWaves(env.db, wfId);
			const nextSeq = (waves.length > 0 ? waves[waves.length - 1].seq : 0) + 1;
			const wave = createWave(env.db, wfId, nextSeq, note);
			buildUpdate(
				env.db,
				"workflow",
				{ current_wave: nextSeq, updated_at: Date.now() },
				{ id: wfId },
			);
			addEvent(env.db, {
				workflowId: wfId,
				waveId: wave.id,
				type: EVT.waveStarted,
				payload: { wave: nextSeq, note: note ?? null },
			});
			env.info(
				`✓ wave ${nextSeq} 已创建${note ? `(${note})` : ""};wf plan --workflow ${wfId} 补步骤`,
			);
			return;
		}
		const r = nextWave(env.db, wfId, note);
		if (!r.ok) {
			env.fail(r.error!);
			return;
		}
		env.info(
			`wave ${r.seq} 已创建${note ? `(${note})` : ""};用 /wf plan --workflow ${wfId} 补步骤,或 /wf dispatch 派发`,
		);
	},
});

// ── done(双入口)────────────────────────────────────────────
register({
	name: "done",
	description: "回报(子任务侧)",
	usage: "wf done <id> '<JSON>'",
	run: (args, env) => {
		const [token, ...rest] = args;
		if (!token || rest.length === 0) {
			if (env.kind === "cli") throw new UsageError();
			env.warn(
				'用法: /wf done <dotted> \'{"summary":"...","filesChanged":[...],"tests":"passed"}\'',
			);
			return;
		}
		const step = resolveStepId(env, token);
		if (!step) {
			env.fail(
				env.kind === "cli" ? `✗ 步骤不存在: ${token}` : `步骤不存在: ${token}`,
			);
			return;
		}
		const parsed = parseJsonArg(rest.join(" "));
		if (!parsed.ok) {
			env.fail(env.kind === "cli" ? `✗ ${parsed.error}` : parsed.error!);
			return;
		}
		const res = reportDone(env.db, step.id, parsed.value);
		if (!res.ok) {
			env.fail(env.kind === "cli" ? `✗ ${res.error}` : res.error!);
			return;
		}
		if (env.kind === "cli") {
			env.info(`✓ ${step.id} → ${res.status}`);
			return;
		}
		env.info(
			res.status === "waiting-verify"
				? `已回报 ${step.id},等待编排者 /wf verify approve|reject`
				: `已回报 ${step.id},编排者将核对期望(或 /wf verify)`,
		);
	},
});

// ── fail(双入口)────────────────────────────────────────────
register({
	name: "fail",
	description: "标记失败(子任务侧)",
	usage: "wf fail <id> <原因>",
	run: (args, env) => {
		const [token, ...rest] = args;
		if (!token) {
			if (env.kind === "cli") throw new UsageError();
			env.warn("用法: /wf fail <dotted> <原因>");
			return;
		}
		const step = resolveStepId(env, token);
		if (!step) {
			env.fail(
				env.kind === "cli" ? `✗ 步骤不存在: ${token}` : `步骤不存在: ${token}`,
			);
			return;
		}
		const res = reportFail(env.db, step.id, rest.join(" ") || "(未说明)");
		if (!res.ok) {
			env.fail(env.kind === "cli" ? `✗ ${res.error}` : res.error!);
			return;
		}
		if (env.kind === "cli") {
			env.info(`✓ ${step.id} → failed`);
			return;
		}
		env.warn(`已标记失败 ${step.id}`);
	},
});

// ── clean(CLI 独有)─────────────────────────────────────────
register({
	name: "clean",
	description: "清理残留 worktree",
	usage: "wf clean",
	entry: "cli",
	run: (_args, env) => {
		const bin = resolveBin("gittree");
		const res = execFileSync(bin, ["list"], { encoding: "utf-8" });
		env.info(res.trim() || "(无 gittree worktree)");
		env.info(
			"提示:清理残留 worktree 用 gittree clean <name> --branch --force 或 clean all --yes(占用检测保护)",
		);
	},
});

// ── tabs(CLI 独有)──────────────────────────────────────────
register({
	name: "tabs",
	description: "子任务 tab 状态(存活判定)",
	usage: "wf tabs [workflowId] [--json]",
	entry: "cli",
	run: async (args, env) => {
		const parsed = parseArgs(args, [{ name: "--json" }]);
		const json = parsed.bool("--json");
		const wfArg = parsed.positionals[0];
		const workflowId = resolveWorkflowId(env, wfArg);
		const workflow = workflowId ? getWorkflow(env.db, workflowId) : undefined;
		if (!workflow) {
			env.fail(
				`✗ 无法确定 workflow: ${wfArg ?? "(未传 id,且 cwd 不在任何 workflow 仓库内)"}`,
			);
			return;
		}
		const steps = getStepsByWorkflow(env.db, workflow.id);
		const live = await fetchLiveTabIds();
		if (live === null) {
			env.fail(
				"✗ Ghostty layout 查询失败,无法判定 tab 存活(与 monitor 同口径:查询失败不算 tab 关闭)",
			);
			env.fail("  请用 wf doctor 检查 osascript/Ghostty 环境后重试");
			return;
		}
		const rows = steps.map((s) => ({
			id: s.id,
			status: s.status,
			tabId: s.tab_id,
			alive: Boolean(s.tab_id && live.has(s.tab_id)),
			worktree: s.worktree,
		}));
		const withTab = rows.filter((r) => r.tabId);
		const summary = {
			total: rows.length,
			withTab: withTab.length,
			alive: withTab.filter((r) => r.alive).length,
			closed: withTab.filter((r) => !r.alive).length,
		};
		if (json) {
			env.info(
				JSON.stringify({ workflowId: workflow.id, steps: rows, summary }, null, 2),
			);
			return;
		}
		for (const r of rows) {
			env.info(
				`${r.id} [${r.status}] tab=${r.tabId ? r.tabId.slice(0, 8) : "-"} 存活=${r.alive ? "yes" : "no"} worktree=${r.worktree ?? "-"}`,
			);
		}
		env.info(
			`共 ${summary.total} 步 | 有 tab ${summary.withTab} | 存活 ${summary.alive} | 已关 ${summary.closed}`,
		);
		if (summary.withTab > 0 && live.size === 0) {
			env.warn(
				"(提示:Ghostty layout 无任何存活 terminal,存活判定可能不准 — 可用 wf doctor 检查环境)",
			);
		}
	},
});

// ── inject(CLI 独有)────────────────────────────────────────
register({
	name: "inject",
	description: "向步骤 tab/终端注入指令+自动回车",
	usage: "wf inject <target> <text...>",
	entry: "cli",
	run: async (args, env) => {
		const [target, ...text] = args;
		if (!target || text.length === 0) throw new UsageError();
		const msg = text.join(" ");
		const step = resolveStepId(env, target);
		if (step) {
			if (!step.tab_id) {
				env.fail(
					`✗ 步骤 ${step.id} 无 tab(tab_id 为空);请 wf open-tab ${step.id} 或 wf fix-tab ${step.id} auto`,
				);
				return;
			}
			const res = await sendTextToTerminal(step.tab_id, msg);
			if (!res.ok) {
				env.fail(`✗ 注入失败: ${res.error ?? "未知错误"}`);
				return;
			}
			env.info(`✓ 已向 ${step.id} 的 tab 注入 ${msg.length} 字符`);
			return;
		}
		// 未命中任何步骤 → 按 terminal id 前缀直接注入(不查 DB,内部层负责前缀匹配)
		const res = await sendTextToTerminal(target, msg);
		if (!res.ok) {
			env.fail(`✗ 注入失败: ${res.error ?? "未知错误"}`);
			return;
		}
		env.info(`✓ 已向 terminal ${target} 注入 ${msg.length} 字符`);
	},
});

// ── poll(CLI 独有;退出码 0 达成 / 1 超时 / 2 不可达 / 3 用法)──
const POLL_TARGETS = new Set([
	"pending",
	"ready",
	"dispatched",
	"running",
	"reported",
	"waiting-verify",
	"done",
	"skipped",
	"failed",
	"aborted",
	"conflict",
	"needs-fix",
]);

register({
	name: "poll",
	description: "轮询直到达成/超时(0达成/1超时/2不可达/3用法)",
	usage: "wf poll [wf] [--until S] [--timeout T] [--interval I]",
	entry: "cli",
	run: (args, env) => {
		const parsed = parseArgs(args, [
			{ name: "--until", value: true },
			{ name: "--timeout", value: true },
			{ name: "--interval", value: true },
		]);
		const until = parsed.value("--until", "done")!;
		const timeout = Number(parsed.value("--timeout", "600"));
		const interval = Number(parsed.value("--interval", "5"));
		const wfArg = parsed.positionals[0];
		const wfId = resolveWorkflowId(env, wfArg);
		if (!wfId)
			throw new UsageError("✗ 无法确定 workflow(传 id 或在仓库根目录运行)");
		if (!getWorkflow(env.db, wfId)) {
			throw new UsageError(`✗ workflow 不存在: ${wfId}`);
		}
		if (!POLL_TARGETS.has(until)) {
			throw new UsageError(
				`✗ --until 非法: ${until}(合法取值: ${[...POLL_TARGETS].join("/")})`,
			);
		}
		if (!Number.isFinite(timeout) || timeout <= 0) {
			throw new UsageError("✗ --timeout 必须为正数秒");
		}
		if (!Number.isFinite(interval) || interval <= 0) {
			throw new UsageError("✗ --interval 必须为正数秒");
		}

		const start = Date.now();
		const deadline = start + timeout * 1000;
		const fmtCounts = (): string => {
			const counts = stepStatusCounts(env.db, wfId);
			return Object.entries(counts)
				.filter(([, n]) => n > 0)
				.map(([s, n]) => `${s} ${n}`)
				.join("/");
		};
		let timer: ReturnType<typeof setInterval> | undefined;
		// 用 exitCode + 自然退出而非 process.exit:pipe 下 exit 会截断未刷新的
		// stdout/stderr 缓冲(最后写入的 "wf retry" 提示行间歇性丢失,测试偶发失败)
		const finish = (code: number, text: string): void => {
			if (timer) clearInterval(timer);
			env.info(text);
			env.setExitCode(code);
		};
		// 返回 true = 已终态(finish 已调用,调用方不得再建 interval)
		const tick = (): boolean => {
			try {
				const steps = getStepsByWorkflow(env.db, wfId);
				const { reached, unreachable, notStarted } = pollTargetReached(
					steps,
					until,
				);
				const elapsed = Math.round((Date.now() - start) / 1000);
				env.warn(
					`t=${elapsed}s 状态=${fmtCounts() || "(无)"} 未派发 ${notStarted}`,
				);
				if (unreachable.length > 0) {
					env.warn("不可达步骤(需人工介入):");
					for (const id of unreachable) {
						env.warn(`  ✗ ${id} → wf step ${id} 看原因 → wf retry ${id}`);
					}
					finish(2, `不可达: ${unreachable.join(", ")}`);
					return true;
				}
				if (reached) {
					const summary =
						`达成(${until}${until === "skipped" ? "" : " 或 skipped"}): ` +
						`${fmtCounts() || "(无步骤)"}`;
					finish(0, summary);
					return true;
				}
				if (Date.now() >= deadline) {
					const pendingSteps = steps
						.filter((s) => !["done", "skipped"].includes(s.status))
						.map((s) => `${s.id}[${s.status}]`);
					finish(
						1,
						`超时(${timeout}s): 未达成 ${pendingSteps.length} 步: ${pendingSteps.join(", ") || "(无)"}`,
					);
					return true;
				}
				return false;
			} catch (e) {
				finish(1, `轮询异常: ${(e as Error).message}`);
				return true;
			}
		};
		// 首次 tick 即终态则不建 interval(否则 exitCode 已设但进程滞留,多跑一轮)
		if (!tick()) {
			timer = setInterval(() => {
				if (tick()) clearInterval(timer);
			}, interval * 1000);
		}
		process.on("SIGINT", () => {
			if (timer) clearInterval(timer);
			env.warn(
				`已中断(t=${Math.round((Date.now() - start) / 1000)}s),当前状态: ${fmtCounts() || "(无)"}`,
			);
			env.setExitCode(130);
		});
	},
});

// ── session(CLI 独有)───────────────────────────────────────
register({
	name: "session",
	description: "读主控 pi 会话最近文本(按 cwd 编码定位)",
	usage: "wf session [wf|--last] [-n N] [--json]",
	entry: "cli",
	run: (args, env) => {
		const parsed = parseArgs(args, [
			{ name: "-n", value: true },
			{ name: "--json" },
			{ name: "--last" },
		]);
		const json = parsed.bool("--json");
		const n = Number(parsed.value("-n", "20"));
		if (!Number.isFinite(n) || n < 0) {
			throw new UsageError("✗ -n 必须为非负整数");
		}
		const wfArg = parsed.positionals[0];
		let cwd: string;
		if (wfArg && wfArg !== "--last") {
			const wf = getWorkflow(env.db, wfArg);
			if (!wf) {
				throw new UsageError(`✗ workflow 不存在: ${wfArg}`);
			}
			cwd = wf.repo_path;
		} else if (wfArg === "--last") {
			// --last:强制按当前 cwd 定位,不解析 workflow(现状 --last 不进 positionals,本分支为保留形态)
			cwd = env.cwd;
		} else {
			// 无参数:先按 cwd 推断 workflow → repo_path;推断不出用 cwd 本身
			const wfId = resolveWorkflowId(env);
			const wf = wfId ? getWorkflow(env.db, wfId) : undefined;
			cwd = wf?.repo_path ?? env.cwd;
		}

		const sessionsRoot =
			process.env.WF_SESSIONS_DIR ??
			path.join(os.homedir(), ".pi", "agent", "sessions");
		const file = findLatestSessionFile(sessionsRoot, cwd);
		if (!file) {
			env.fail(`✗ 无会话文件(${path.join(sessionsRoot, encodeSessionDir(cwd))})`);
			return;
		}
		const messages: Array<{ ts: string; role: string; text: string }> = [];
		for (const raw of fs.readFileSync(file, "utf-8").split("\n")) {
			const m = parseSessionLine(raw);
			if (m) messages.push(m);
		}
		const recent = messages.slice(-n);
		const truncate = (t: string): string =>
			t.length > 500 ? `${t.slice(0, 500)}…(截断)` : t;
		if (json) {
			env.info(
				JSON.stringify(
					recent.map((m) => ({
						ts: m.ts,
						role: m.role,
						text: truncate(m.text),
					})),
					null,
					2,
				),
			);
			return;
		}
		if (recent.length === 0) {
			env.info("(无消息)");
			return;
		}
		for (const m of recent) {
			const time = new Date(m.ts);
			const hhmmss = Number.isNaN(time.getTime())
				? "--:--:--"
				: time.toTimeString().slice(0, 8);
			const label = m.role === "notify" ? "[notify]" : `${m.role}:`;
			env.info(`[${hhmmss}] ${label} ${truncate(m.text)}`);
		}
	},
});

// ── open-tab(CLI 独有)──────────────────────────────────────
register({
	name: "open-tab",
	description: "手动补开子任务 tab(绑 worktree/窗口,恢复 running)",
	usage: "wf open-tab <stepId>",
	entry: "cli",
	run: async (args, env) => {
		const token = args[0];
		if (!token) throw new UsageError();
		const step = resolveStepId(env, token);
		if (!step) {
			env.fail(`✗ 步骤不存在: ${token}(wf step ${token} 核对 id)`);
			return;
		}
		const workflow = getWorkflow(env.db, step.workflow_id);
		if (!workflow) {
			env.fail(`✗ workflow 不存在: ${step.workflow_id}`);
			return;
		}
		const dotted = step.id.slice(workflow.id.length + 1);
		const wtPath = worktreePath(workflow.repo_path, workflow.id, dotted);
		if (!step.worktree || !fs.existsSync(wtPath)) {
			env.fail(
				`✗ 步骤 ${step.id} 无 worktree 或目录不存在(${wtPath});先 /wf dispatch ${step.id} 或 /wf retry ${step.id}(open-tab 只补 tab 层,不重建 worktree)`,
			);
			return;
		}
		// 已绑定且 tab 存活 → 无需重开(layout 查询失败时保守重开并提示)
		if (step.tab_id) {
			const live = await fetchLiveTabIds();
			if (live === null) {
				env.warn(
					"⚠ Ghostty layout 查询失败,无法确认旧 tab 是否存活;仍尝试重开(旧 tab 若还活着请手动关闭)",
				);
			} else if (live.has(step.tab_id)) {
				env.fail(
					`✗ 步骤 ${step.id} 已绑定 tab ${step.tab_id.slice(0, 8)} 且存活,无需重开;若状态不对用 wf fix-tab ${step.id} <terminalId>`,
				);
				return;
			}
		}
		// 新 attempt 行(冻结 task_md + pointer),成功后由 openStepTab 回写 tab_id
		const pointer = buildPointer(workflow.id, dotted, workflow.current_wave || 1);
		const attempt = createAttempt(env.db, step.id, {
			taskMd: step.task_md,
			pointer,
		});
		const res = await openStepTab(env.db, workflow, step, {
			attemptId: attempt.id,
			manual: true,
		});
		if (!res.ok) {
			buildUpdate(
				env.db,
				"workflow_attempts",
				{ status: "aborted", error: res.error, finished_at: Date.now() },
				{ id: attempt.id },
			);
			env.fail(`✗ open-tab 失败: ${res.error}`);
			return;
		}
		env.info(
			`✓ ${step.id} tab=${res.tabId ? res.tabId.slice(0, 8) : "?"} manual`,
		);
	},
});

// ── fix-tab(CLI 独有)───────────────────────────────────────
register({
	name: "fix-tab",
	description: "修复步骤 tab 状态(排查用,只改 DB 状态)",
	usage: "wf fix-tab <stepId> <tid|auto>",
	entry: "cli",
	run: async (args, env) => {
		const [token, tid] = args;
		if (!token || !tid) throw new UsageError();
		const step = resolveStepId(env, token);
		if (!step) {
			env.fail(`✗ 步骤不存在: ${token}`);
			return;
		}
		// 状态机校验:fix-tab 仅限可恢复为 running 的状态(终态拒绝)
		if (!canTransition(step.status, "running")) {
			env.fail(
				`✗ 状态迁移非法: ${step.id} ${step.status} → running;允许: ${legalTargets(step.status).join(", ")}`,
			);
			return;
		}
		const workflow = getWorkflow(env.db, step.workflow_id);
		if (!workflow) {
			env.fail(`✗ workflow 不存在: ${step.workflow_id}`);
			return;
		}
		const dotted = step.id.slice(workflow.id.length + 1);
		const wtPath = worktreePath(workflow.repo_path, workflow.id, dotted);
		let fullId: string | null = null;
		let mode: "auto" | "explicit" = "auto";
		if (tid === "auto") {
			fullId = await findTerminalId(null, wtPath);
			if (!fullId) {
				env.fail(
					`✗ layout 中无该 worktree 对应终端(${wtPath});请用 wf open-tab ${step.id} 重开`,
				);
				return;
			}
		} else {
			mode = "explicit";
			const live = await fetchLiveTabIds();
			if (live === null) {
				env.fail(
					"✗ Ghostty layout 查询失败,无法校验 terminal id;请用 auto 或 wf open-tab 重开",
				);
				return;
			}
			const matches = [...live].filter((id) => id.startsWith(tid));
			if (matches.length === 0) {
				env.fail(
					`✗ layout 中无 terminal 前缀 ${tid};请用 auto 或 wf open-tab ${step.id} 重开`,
				);
				return;
			}
			if (matches.length > 1) {
				env.fail(
					`✗ terminal 前缀 ${tid} 不唯一(${matches.join(", ")});请用完整 id 或 auto`,
				);
				return;
			}
			fullId = matches[0];
		}
		const from = `${step.status}/${step.tab_id ? step.tab_id.slice(0, 8) : "-"}`;
		buildUpdate(
			env.db,
			"workflow_steps",
			{ tab_id: fullId, status: "running", updated_at: Date.now() },
			{ id: step.id },
		);
		addEvent(env.db, {
			workflowId: workflow.id,
			stepId: step.id,
			type: EVT.stepTabFixed,
			payload: { from: step.tab_id, to: fullId, mode },
		});
		env.info(`修复前 ${from} → 修复后 running/${fullId}(mode=${mode})`);
		env.info(
			"提示:fix-tab 仅对齐 DB 状态,请人工确认该终端里子 pi 实际在运行;若终端已关闭请 wf open-tab 重开",
		);
	},
});

// ── cleanup(CLI 独有)───────────────────────────────────────
/** 终态步骤(done/skipped)判定 */
const TERMINAL_OK = new Set(["done", "skipped"]);

interface CleanupSummary {
	closedTabs: number;
	cleanedPiglla: number;
	gitignoreAppended: boolean;
	gitignoreMissing: boolean;
	warnings: number;
}

register({
	name: "cleanup",
	description: "关终态 tab + 清 .pi-glla + 合并前置修复",
	usage: "wf cleanup [workflowId] [--dry-run] [--no-fix]",
	entry: "cli",
	run: async (args, env) => {
		const parsed = parseArgs(args, [{ name: "--dry-run" }, { name: "--no-fix" }]);
		const dryRun = parsed.bool("--dry-run");
		const noFix = parsed.bool("--no-fix");
		const wfArg = parsed.positionals[0];
		const workflowId = resolveWorkflowId(env, wfArg);
		const workflow = workflowId ? getWorkflow(env.db, workflowId) : undefined;
		if (!workflow) {
			env.fail(
				`✗ 无法确定 workflow: ${wfArg ?? "(未传 id,且 cwd 不在任何 workflow 仓库内)"}`,
			);
			return;
		}
		const prefix = dryRun ? "[dry-run] " : "";
		const steps = getStepsByWorkflow(env.db, workflow.id);
		const summary: CleanupSummary = {
			closedTabs: 0,
			cleanedPiglla: 0,
			gitignoreAppended: false,
			gitignoreMissing: false,
			warnings: 0,
		};
		const warn = (msg: string): void => {
			summary.warnings++;
			env.warn(`  ⚠ ${msg}`);
		};

		// 1. 关终态 tab
		const live = await fetchLiveTabIds();
		// 查询失败:绝不关闭任何 tab(与 monitor 同口径:查询失败不算 tab 关闭),其余清理继续
		const canJudgeTabs = live !== null;
		if (!canJudgeTabs) {
			warn(
				"Ghostty layout 查询失败,跳过「关闭终态 tab」步骤(不关闭任何 tab);其余清理继续",
			);
		}
		for (const s of steps) {
			if (!canJudgeTabs || !s.tab_id || !TERMINAL_OK.has(s.status)) continue;
			if (!live?.has(s.tab_id)) continue; // 已不在布局中,无需动作
			if (dryRun) {
				env.info(`${prefix}关闭终态 tab: ${s.id} (${s.tab_id.slice(0, 8)})`);
				summary.closedTabs++;
				continue;
			}
			try {
				await closeTerminal(s.tab_id);
			} catch (e) {
				warn(
					`${s.id}: close-terminal 失败: ${e instanceof Error ? e.message : String(e)}`,
				);
				continue;
			}
			addEvent(env.db, {
				workflowId: workflow.id,
				stepId: s.id,
				type: EVT.stepTabClosed,
				payload: { tabId: s.tab_id, reason: "cleanup" },
			});
			buildUpdate(
				env.db,
				"workflow_steps",
				{ tab_id: null, updated_at: Date.now() },
				{ id: s.id },
			);
			env.info(`${prefix}关闭终态 tab: ${s.id} (${s.tab_id.slice(0, 8)})`);
			summary.closedTabs++;
		}

		// 2. 清 .pi-glla(路径守卫 + 跟踪检查;运行中/待核对的步骤跳过,不打扰在跑的会话)
		const worktreesGuard = path.join(workflow.repo_path, ".worktrees");
		const ACTIVE_STATES = new Set([
			"pending",
			"ready",
			"dispatched",
			"running",
			"reported",
			"waiting-verify",
		]);
		for (const s of steps) {
			if (!s.worktree) continue;
			if (ACTIVE_STATES.has(s.status)) {
				env.info(`${prefix}跳过 .pi-glla: ${s.id} (状态 ${s.status},运行中不打扰)`);
				continue;
			}
			const dotted = s.id.slice(workflow.id.length + 1);
			const wtPath = worktreePath(workflow.repo_path, workflow.id, dotted);
			// 守卫:只处理 <repo>/.worktrees/gittree-* 下的目录,防误删
			if (
				!wtPath.startsWith(worktreesGuard + path.sep) ||
				!path.basename(wtPath).startsWith("gittree-")
			) {
				warn(`${s.id}: worktree 路径不在守卫范围内,跳过: ${wtPath}`);
				continue;
			}
			const piglla = path.join(wtPath, ".pi-glla");
			if (!fs.existsSync(piglla)) continue;
			// 跟踪检查:被误提交进 git 则只警告,不自动改索引
			let tracked = false;
			try {
				const ls = execFileSync("git", ["-C", wtPath, "ls-files", ".pi-glla"], {
					encoding: "utf-8",
				}).trim();
				tracked = ls.length > 0;
			} catch {
				warn(`${s.id}: git ls-files 检查失败,跳过 .pi-glla`);
				continue;
			}
			if (tracked) {
				warn(
					`${s.id}: ${wtPath} 的 .pi-glla 已被 git 跟踪,不自动删除;请 git rm -r --cached .pi-glla 后在各 worktree 提交`,
				);
				continue;
			}
			if (!dryRun) {
				fs.rmSync(piglla, { recursive: true, force: true });
			}
			env.info(
				`${prefix}清理 .pi-glla: ${s.id} (${path.relative(workflow.repo_path, piglla)})`,
			);
			summary.cleanedPiglla++;
		}

		// 3. .gitignore 自动修复(合并前置,根治 untracked 冲突)
		const giPath = path.join(workflow.repo_path, ".gitignore");
		const giContent = fs.existsSync(giPath)
			? fs.readFileSync(giPath, "utf-8")
			: "";
		const giLines = giContent.split("\n");
		const hasEntry = giLines.some(
			(l) => l.trim() === ".pi-glla/" || l.trim() === ".pi-glla",
		);
		if (!hasEntry) {
			summary.gitignoreMissing = true;
			if (noFix) {
				warn(
					`仓库根 .gitignore 缺 .pi-glla/(--no-fix 未修改);建议手动追加后再 /wf merge`,
				);
			} else if (dryRun) {
				summary.gitignoreAppended = true;
				env.info(
					`${prefix}.gitignore 追加 .pi-glla/(${path.relative(workflow.repo_path, giPath)})`,
				);
			} else {
				const add = `${giContent && !giContent.endsWith("\n") ? "\n" : ""}# pi-workflow: 子 pi 运行时状态(防 merge 冲突)\n.pi-glla/\n`;
				fs.appendFileSync(giPath, add);
				summary.gitignoreAppended = true;
				env.info(
					`${prefix}.gitignore 追加 .pi-glla/(${path.relative(workflow.repo_path, giPath)})`,
				);
			}
		}

		// 4. 终态 worktree 未提交改动检查(排除 .pi-glla,不自动 commit)
		for (const s of steps) {
			if (!s.worktree || !TERMINAL_OK.has(s.status)) continue;
			const dotted = s.id.slice(workflow.id.length + 1);
			const wtPath = worktreePath(workflow.repo_path, workflow.id, dotted);
			if (!fs.existsSync(wtPath)) continue;
			try {
				const out = execFileSync("git", ["-C", wtPath, "status", "--porcelain"], {
					encoding: "utf-8",
				}).trim();
				const dirty = out
					.split("\n")
					.filter(Boolean)
					.filter((l) => {
						const p = l.length > 3 ? l.slice(3) : l;
						return !p.startsWith(".pi-glla") && !p.includes("/.pi-glla");
					});
				if (dirty.length > 0) {
					warn(
						`${s.id}: worktree 有 ${dirty.length} 处未提交改动(合并前请自行 commit):`,
					);
					for (const l of dirty.slice(0, 10)) env.warn(`    ${l}`);
				}
			} catch {
				warn(`${s.id}: git status 检查失败(worktree 可能已失效)`);
			}
		}

		// 5. 摘要
		let giState = "否";
		if (summary.gitignoreAppended) giState = "是";
		else if (summary.gitignoreMissing) giState = "缺,未改";
		env.info(
			`${prefix}关闭 tab ${summary.closedTabs} | 清理 .pi-glla ${summary.cleanedPiglla} | .gitignore 追加(${giState}) | 警告 ${summary.warnings}`,
		);
		if (summary.warnings > 0) {
			env.info(
				"  提示:警告项需人工确认;关闭的 tab 不影响重新派发(重派会开新 tab)",
			);
		}
		env.info("现在可 /wf merge");
	},
});

// ── doctor(CLI 独有)────────────────────────────────────────
register({
	name: "doctor",
	description: "环境自检",
	usage: "wf doctor",
	entry: "cli",
	run: (_args, env) => {
		const checks: Array<[string, boolean, string]> = [];
		checks.push([
			"node 版本 ≥ 22.13",
			Number(process.versions.node.split(".")[0]) >= 22,
			process.version,
		]);
		checks.push(["node:sqlite 可用", true, DB_PATH]);
		const gittree = resolveBin("gittree");
		checks.push(["gittree 可执行", fs.existsSync(gittree), gittree]);
		const osa = "/usr/bin/osascript";
		checks.push([
			"osascript 可用(macOS Ghostty 控制层)",
			fs.existsSync(osa),
			`${osa}${process.env.WF_OSA_BIN ? `(WF_OSA_BIN=${process.env.WF_OSA_BIN})` : ""}`,
		]);
		const ver = (
			env.db.prepare("PRAGMA user_version").get() as { user_version: number }
		).user_version;
		checks.push(["数据库可打开(user_version)", ver >= 1, `v${ver} @ ${DB_PATH}`]);
		let okAll = true;
		for (const [name, ok, detail] of checks) {
			env.info(`${ok ? "✓" : "✗"} ${name}${ok ? "" : " ← 需修复"}`);
			env.info(`    ${detail}`);
			if (!ok) okAll = false;
		}
		env.info(okAll ? "\n环境正常" : "\n存在环境问题,见上");
	},
});

// ── debug(CLI 独有)─────────────────────────────────────────
register({
	name: "debug",
	description: "诊断信息",
	usage: "wf debug",
	entry: "cli",
	run: (_args, env) => {
		const ver = (
			env.db.prepare("PRAGMA user_version").get() as { user_version: number }
		).user_version;
		env.info(`DB: ${DB_PATH} (schema v${ver})`);
		const tables = env.db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'workflow%' ORDER BY name",
			)
			.all() as Array<{ name: string }>;
		env.info(`表(${tables.length}): ${tables.map((t) => t.name).join(", ")}`);
		const wfs = listWorkflows(env.db);
		env.info(`workflows(${wfs.length}):`);
		for (const w of wfs) {
			const counts = stepStatusCounts(env.db, w.id);
			const winId = getWorkflowMeta(env.db, w.id, WF_WINDOW_META_KEY);
			env.info(
				`  ${w.id} [${w.status}] wave=${w.current_wave} 绑定窗口=${winId ?? "-"} counts=${JSON.stringify(counts)}`,
			);
		}
		const running = getRunningSteps(env.db);
		if (running.length > 0) {
			env.info(`运行中(${running.length}):`);
			for (const s of running) {
				env.info(`  ${s.id} tab=${s.tab_id ?? "?"} worktree=${s.worktree ?? "?"}`);
			}
		}
		const evtTotal = (
			env.db.prepare("SELECT count(*) n FROM workflow_events").get() as {
				n: number;
			}
		).n;
		const attTotal = (
			env.db.prepare("SELECT count(*) n FROM workflow_attempts").get() as {
				n: number;
			}
		).n;
		env.info(`事件总数: ${evtTotal} | attempts: ${attTotal}`);
		env.info(`gittree: ${resolveBin("gittree")}`);
	},
});

// ── context(pi 独有,子 pi 内)───────────────────────────────
register({
	name: "context",
	description: "读任务详情(子 pi 或显式 stepId)",
	usage: "wf context [stepId]",
	widget: "workflow-task",
	run: (args, env) => {
		// 显式 stepId(CLI 场景)→ 身份解析(子 pi 场景)
		let step: StepRow | null = null;
		let stepLabel = "";
		if (args[0]) {
			step = resolveStepId(env, args[0]);
			if (!step) {
				env.fail(`步骤不存在: ${args[0]}`);
				return;
			}
			stepLabel = step.id;
		} else {
			const ident = resolveIdentity(env.cwd, env.db);
			if (!ident) {
				env.fail(
					"无法确定任务身份:传 stepId,或设置 PI_WF_WORKFLOW/PI_WF_STEP,或在 wf worktree 内运行",
				);
				return;
			}
			if (ident.master) {
				env.fail(
					"你是主控 agent,没有自己的任务详情;查看 /wf status 获取 workflow 全景",
				);
				return;
			}
			step = getStep(env.db, ident.stepId!) ?? null;
			if (!step) {
				env.fail(`步骤不存在: ${ident.stepId}`);
				return;
			}
			stepLabel = step.id;
		}
		// 优先最新 attempt 的冻结任务正文(逐行净化:多行 markdown 保留换行)
		const attempt = getLatestAttempt(env.db, step.id);
		const taskMd =
			(attempt?.task_md && attempt.status === ATTEMPT_STATUS.running
				? attempt.task_md
				: null) ?? step.task_md;
		env.show(sanitizeTerminalLines(taskMd.split("\n")));
		env.notifyPi(
			`[wf] 任务详情已显示: ${stepLabel}(worktree: ${step.worktree ?? "-"})`,
		);
	},
});

// ── steer(pi 独有)──────────────────────────────────────────
register({
	name: "steer",
	description: "向子任务 tab 发送指令",
	usage: "/wf steer <dotted> <文本>",
	entry: "pi",
	run: async (args, env) => {
		const [token, ...text] = args;
		if (!token || text.length === 0) {
			env.warn("用法: /wf steer <dotted> <文本>");
			return;
		}
		const step = resolveStepId(env, token);
		if (!step) {
			env.fail(`步骤不存在: ${token}`);
			return;
		}
		if (!step.tab_id) {
			env.warn(`步骤 ${step.id} 无 tab(tab_id 为空),无法 steer`);
			return;
		}
		const msg = text.join(" ");
		const res = await sendTextToTerminal(step.tab_id, msg);
		if (res.ok) {
			env.info(`已向 ${step.id} 的 tab 发送指令`);
		} else {
			env.warn(`发送失败: ${res.error ?? "未知错误"}`);
		}
	},
});

// ── resolve-conflict(双入口)──────────────────────────────
register({
	name: "resolve-conflict",
	description: "确认解决冲突步骤",
	usage: "wf resolve-conflict <stepId>",
	run: (args, env) => {
		const token = args[0];
		if (!token) {
			env.warn("用法: /wf resolve-conflict <dotted>");
			return;
		}
		const step = resolveStepId(env, token);
		if (!step) {
			env.fail(`步骤不存在: ${token}`);
			return;
		}
		if (step.status !== "conflict") {
			env.warn(`状态 ${step.status} 不是 conflict,无需解决`);
			return;
		}
		updateStepStatus(env.db, step.id, STEP_STATUS.done, undefined, {
			strict: true,
		});
		addEvent(env.db, {
			workflowId: step.workflow_id,
			stepId: step.id,
			type: EVT.stepResolved,
		});
		env.info(`已确认解决 ${step.id} → done,可 /wf merge 继续`);
	},
});

// ── skip(双入口:人工终态)──────────────────────────────────
register({
	name: "skip",
	description: "人工终态:非终态步骤 → skipped(依赖视为 done)",
	usage: "wf skip <stepId> <原因>",
	run: (args, env) => {
		const [token, ...rest] = args;
		if (!token) {
			env.warn("用法: wf skip <stepId> <原因>");
			return;
		}
		const step = resolveStepId(env, token);
		if (!step) {
			env.fail(`步骤不存在: ${token}`);
			return;
		}
		if (["done", "skipped"].includes(step.status)) {
			env.warn(`状态 ${step.status} 已是终态,无需 skip`);
			return;
		}
		// 状态机校验:任意非终态 → skipped(迁移表约束,含 conflict)
		if (!canTransition(step.status, STEP_STATUS.skipped)) {
			env.warn(
				`状态迁移非法: ${step.id} ${step.status} → ${STEP_STATUS.skipped};允许: ${legalTargets(step.status).join(", ")}`,
			);
			return;
		}
		const reason = rest.join(" ") || "(未说明)";
		updateStepStatus(
			env.db,
			step.id,
			STEP_STATUS.skipped,
			{ error: reason },
			{ strict: true },
		);
		addEvent(env.db, {
			workflowId: step.workflow_id,
			stepId: step.id,
			type: EVT.stepSkipped,
			payload: { reason },
		});
		env.info(`已人工终态 ${step.id} → skipped(${reason})`);
	},
});

// ── resume(双入口:暂停后恢复)─────────────────────────────
register({
	name: "resume",
	description: "暂停后恢复",
	usage: "wf resume [--workflow <id>]",
	run: (args, env) => {
		const parsed = parseArgs(args, [{ name: "--workflow", value: true }]);
		const explicitWf = parsed.value("--workflow");
		const wfId = resolveWorkflowId(env, explicitWf ?? parsed.positionals[0]);
		if (!wfId) {
			env.warn("无法确定 workflow(在仓库根目录运行,或显式传 workflow id)");
			return;
		}
		const workflow = getWorkflow(env.db, wfId);
		if (!workflow) {
			env.fail(`workflow 不存在: ${wfId}`);
			return;
		}
		if (workflow.status !== WORKFLOW_STATUS.paused) {
			env.warn(`状态 ${workflow.status} 不是 paused,无需恢复`);
			return;
		}
		updateWorkflowStatus(env.db, wfId, WORKFLOW_STATUS.running);
		addEvent(env.db, { workflowId: wfId, type: EVT.workflowResumed });
		env.info(`✓ ${wfId} 已恢复(running)`);
	},
});
