/**
 * cli.ts — pi-workflow 辅助命令行(创建/执行/排查)
 *
 * 与插件共享核心逻辑(db/orchestrator/dispatch/validate),不依赖 pi 交互:
 *
 *   wf plan-init <name> "<目标>" [--repo <path>] [--steps N]
 *   wf import <plan.json>
 *   wf status [--json] | wf tree [wf] | wf step <id> | wf events [wf] [N] [--follow]
 *   wf dispatch <dotted...> [--workflow <id>] [--dry-run]
 *   wf verify <id> approve|reject [原因] | wf done <id> '<JSON>' | wf fail <id> <原因>
 *   wf clean | wf doctor | wf debug
 *
 * 运行:node --experimental-strip-types src/cli.ts(入口 bin/wf)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import {
	DB_PATH,
	getEvents,
	getRunningSteps,
	getStep,
	getStepsByWorkflow,
	getWorkflow,
	getWorkflowMeta,
	listActiveWorkflows,
	listWorkflows,
	stepStatusCounts,
	workflowCost,
	getDb,
	getAttemptsByStep,
} from "./db.ts";
import {
	importPlan,
	reportDone,
	reportFail,
	verifyStep,
} from "./orchestrator.ts";
import { dispatchStep, resolveBin } from "./dispatch.ts";
import { mergeWave } from "./monitor.ts";
import { WF_WINDOW_META_KEY } from "./dispatch.ts";
import { resolveIdentity } from "./index.ts";
import type { PlanInput } from "./validate.ts";

const db = getDb();

// ────────────────────────────────────────────────────────────
// 工具
// ────────────────────────────────────────────────────────────
function resolveWorkflowId(explicit?: string): string | null {
	if (explicit) return explicit;
	const ident = resolveIdentity(process.cwd());
	if (ident) return ident.workflowId;
	const cwd = path.resolve(process.cwd());
	const matches = listActiveWorkflows(db).filter((w) => {
		const repo = path.resolve(w.repo_path);
		return repo === cwd || cwd.startsWith(repo + path.sep);
	});
	if (matches.length === 1) return matches[0].id;
	return null;
}

const STATUS_ICON: Record<string, string> = {
	pending: "○",
	ready: "○",
	dispatched: "▶",
	running: "▶",
	reported: "◐",
	"waiting-verify": "◐",
	done: "✓",
	skipped: "–",
	failed: "✗",
	aborted: "✗",
	conflict: "⚠",
	"needs-fix": "↻",
};

function printStatusJson(wfId?: string): void {
	const workflows = wfId
		? [getWorkflow(db, wfId)].filter((w): w is NonNullable<typeof w> =>
				Boolean(w),
			)
		: listWorkflows(db);
	const out = workflows.map((w) => {
		const counts = stepStatusCounts(db, w.id);
		const steps = getStepsByWorkflow(db, w.id);
		const cost = workflowCost(db, w.id);
		const winId = getWorkflowMeta(db, w.id, WF_WINDOW_META_KEY);
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
	console.log(JSON.stringify(out, null, 2));
}

function printStatusText(wfId?: string): void {
	const workflows = wfId
		? [getWorkflow(db, wfId)].filter((w): w is NonNullable<typeof w> =>
				Boolean(w),
			)
		: listWorkflows(db);
	if (workflows.length === 0) {
		console.log("(无 workflow,先用 wf import <plan.json> 导入计划)");
		return;
	}
	for (const w of workflows) {
		const counts = stepStatusCounts(db, w.id);
		const steps = getStepsByWorkflow(db, w.id);
		const cost = workflowCost(db, w.id);
		const winId = getWorkflowMeta(db, w.id, WF_WINDOW_META_KEY) as
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
			cost && cost.cost_cents > 0
				? ` $${(cost.cost_cents / 100).toFixed(2)}`
				: "";
		console.log(
			`[${w.id}] ${w.title} | ${w.status} | 进度 ${done}/${steps.length} 运行${running} 异常${abnormal}${costText}`,
		);
		console.log(
			`  repo: ${w.repo_path} | base: ${w.base_sha ?? "-"} | 绑定窗口: ${winId ?? "-"}`,
		);
		for (const s of getRunningSteps(db, w.id)) {
			console.log(
				`  ▶ ${s.id} ${s.title} tab=${s.tab_id ? s.tab_id.slice(0, 8) : "?"}`,
			);
		}
	}
}

function printTree(wfId?: string): void {
	const wf = wfId ?? resolveWorkflowId();
	if (!wf) {
		console.error("无法确定 workflow(传 id 或在仓库根目录运行)");
		process.exit(1);
	}
	const steps = getStepsByWorkflow(db, wf);
	for (const s of steps) {
		const depth = s.id.slice(wf.length + 1).split(".").length;
		const icon = STATUS_ICON[s.status] ?? "?";
		console.log(
			`${"  ".repeat(depth - 1)}${icon} ${s.id.slice(wf.length + 1)} ${s.title} [${s.agent}${s.gate ? "/gate" : ""}]${s.error ? ` ✗ ${s.error}` : ""}`,
		);
	}
}

// ────────────────────────────────────────────────────────────
// 子命令
// ────────────────────────────────────────────────────────────
function cmdPlanInit(args: string[]): void {
	const [name, goal] = args.filter((a) => !a.startsWith("--"));
	const repo = args.includes("--repo")
		? args[args.indexOf("--repo") + 1]
		: process.cwd();
	const n = args.includes("--steps")
		? Number(args[args.indexOf("--steps") + 1])
		: 4;
	if (!name || !goal) {
		console.error(
			'用法: wf plan-init <name> "<目标>" [--repo <path>] [--steps N]',
		);
		process.exit(1);
	}
	const steps = Array.from({ length: n }, (_, i) => ({
		id: String(i + 1),
		title: `步骤 ${i + 1}`,
		agent: i === 0 ? "planner" : i === n - 1 ? "reviewer" : "worker",
		task: `描述第 ${i + 1} 步要做什么`,
	}));
	const plan: PlanInput = { name, title: name, goal, repoPath: repo, steps };
	const out = path.join(process.cwd(), "plan.json");
	fs.writeFileSync(out, JSON.stringify(plan, null, 2) + "\n");
	console.log(`已生成 ${out}(编辑 steps 后 /wf import 或 wf import)`);
}

function cmdImport(file: string | undefined): void {
	if (!file) {
		console.error("用法: wf import <plan.json>");
		process.exit(1);
	}
	const raw = fs.readFileSync(path.resolve(file), "utf-8");
	let plan: PlanInput;
	try {
		plan = JSON.parse(raw) as PlanInput;
	} catch (e) {
		console.error(`✗ 计划文件不是合法 JSON: ${(e as Error).message}`);
		process.exit(1);
	}
	const result = importPlan(db, plan, process.cwd());
	if (!result.ok) {
		console.error("导入失败:");
		for (const e of result.errors ?? []) console.error(`  ✗ ${e}`);
		process.exit(1);
	}
	console.log(
		`✓ 已导入 ${result.workflowId}:${result.stepCount} 个步骤(wave ${result.wave})`,
	);
}

async function cmdDispatch(args: string[]): Promise<void> {
	const dryRun = args.includes("--dry-run");
	const wfFlagIdx = args.indexOf("--workflow");
	const explicitWf = wfFlagIdx !== -1 ? args[wfFlagIdx + 1] : undefined;
	const tokens = args.filter((a) => !a.startsWith("--") && a !== explicitWf);
	const wfId = resolveWorkflowId(explicitWf);
	if (!wfId) {
		console.error("无法确定 workflow(传 --workflow <id> 或在仓库根目录运行)");
		process.exit(1);
	}
	const workflow = getWorkflow(db, wfId);
	if (!workflow) {
		console.error(`workflow 不存在: ${wfId}`);
		process.exit(1);
	}
	for (const token of tokens) {
		const step = getStep(db, token) ?? getStep(db, `${wfId}-${token}`);
		if (!step) {
			console.error(`✗ ${token}: 步骤不存在`);
			continue;
		}
		const res = await dispatchStep(db, workflow, step, { dryRun });
		if (res.ok) {
			console.log(
				res.dryRun
					? `◦ ${token}: [dry-run] worktree=${res.worktree}\n${res.pointer}`
					: `✓ ${token}: running tab=${res.tabId ? res.tabId.slice(0, 8) : "?"} worktree=${res.worktree}`,
			);
		} else {
			console.error(`✗ ${token}: ${res.error}`);
		}
	}
}

function cmdVerify(args: string[]): void {
	const [id, action, ...rest] = args;
	if (!id || (action !== "approve" && action !== "reject")) {
		console.error("用法: wf verify <id> approve|reject [原因]");
		process.exit(1);
	}
	const res = verifyStep(db, id, action, rest.join(" "));
	if (!res.ok) {
		console.error(`✗ ${res.error}`);
		process.exit(1);
	}
	console.log(`✓ ${id} → ${res.status}`);
}

async function cmdMerge(args: string[]): Promise<void> {
	const waveFlagIdx = args.indexOf("--wave");
	const waveSeq =
		waveFlagIdx !== -1 && args[waveFlagIdx + 1]
			? Number(args[waveFlagIdx + 1])
			: undefined;
	const explicitWf = args.find((a) => !a.startsWith("--") && !/^\d+$/.test(a));
	const wfId = resolveWorkflowId(explicitWf);
	if (!wfId) {
		console.error("无法确定 workflow(传 id 或在仓库根目录运行)");
		process.exit(1);
	}
	const workflow = getWorkflow(db, wfId);
	if (!workflow) {
		console.error(`workflow 不存在: ${wfId}`);
		process.exit(1);
	}
	const res = await mergeWave(db, workflow, waveSeq ?? workflow.current_wave);
	if (res.ok) {
		console.log(`✓ wave ${res.wave} 合并完成:${res.merged.length} 个步骤合回主分支`);
	} else {
		console.error(`✗ wave ${res.wave} 合并未完成: ${res.error}`);
		process.exit(1);
	}
}

function cmdDone(args: string[]): void {
	const [id, ...rest] = args;
	if (!id || rest.length === 0) {
		console.error("用法: wf done <id> '<JSON>'");
		process.exit(1);
	}
	let payload: unknown;
	try {
		payload = JSON.parse(rest.join(" "));
	} catch (e) {
		console.error(`✗ JSON 解析失败: ${(e as Error).message}`);
		process.exit(1);
	}
	const res = reportDone(db, id, payload);
	if (!res.ok) {
		console.error(`✗ ${res.error}`);
		process.exit(1);
	}
	console.log(`✓ ${id} → ${res.status}`);
}

function cmdFail(args: string[]): void {
	const [id, ...rest] = args;
	if (!id) {
		console.error("用法: wf fail <id> <原因>");
		process.exit(1);
	}
	const res = reportFail(db, id, rest.join(" ") || "(未说明)");
	if (!res.ok) {
		console.error(`✗ ${res.error}`);
		process.exit(1);
	}
	console.log(`✓ ${id} → failed`);
}

function cmdStep(id: string | undefined): void {
	if (!id) {
		console.error("用法: wf step <id>");
		process.exit(1);
	}
	const step = getStep(db, id) ?? getStep(db, `${resolveWorkflowId()}-${id}`);
	if (!step) {
		console.error(`✗ 步骤不存在: ${id}`);
		process.exit(1);
	}
	console.log(`[${step.id}] ${step.title}`);
	console.log(
		`  状态: ${step.status} | agent: ${step.agent} | gate: ${step.gate} | worktree: ${step.worktree ?? "-"} | tab: ${step.tab_id ?? "-"}`,
	);
	console.log(`  期望: ${step.expectations ?? "-"}`);
	console.log(`  回报: ${step.report ?? "-"}`);
	console.log(`  错误: ${step.error ?? "-"}`);
	for (const a of getAttemptsByStep(db, step.id)) {
		console.log(
			`  attempt#${a.attempt_no} ${a.status} tab=${a.tab_id ? a.tab_id.slice(0, 8) : "-"}${a.error ? ` 错误: ${a.error}` : ""}`,
		);
	}
	const events = getEvents(db, { stepId: step.id, limit: 10 });
	if (events.length > 0) {
		console.log(`  事件: ${events.map((e) => e.type).join(" → ")}`);
	}
}

function cmdEvents(args: string[]): void {
	const follow = args.includes("--follow");
	const nums = args.filter((a) => /^\d+$/.test(a));
	const limit = nums[0] ? Number(nums[0]) : 30;
	const wfId = args.find((a) => !/^\d+$/.test(a) && a !== "--follow");
	const show = (afterId: number): number => {
		const events = getEvents(db, {
			workflowId: wfId ?? undefined,
			limit,
			afterId: afterId || undefined,
		});
		for (const e of events.reverse()) {
			console.log(
				`${new Date(e.created_at).toLocaleTimeString()} ${e.type}${e.step_id ? ` ${e.step_id}` : ""}${e.attempt_id ? ` #${e.attempt_id}` : ""}`,
			);
		}
		return events.length > 0 ? events[events.length - 1].id : afterId;
	};
	let last = show(0);
	if (!follow) return;
	console.log("(跟随中,Ctrl+C 退出)");
	const timer = setInterval(() => {
		last = show(last);
	}, 3000);
	process.on("SIGINT", () => {
		clearInterval(timer);
		process.exit(0);
	});
}

function cmdClean(): void {
	const bin = resolveBin("gittree");
	const res = execFileSync(bin, ["list"], { encoding: "utf-8" });
	console.log(res.trim() || "(无 gittree worktree)");
	console.log(
		"提示:清理残留 worktree 用 gittree clean <name> --branch --force 或 clean all --yes(占用检测保护)",
	);
}

function cmdDoctor(): void {
	const checks: Array<[string, boolean, string]> = [];
	checks.push([
		"node 版本 ≥ 22.13",
		Number(process.versions.node.split(".")[0]) >= 22,
		process.version,
	]);
	checks.push(["node:sqlite 可用", true, DB_PATH]);
	const gittree = resolveBin("gittree");
	checks.push(["gittree 可执行", fs.existsSync(gittree), gittree]);
	const ghostctl = resolveBin("ghostctl");
	checks.push(["ghostctl 可执行", fs.existsSync(ghostctl), ghostctl]);
	try {
		const py = execFileSync("/usr/bin/env", ["python3", "--version"], {
			encoding: "utf-8",
		}).trim();
		const ok = /3\.(1[0-9]|[2-9])/.test(py);
		checks.push(["python3 ≥ 3.10(ghostctl 语法)", ok, py]);
	} catch {
		checks.push(["python3 ≥ 3.10(ghostctl 语法)", false, "python3 不可用"]);
	}
	const ver = (
		db.prepare("PRAGMA user_version").get() as { user_version: number }
	).user_version;
	checks.push(["数据库可打开(user_version)", ver >= 1, `v${ver} @ ${DB_PATH}`]);
	let okAll = true;
	for (const [name, ok, detail] of checks) {
		console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : " ← 需修复"}`);
		console.log(`    ${detail}`);
		if (!ok) okAll = false;
	}
	console.log(okAll ? "\n环境正常" : "\n存在环境问题,见上");
}

function cmdDebug(): void {
	const ver = (
		db.prepare("PRAGMA user_version").get() as { user_version: number }
	).user_version;
	console.log(`DB: ${DB_PATH} (schema v${ver})`);
	const tables = db
		.prepare(
			"SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'workflow%' ORDER BY name",
		)
		.all() as Array<{ name: string }>;
	console.log(`表(${tables.length}): ${tables.map((t) => t.name).join(", ")}`);
	const wfs = listWorkflows(db);
	console.log(`workflows(${wfs.length}):`);
	for (const w of wfs) {
		const counts = stepStatusCounts(db, w.id);
		const winId = getWorkflowMeta(db, w.id, WF_WINDOW_META_KEY);
		console.log(
			`  ${w.id} [${w.status}] wave=${w.current_wave} 绑定窗口=${winId ?? "-"} counts=${JSON.stringify(counts)}`,
		);
	}
	const running = getRunningSteps(db);
	if (running.length > 0) {
		console.log(`运行中(${running.length}):`);
		for (const s of running)
			console.log(
				`  ${s.id} tab=${s.tab_id ?? "?"} worktree=${s.worktree ?? "?"}`,
			);
	}
	const evtTotal = (
		db.prepare("SELECT count(*) n FROM workflow_events").get() as { n: number }
	).n;
	const attTotal = (
		db.prepare("SELECT count(*) n FROM workflow_attempts").get() as {
			n: number;
		}
	).n;
	console.log(`事件总数: ${evtTotal} | attempts: ${attTotal}`);
	console.log(
		`gittree: ${resolveBin("gittree")} | ghostctl: ${resolveBin("ghostctl")}`,
	);
}

// ────────────────────────────────────────────────────────────
// 入口
// ────────────────────────────────────────────────────────────
async function main(): Promise<void> {
	const [cmd, ...args] = process.argv.slice(2);
	switch (cmd) {
		case "plan-init":
			cmdPlanInit(args);
			break;
		case "import":
			cmdImport(args[0]);
			break;
		case "status":
			if (args.includes("--json"))
				printStatusJson(args.find((a) => !a.startsWith("--")));
			else printStatusText(args.find((a) => !a.startsWith("--")));
			break;
		case "tree":
			printTree(args[0]);
			break;
		case "step":
			cmdStep(args[0]);
			break;
		case "events":
			cmdEvents(args);
			break;
		case "dispatch":
			await cmdDispatch(args);
			break;
		case "verify":
			cmdVerify(args);
			break;
		case "merge":
			await cmdMerge(args);
			break;
		case "done":
			cmdDone(args);
			break;
		case "fail":
			cmdFail(args);
			break;
		case "clean":
			cmdClean();
			break;
		case "doctor":
			cmdDoctor();
			break;
		case "debug":
			cmdDebug();
			break;
		case "help":
		case undefined:
			console.log(`pi-workflow CLI — 创建/执行/排查(设计 §6 skill 手册)

用法:
  wf plan-init <name> "<目标>" [--repo <path>] [--steps N]   生成 plan.json 模板
  wf import <plan.json>                                      校验 + 落库
  wf status [--json] [wfId]                                  状态全景
  wf tree [wfId]                                             层级任务树
  wf step <id>                                               单步详情
  wf events [wfId] [N] [--follow]                            审计流
  wf dispatch <dotted...> [--workflow <id>] [--dry-run]      派发子任务(真实开 tab)
  wf verify <id> approve|reject [原因]                       期望核对
  wf merge [--wave N]                                        合并 wave 回主分支
  wf done <id> '<JSON>' / wf fail <id> <原因>                回报(子任务侧)
  wf clean                                                   清理 worktree
  wf doctor                                                  环境自检
  wf debug                                                   诊断信息`);
			break;
		default:
			console.error(`未知命令: ${cmd}(wf help 查看用法)`);
			process.exit(1);
	}
}

main().catch((e) => {
	console.error("执行失败:", (e as Error).message);
	process.exit(1);
});
