/**
 * test-workflow.ts — P1 验收测试(设计文档 §11 P1)
 *
 * 运行:cd ~/.pi/agent/extensions/workflow && node --experimental-strip-types test/workflow.test.ts
 *
 * 覆盖:
 *  T1 db 迁移(10 表 + 2 视图 + user_version + 幂等)
 *  T2 validatePlan(合法/非法:层级 id、重复、环、agent、workflow id)
 *  T3 importPlan 事务落库(workflow/wave/steps/deps/task_raw/事件)
 *  T4 renderTaskMd + injectDeps(依赖注入、期望、输出契约)
 *  T5 dispatch dry-run(pointer/worktree 路径,零副作用)
 *  T6 dispatch 真实执行(临时 git 仓库 + 真 gittree + fake ghostctl)
 *  T7 reportDone / verifyStep / reportFail 闭环(gate 前后对照)
 *  T8 聚合查询(状态分布/running/成本/事件/看板视图)
 *  T9 resolveIdentity(env + cwd 解析)
 */
import type { WorkflowNotifyDetails } from "../src/ui/notify.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { StepRow } from "../src/core/db.ts";
import type { NotifyItem } from "../src/observe/monitor.ts";

// 必须在 import core/db.ts 之前设置(DB_PATH 模块加载时计算)
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-test-"));
process.env.WF_DB_PATH = path.join(tmpDir, "test.db");

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string): void {
	if (cond) {
		passed++;
		console.log(`  ✓ ${msg}`);
	} else {
		failed++;
		console.error(`  ✗ ${msg}`);
	}
}

const AGENTS = [
	{
		name: "planner",
		description: "plan",
		tools: ["read"],
		systemPrompt: "plan",
		source: "user" as const,
		filePath: "planner.md",
	},
	{
		name: "worker",
		description: "dev",
		tools: ["read", "write", "bash"],
		systemPrompt: "dev",
		source: "user" as const,
		filePath: "worker.md",
	},
	{
		name: "reviewer",
		description: "review",
		tools: ["read"],
		systemPrompt: "review",
		source: "user" as const,
		filePath: "reviewer.md",
	},
];

const DEMO_PLAN = {
	name: "demo-wf",
	title: "演示工作流",
	goal: "给 session store 加 Redis 缓存,登录/登出路径全量覆盖",
	repoPath: tmpDir,
	steps: [
		{
			id: "1",
			title: "输出改造方案",
			agent: "planner",
			task: "分析认证模块,输出方案,写入 {{root}}/docs/plan.md",
		},
		{
			id: "1.1",
			title: "认证接入缓存",
			agent: "worker",
			task: "按 {{steps.1.summary}} 实现登录缓存",
			deps: ["1"],
			expectations: ["登录后写入缓存", "测试通过"],
			gate: false,
		},
		{
			id: "1.2",
			title: "session 存储改造",
			agent: "worker",
			task: "改造 session 存储层",
			deps: ["1"],
		},
		{
			id: "2",
			title: "整体评审",
			agent: "reviewer",
			task: "评审 {{steps.1.1.summary}} 与 {{steps.1.2.summary}}",
			deps: ["1.1", "1.2"],
			gate: true,
			expectations: ["无遗留阻断问题"],
		},
	],
};

async function main(): Promise<void> {
	console.log("== T1 db 迁移 ==");
	const dbMod = await import("../src/core/db.ts");
	const db = dbMod.getDb();
	const tables = db
		.prepare(
			"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
		)
		.all() as Array<{ name: string }>;
	const views = db
		.prepare("SELECT name FROM sqlite_master WHERE type='view' ORDER BY name")
		.all() as Array<{ name: string }>;
	assert(
		tables.length === 10,
		`10 张表(实际 ${tables.length}: ${tables.map((t) => t.name).join(",")})`,
	);
	assert(
		views.length === 2 && views.every((v) => v.name.startsWith("v_workflow_")),
		`2 个视图(${views.map((v) => v.name).join(",")})`,
	);
	const ver = (
		db.prepare("PRAGMA user_version").get() as { user_version: number }
	).user_version;
	assert(ver === 2, `user_version = 2(owner_cwd 迁移;实际 ${ver})`);
	dbMod.resetDbForTests();
	const db2 = dbMod.getDb();
	const ver2 = (
		db2.prepare("PRAGMA user_version").get() as { user_version: number }
	).user_version;
	assert(ver2 === 2, "迁移幂等:重连后 user_version 仍为 2");

	console.log("== T2 validatePlan ==");
	const validateMod = await import("../src/validate.ts");
	const okPlan = validateMod.validatePlan(DEMO_PLAN, AGENTS);
	assert(okPlan.ok, "合法计划通过");
	assert(okPlan.steps.length === 4, "4 个步骤");
	const s11 = okPlan.steps.find((s) => s.dotted === "1.1")!;
	assert(s11.parentId === "demo-wf-1", `1.1 父 id 推导: ${s11.parentId}`);
	assert(s11.fullId === "demo-wf-1.1", "完整 id = workflowId-dotted");
	assert(s11.sortOrder === 1001000000, `sort_order 层级编码: ${s11.sortOrder}`);
	assert(
		validateMod.packDotted("1.2.3") === 1002003000,
		"packDotted(1.2.3)=1002003000(固定 4 段补 0,前缀序)",
	);

	const badId = validateMod.validatePlan(
		{ ...DEMO_PLAN, steps: [{ id: "a1", title: "x", agent: "worker" }] },
		AGENTS,
	);
	assert(
		!badId.ok && badId.errors.some((e) => e.includes("点号")),
		"非法 id 拒绝",
	);
	const dup = validateMod.validatePlan(
		{
			...DEMO_PLAN,
			steps: [
				{ id: "1", title: "a", agent: "worker" },
				{ id: "1", title: "b", agent: "worker" },
			],
		},
		AGENTS,
	);
	assert(!dup.ok && dup.errors.some((e) => e.includes("重复")), "重复 id 拒绝");
	const cycle = validateMod.validatePlan(
		{
			...DEMO_PLAN,
			steps: [
				{ id: "1", title: "a", agent: "worker", deps: ["1.1"] },
				{ id: "1.1", title: "b", agent: "worker", deps: ["1"] },
			],
		},
		AGENTS,
	);
	assert(!cycle.ok && cycle.errors.some((e) => e.includes("环")), "依赖环拒绝");
	const badDep = validateMod.validatePlan(
		{
			...DEMO_PLAN,
			steps: [{ id: "1", title: "a", agent: "worker", deps: ["9"] }],
		},
		AGENTS,
	);
	assert(
		!badDep.ok && badDep.errors.some((e) => e.includes("依赖不存在")),
		"不存在依赖拒绝",
	);
	const badAgent = validateMod.validatePlan(
		{ ...DEMO_PLAN, steps: [{ id: "1", title: "a", agent: "nobody" }] },
		AGENTS,
	);
	assert(
		!badAgent.ok && badAgent.errors.some((e) => e.includes("agent 不存在")),
		"未知 agent 拒绝",
	);
	const badWf = validateMod.validatePlan(
		{ ...DEMO_PLAN, name: "Bad Name" },
		AGENTS,
	);
	assert(
		!badWf.ok && badWf.errors.some((e) => e.includes("kebab-case")),
		"workflow id 格式拒绝",
	);

	console.log("== T3 importPlan ==");
	const orchMod = await import("../src/orchestrator.ts");
	const imported = orchMod.importPlan(db2, DEMO_PLAN, tmpDir, AGENTS);
	assert(
		imported.ok,
		`导入成功(${imported.workflowId}, ${imported.stepCount} 步)`,
	);
	const wf = dbMod.getWorkflow(db2, "demo-wf");
	assert(wf !== undefined && wf.goal.includes("Redis"), "workflow 落库(goal)");
	assert(wf!.repo_path === tmpDir, "repo_path 落库");
	const steps = dbMod.getStepsByWorkflow(db2, "demo-wf");
	assert(steps.length === 4, "4 个步骤落库");
	assert(
		steps.every(
			(s) =>
				s.task_md ===
				DEMO_PLAN.steps.find((p) => p.id === s.id.slice("demo-wf".length + 1))
					?.task,
		),
		"task_md 初值 = 原始任务文本",
	);
	const dupImport = orchMod.importPlan(db2, DEMO_PLAN, tmpDir, AGENTS);
	assert(
		!dupImport.ok && dupImport.errors![0].includes("已存在"),
		"重复导入拒绝",
	);
	const depsOf2 = dbMod.getStepDeps(db2, "demo-wf-2");
	assert(
		depsOf2.length === 2 && depsOf2.includes("demo-wf-1.1"),
		`deps 落库(${depsOf2.join(",")})`,
	);
	const rawMeta = dbMod.getStepMeta(db2, "demo-wf-1.1", "task_raw");
	assert(
		rawMeta === DEMO_PLAN.steps[1].task,
		"task_raw 存入 KV(重试可重新渲染)",
	);
	const evts = dbMod.getEvents(db2, { workflowId: "demo-wf", limit: 100 });
	const types = evts.map((e) => e.type);
	assert(
		types.filter((t) => t === "workflow_created").length === 1,
		"workflow_created 事件",
	);
	assert(
		types.filter((t) => t === "step_created").length === 4,
		"step_created ×4 事件",
	);

	console.log("== T4 renderTaskMd + injectDeps ==");
	const dispatchMod = await import("../src/exec/dispatch.ts");
	// piInvocation:pi 插件上下文复用当前 node + 脚本;wf CLI 上下文解析真实 pi 二进制
	const savedArgv = process.argv[1];
	const savedPiBin = process.env.PI_BIN;
	// 模拟 pi 插件上下文:argv[1] 为真实存在的 pi 入口(非 cli.ts)
	const fakePiEntry = path.join(tmpDir, "pi-cli.js");
	fs.writeFileSync(fakePiEntry, "#!/usr/bin/env node\n");
	process.argv[1] = fakePiEntry;
	delete process.env.PI_BIN;
	const inPlugin = dispatchMod.piInvocation();
	assert(
		inPlugin.includes("node") && inPlugin.includes(fakePiEntry),
		`pi 插件上下文复用 node+pi 入口(${inPlugin})`,
	);
	process.argv[1] = path.join(tmpDir, "extensions", "workflow", "src", "cli.ts");
	fs.mkdirSync(path.join(tmpDir, "extensions", "workflow", "src"), {
		recursive: true,
	});
	fs.writeFileSync(
		path.join(tmpDir, "extensions", "workflow", "src", "cli.ts"),
		"// cli\n",
	);
	const cliNoPiBin = dispatchMod.piInvocation();
	assert(
		!cliNoPiBin.includes("cli.ts") &&
			(cliNoPiBin === "pi" || cliNoPiBin.includes("node")),
		`wf CLI 上下文不启动自身(${cliNoPiBin})`,
	);
	process.env.PI_BIN = "/custom/pi";
	assert(dispatchMod.piInvocation() === '"/custom/pi"', "PI_BIN 显式覆盖");
	if (savedPiBin === undefined) delete process.env.PI_BIN;
	else process.env.PI_BIN = savedPiBin;
	process.argv[1] = savedArgv;
	// 先让步骤 1 完成(供 1.1 注入)
	dbMod.updateStepReport(db2, "demo-wf-1", {
		summary: "方案已确认:Redis 直连",
		filesChanged: ["docs/plan.md"],
		issues: [],
		tests: "none",
	});
	dbMod.updateStepStatus(db2, "demo-wf-1", dbMod.STEP_STATUS.done);
	const step11 = dbMod.getStep(db2, "demo-wf-1.1")!;
	const md = dispatchMod.renderTaskMd(db2, wf!, step11, 1);
	assert(
		md.includes("## 需求目标") && md.includes("Redis 缓存"),
		"渲染含需求目标",
	);
	assert(md.includes("方案已确认"), "依赖注入:{{steps.1.summary}} → 摘要");
	assert(md.includes("- 登录后写入缓存"), "期望逐条列出");
	assert(md.includes("## 输出契约") && md.includes("/wf done 1.1"), "输出契约");
	assert(md.includes("worktree") && md.includes("git commit"), "约束");
	const noDep = dispatchMod.injectDeps("{{steps.9.summary}}", [], "/repo");
	assert(noDep.includes("不存在"), "缺失依赖 → 占位提示");

	console.log("== T5 dispatch dry-run ==");
	// 用 1.1(依赖 1 已完成;2 的依赖未完成会被依赖检查拒绝)
	const stepDry = dbMod.getStep(db2, "demo-wf-1.1")!;
	const dry = await dispatchMod.dispatchStep(db2, wf!, stepDry, {
		dryRun: true,
	});
	assert(dry.ok && dry.dryRun === true, "dry-run 通过");
	assert(
		dry.pointer!.includes("/wf context") && dry.pointer!.includes("/wf done 1.1"),
		"pointer 指向 /wf context 与 /wf done",
	);
	assert(
		dry.worktree === "wf-demo-wf-1.1" &&
			dry.worktreePath!.includes(".worktrees/gittree-wf-demo-wf-1.1"),
		`worktree 命名(${dry.worktreePath})`,
	);
	const unchanged = dbMod.getStep(db2, "demo-wf-1.1")!;
	assert(
		unchanged.status === "pending" && unchanged.worktree === null,
		"dry-run 零副作用",
	);
	// 依赖未完成 → 拒绝派发
	const blocked = await dispatchMod.dispatchStep(
		db2,
		wf!,
		dbMod.getStep(db2, "demo-wf-2")!,
		{ dryRun: true },
	);
	assert(
		!blocked.ok && blocked.error!.includes("依赖未完成"),
		"依赖未完成拒绝派发",
	);

	console.log(
		"== T6 dispatch 真实执行(scratch 仓库 + 真 gittree + fake ghostctl) ==",
	);
	const scratchRepo = path.join(tmpDir, "repo");
	fs.mkdirSync(scratchRepo, { recursive: true });
	execFileSync("git", ["init", "-q", scratchRepo]);
	// gittree create 基于 HEAD,空仓库无 HEAD → 先建初始提交
	execFileSync("git", [
		"-C",
		scratchRepo,
		"config",
		"user.email",
		"test@test.local",
	]);
	execFileSync("git", ["-C", scratchRepo, "config", "user.name", "test"]);
	fs.writeFileSync(path.join(scratchRepo, "README.md"), "scratch\n");
	execFileSync("git", ["-C", scratchRepo, "add", "-A"]);
	execFileSync("git", ["-C", scratchRepo, "commit", "-q", "-m", "init"]);
	const scratchWf = orchMod.importPlan(
		db2,
		{
			name: "scratch-wf",
			title: "临时",
			goal: "冒烟",
			repoPath: scratchRepo,
			steps: [
				{
					id: "1",
					title: "改一个文件",
					agent: "worker",
					task: "创建一个 hello.txt",
				},
			],
		},
		tmpDir,
		AGENTS,
	);
	assert(scratchWf.ok, "scratch workflow 导入");
	const fakeGhostctl = path.join(tmpDir, "fake-ghostctl.sh");
	const ghostctlLog = path.join(tmpDir, "ghostctl-args.log");
	const wt1Path = path.join(
		scratchRepo,
		".worktrees",
		"gittree-wf-scratch-wf-1",
	);
	fs.writeFileSync(
		fakeGhostctl,
		`#!/bin/bash\necho "$@" >> "${ghostctlLog}"\ncase "$1" in\n  layout)\n    echo '{"windows":[{"id":"tab-group-aabbccddeeff","front":true,"tabs":[{"terminals":[{"id":"abcdef0123456789","cwd":"${wt1Path}"}]}]}]}'\n    ;;\n  new-window)\n    echo "已创建窗口 (id=tab-group-aabbccddeeff)"\n    ;;\n  *)\n    echo "已创建标签页 (id=tab-xyz)"\n    ;;\nesac\n`,
		{ mode: 0o755 },
	);
	fs.writeFileSync(ghostctlLog, "");
	const sWf = dbMod.getWorkflow(db2, "scratch-wf")!;
	const sStep = dbMod.getStep(db2, "scratch-wf-1")!;
	const real = await dispatchMod.dispatchStep(db2, sWf, sStep, {
		gittreeBin: "gittree",
		ghostctlBin: fakeGhostctl,
	});
	assert(real.ok, `派发成功: ${real.error ?? ""}`);
	const boundWin = dbMod.getWorkflowMeta(db2, "scratch-wf", "ghostty_window_id");
	assert(
		boundWin === "tab-group-aabbccddeeff",
		"未绑定 → new-window 创建专属窗口并绑定(meta)",
	);
	const ghostctlCalls = fs
		.readFileSync(ghostctlLog, "utf-8")
		.split("\n")
		.filter(Boolean);
	const ghostctlRaw = fs.readFileSync(ghostctlLog, "utf-8");
	assert(
		ghostctlRaw.includes("new-window") &&
			ghostctlRaw.includes("--no-focus") &&
			ghostctlRaw.includes(`--cwd ${scratchRepo}`),
		`new-window 后台创建(--no-focus + --cwd 仓库:${ghostctlCalls.join(" | ")})`,
	);
	// 用整段日志断言(pointer 位置参数内含换行,按行切分会拆开参数)
	assert(
		ghostctlRaw.includes("new-tab") &&
			ghostctlRaw.includes("--window-id tab-group-aabbccddeeff") &&
			ghostctlRaw.includes("--at-end") &&
			ghostctlRaw.includes("--no-focus"),
		`new-tab 按窗口 id 定位 + 末尾顺序 + 不抢焦点(${ghostctlCalls.join(" | ")})`,
	);
	assert(
		!ghostctlCalls.some((l) => l.includes("--window ")),
		"new-tab 不再传 --window 序号",
	);
	assert(real.tabId === "abcdef0123456789", `tab id 解析(${real.tabId})`);
	assert(
		fs.existsSync(path.join(scratchRepo, ".worktrees/gittree-wf-scratch-wf-1")),
		"worktree 目录已创建",
	);
	const after = dbMod.getStep(db2, "scratch-wf-1");
	assert(
		after?.status === "running" && after?.tab_id === "abcdef0123456789",
		"步骤 running + tab_id",
	);
	const attempt = dbMod.getLatestAttempt(db2, "scratch-wf-1");
	assert(
		attempt?.status === "running" &&
			(attempt?.pointer?.includes("/wf context") ?? false),
		"attempt 行:pointer 冻结",
	);
	assert(
		attempt?.task_md?.includes("## 输出契约") ?? false,
		"attempt 行:task_md 冻结",
	);
	const sWfAfter = dbMod.getWorkflow(db2, "scratch-wf")!;
	assert(
		/^[0-9a-f]{40}$/.test(sWfAfter.base_sha ?? ""),
		`base_sha 已冻结(${sWfAfter.base_sha})`,
	);
	const evtSeq = dbMod
		.getEvents(db2, { workflowId: "scratch-wf", limit: 100 })
		.map((e) => e.type);
	assert(
		evtSeq.includes("worktree_created") &&
			evtSeq.includes("step_dispatched") &&
			evtSeq.includes("step_tab_opened"),
		`事件序列(${evtSeq.join(" → ")})`,
	);

	console.log("== T6b 窗口锁定:已锁定 id 优先,不依赖焦点窗口 =");
	// 预绑定 win-b(非焦点),layout 中焦点为 win-f → 应仍按 win-b 定位
	const lockWf = orchMod.importPlan(
		db2,
		{
			name: "lock-wf",
			title: "窗口锁定",
			goal: "锁定窗口",
			repoPath: scratchRepo,
			steps: [{ id: "1", title: "改文件", agent: "worker", task: "改" }],
		},
		tmpDir,
		AGENTS,
	);
	assert(lockWf.ok, "lock-wf 导入");
	dbMod.setWorkflowMeta(db2, "lock-wf", "ghostty_window_id", "win-b");
	const fakeLock = path.join(tmpDir, "fake-ghostctl-lock.sh");
	const lockLog = path.join(tmpDir, "ghostctl-lock.log");
	const lockWtPath = path.join(
		scratchRepo,
		".worktrees",
		"gittree-wf-lock-wf-1",
	);
	fs.writeFileSync(
		fakeLock,
		`#!/bin/bash\necho "$@" >> "${lockLog}"\nif [ "$1" = "layout" ]; then\n  echo '{"windows":[{"id":"win-b","front":false,"tabs":[]},{"id":"win-f","front":true,"tabs":[{"terminals":[{"id":"feedcafe00000000","cwd":"${lockWtPath}"}]}]}]}'\nelse\n  echo "已创建标签页 (id=tab-lock)"\nfi\n`,
		{ mode: 0o755 },
	);
	fs.writeFileSync(lockLog, "");
	const lockRes = await dispatchMod.dispatchStep(
		db2,
		dbMod.getWorkflow(db2, "lock-wf")!,
		dbMod.getStep(db2, "lock-wf-1")!,
		{ gittreeBin: "gittree", ghostctlBin: fakeLock },
	);
	assert(lockRes.ok, `锁定窗口派发成功: ${lockRes.error ?? ""}`);
	assert(
		dbMod.getWorkflowMeta(db2, "lock-wf", "ghostty_window_id") === "win-b",
		"已锁定 id 不被焦点窗口覆盖",
	);
	const lockCalls = fs
		.readFileSync(lockLog, "utf-8")
		.split("\n")
		.filter(Boolean);
	assert(
		lockCalls.some(
			(l) => l.includes("new-tab") && l.includes("--window-id win-b"),
		),
		`new-tab 携带 --window-id win-b(${lockCalls.join(" | ")})`,
	);
	assert(
		!lockCalls.some((l) => l.includes("--window ")),
		"锁定窗口不传 --window 序号",
	);
	assert(
		!lockCalls.some((l) => l.includes("new-window")),
		"已绑定窗口不重复创建(无 new-window)",
	);

	console.log("== T6c 绑定窗口已关闭 → 报错,绝不静默回退焦点窗口 =");
	const goneWf = orchMod.importPlan(
		db2,
		{
			name: "gonewin-wf",
			title: "窗口消失",
			goal: "窗口消失报错",
			repoPath: scratchRepo,
			steps: [{ id: "1", title: "改文件", agent: "worker", task: "改" }],
		},
		tmpDir,
		AGENTS,
	);
	assert(goneWf.ok, "gonewin-wf 导入");
	// 预绑定一个 layout 中不存在的窗口 id(模拟绑定窗口已关闭)
	dbMod.setWorkflowMeta(db2, "gonewin-wf", "ghostty_window_id", "win-gone");
	const fakeGoneWin = path.join(tmpDir, "fake-ghostctl-gonewin.sh");
	const goneLog = path.join(tmpDir, "ghostctl-gonewin.log");
	fs.writeFileSync(
		fakeGoneWin,
		`#!/bin/bash\necho "$@" >> "${goneLog}"\nif [ "$1" = "layout" ]; then\n  echo '{"windows":[{"id":"win-other","front":true,"tabs":[]}]}'\nelse\n  echo "已创建标签页 (id=tab-gone)"\nfi\n`,
		{ mode: 0o755 },
	);
	fs.writeFileSync(goneLog, "");
	const goneRes = await dispatchMod.dispatchStep(
		db2,
		dbMod.getWorkflow(db2, "gonewin-wf")!,
		dbMod.getStep(db2, "gonewin-wf-1")!,
		{ gittreeBin: "gittree", ghostctlBin: fakeGoneWin },
	);
	assert(!goneRes.ok, "派发失败(绑定窗口不可用)");
	assert(
		goneRes.error!.includes("绑定窗口") && goneRes.error!.includes("win-gone"),
		`错误提及绑定窗口与 id(${goneRes.error})`,
	);
	assert(goneRes.error!.includes("rebind-window"), "错误提示 /wf rebind-window");
	assert(
		dbMod.getStep(db2, "gonewin-wf-1")?.status === "failed",
		"步骤回退 failed(可重派,不卡 dispatched)",
	);
	assert(
		dbMod.getLatestAttempt(db2, "gonewin-wf-1")?.status === "aborted",
		"attempt 置 aborted",
	);
	assert(
		dbMod.getWorkflowMeta(db2, "gonewin-wf", "ghostty_window_id") === "win-gone",
		"锁定不被焦点窗口覆盖",
	);
	const goneCalls = fs
		.readFileSync(goneLog, "utf-8")
		.split("\n")
		.filter(Boolean);
	assert(
		!goneCalls.some((l) => l.includes("new-tab")),
		"绝不无窗口参数裸开 tab",
	);

	console.log("== T7 reportDone / verifyStep / reportFail ==");
	// 非 gate 步骤:done → reported
	const r1 = orchMod.reportDone(db2, "demo-wf-1.1", {
		summary: "登录缓存完成",
		filesChanged: ["src/auth/cache.ts"],
		issues: ["登出未清缓存"],
		tests: "passed",
	});
	assert(r1.ok && r1.status === "reported", "非 gate 回报 → reported");
	const s11After = dbMod.getStep(db2, "demo-wf-1.1")!;
	assert(
		s11After.summary === "登录缓存完成" &&
			s11After.files_changed!.includes("auth/cache.ts"),
		"step 报告字段落库",
	);
	// 注意:1.1 未派发过 → 无 attempt,直接更新 step,合理
	assert(s11After.status === "reported", "步骤状态 reported");
	// gate 步骤:done → waiting-verify
	const r2 = orchMod.reportDone(db2, "demo-wf-2", {
		summary: "评审通过",
		filesChanged: [],
		issues: [],
		tests: "passed",
	});
	assert(
		r2.ok && r2.status === "waiting-verify",
		"gate 步骤回报 → waiting-verify",
	);
	// 非法回报
	const bad = orchMod.reportDone(db2, "demo-wf-2", { summary: "" });
	assert(!bad.ok && bad.error!.includes("summary"), "空 summary 拒绝");
	const badTests = orchMod.reportDone(db2, "demo-wf-2", {
		summary: "x",
		tests: "maybe",
	});
	assert(!badTests.ok, "非法 tests 拒绝");
	// verify approve
	const v1 = orchMod.verifyStep(db2, "demo-wf-2", "approve");
	assert(v1.ok && v1.status === "done", "verify approve → done");
	const v2 = orchMod.verifyStep(db2, "demo-wf-2", "approve");
	assert(
		!v2.ok &&
			v2.error!.includes("状态迁移非法") &&
			v2.error!.includes("允许") &&
			v2.error!.includes("reported"),
		`已 done 不可重复核对(非法迁移含合法目标: ${v2.error})`,
	);
	// verify reject → needs-fix
	const r3 = orchMod.reportDone(db2, "demo-wf-1.2", {
		summary: "存储改造完成",
		filesChanged: ["src/store.ts"],
		issues: [],
		tests: "passed",
	});
	assert(r3.ok, "1.2 回报成功");
	const v3 = orchMod.verifyStep(
		db2,
		"demo-wf-1.2",
		"reject",
		"缓存键命名不达标",
	);
	assert(v3.ok && v3.status === "needs-fix", "verify reject → needs-fix");
	const s12 = dbMod.getStep(db2, "demo-wf-1.2")!;
	assert(s12.error === "缓存键命名不达标", "reject 原因写入 error");
	// fail
	const r4 = orchMod.reportFail(db2, "scratch-wf-1", "无法连接 Redis");
	assert(r4.ok, "fail 成功");
	const sScratch = dbMod.getStep(db2, "scratch-wf-1");
	assert(
		sScratch?.status === "failed" && sScratch?.error === "无法连接 Redis",
		"步骤 failed + 原因",
	);
	const aScratch = dbMod.getLatestAttempt(db2, "scratch-wf-1");
	assert(
		aScratch?.status === "failed" && aScratch?.error === "无法连接 Redis",
		"attempt failed + 原因",
	);
	const evtAll = dbMod.getEvents(db2, { workflowId: "demo-wf", limit: 100 });
	assert(
		evtAll.some((e) => e.type === "step_verified"),
		"step_verified 事件",
	);
	assert(
		evtAll.some((e) => e.type === "step_needs_fix"),
		"step_needs_fix 事件",
	);

	console.log("== T8 聚合查询 ==");
	const counts = dbMod.stepStatusCounts(db2, "demo-wf");
	// 步骤 1(T4 done)+ 2(T7 approve done)= 2 done;1.1 reported;1.2 needs-fix
	assert(
		counts.done === 2 && counts.reported === 1 && counts["needs-fix"] === 1,
		`状态分布(${JSON.stringify(counts)})`,
	);
	const running = dbMod.getRunningSteps(db2);
	assert(
		running.every((s) => s.status === "running"),
		"running 列表仅 running/dispatched",
	);
	const cost = dbMod.workflowCost(db2, "demo-wf");
	assert(cost === null, "无尝试的 workflow → 成本为 null");
	const costScratch = dbMod.workflowCost(db2, "scratch-wf");
	assert(costScratch !== null && costScratch.attempts === 1, "成本聚合(1 尝试)");
	const kanban = db2
		.prepare(
			"SELECT * FROM v_workflow_kanban WHERE workflow_id = 'demo-wf' ORDER BY sort_order",
		)
		.all() as Array<Record<string, unknown>>;
	assert(
		kanban.length === 4 && kanban[0].id === "demo-wf-1",
		"v_workflow_kanban 视图",
	);
	const evtsDesc = dbMod.getEvents(db2, { workflowId: "demo-wf", limit: 3 });
	assert(
		evtsDesc.length >= 1 && evtsDesc[0].id >= evtsDesc[evtsDesc.length - 1].id,
		"事件倒序返回",
	);

	console.log("== T9 resolveIdentity ==");
	const idxMod = await import("../src/index.ts");
	// 状态段渲染:紧凑单行、着色、running 步骤、待核对/异常计数
	const segWf = dbMod.getWorkflow(db2, "demo-wf")!;
	const segSteps = dbMod.getStepsByWorkflow(db2, "demo-wf");
	const segAll = idxMod.workflowStatusSegment(
		segWf,
		dbMod.stepStatusCounts(db2, "demo-wf"),
		segSteps,
		null,
	);
	const segVisible = segAll.replace(/\x1b\[[0-9;]*m/g, "");
	assert(
		segVisible.startsWith("demo-wf") && segVisible.includes("/"),
		`状态段含 id 与进度(${segVisible})`,
	);
	assert(!segAll.startsWith("["), "状态段不以 [ 开头(powerline 不当通知过滤)");
	// running 步骤 → 🔄N 计数(语义化);待办 → ⏳N
	const runSteps = segSteps.map((s) => ({ ...s }));
	for (const s of runSteps) {
		if (s.id.endsWith(".1")) s.status = "running";
	}
	const segRun = idxMod.workflowStatusSegment(
		segWf,
		{ ...dbMod.stepStatusCounts(db2, "demo-wf"), running: 1, dispatched: 0 },
		runSteps,
		null,
	);
	const segRunVisible = segRun.replace(/\x1b\[[0-9;]*m/g, "");
	assert(
		segRunVisible.includes("🔄1"),
		`running 步骤以 🔄N 计数展示(${segRunVisible})`,
	);
	assert(!segRunVisible.includes("▶"), "不再用 ▶+点号 id 列表(footer 语义化)");
	// 计划概览面板:rpiv-todo 式列表(● 标题 + 树形连接线逐条,完成行删除线)
	const statusUiMod = await import("../src/ui/status.ts");
	const mockTheme = {
		fg: (_c: string, s: string) => s,
		strikethrough: (s: string) => s,
		bold: (s: string) => s,
	};
	const planLines = statusUiMod.buildPlanLines(db2, [segWf], mockTheme, 120);
	const planText = planLines.join("\n");
	const planVisible = planText.replace(/\x1b\[[0-9;]*m/g, "");
	assert(
		planVisible.includes("●") &&
			planVisible.includes("/") &&
			planVisible.includes("(") &&
			!planVisible.includes("┌"),
		`面板为 rpiv-todo 式标题(● 进度计数:${planVisible.slice(0, 60)})`,
	);
	assert(
		/^[├└]─ [🔄◐○✗✓⚠↻–]/mu.test(planVisible),
		`面板逐条渲染(树形连接线 + 状态字形:${planVisible.slice(0, 120)})`,
	);
	// 清掉外部环境可能注入的 PI_WF_*(子 agent tab / 编排环境可能已设置),保证用例 hermetic
	delete process.env.PI_WF_WORKFLOW;
	delete process.env.PI_WF_STEP;
	const fromEnv = idxMod.resolveIdentity("/whatever");
	assert(fromEnv === null, "无 env/cwd 无身份");
	process.env.PI_WF_WORKFLOW = "demo-wf";
	process.env.PI_WF_STEP = "1.1";
	const withEnv = idxMod.resolveIdentity("/whatever");
	assert(
		withEnv?.workflowId === "demo-wf" && withEnv?.stepId === "demo-wf-1.1",
		"env 身份解析",
	);
	delete process.env.PI_WF_WORKFLOW;
	delete process.env.PI_WF_STEP;
	const fromCwd = idxMod.resolveIdentity(
		"/repo/.worktrees/gittree-wf-add-redis-cache-1.2",
	);
	assert(
		fromCwd?.workflowId === "add-redis-cache" && fromCwd?.dotted === "1.2",
		"cwd(worktree 路径)身份解析",
	);
	const fromCwdSub = idxMod.resolveIdentity(
		"/repo/.worktrees/gittree-wf-add-redis-cache-1.2/src/deep",
	);
	assert(fromCwdSub?.stepId === "add-redis-cache-1.2", "cwd 子目录身份解析");

	// ── id 前缀匹配(防手输写错)与撞名报错增强 ──
	const cmdModT9 = await import("../src/command.ts");
	const t9Env = { kind: "cli", cwd: scratchRepo, db: db2 } as never;
	// workflow 唯一前缀命中(scratch-wf 在库)
	const wfByPrefix = cmdModT9.resolveWorkflowId(t9Env, "scratch-w");
	assert(wfByPrefix === "scratch-wf", `workflow 唯一前缀命中(${wfByPrefix})`);
	// 完整 id 直接命中
	assert(
		cmdModT9.resolveWorkflowId(t9Env, "scratch-wf") === "scratch-wf",
		"workflow 完整 id 命中",
	);
	// 无命中 → 原样返回(下游报「workflow 不存在」)
	assert(
		cmdModT9.resolveWorkflowId(t9Env, "no-such-wf") === "no-such-wf",
		"workflow 无命中原样返回",
	);
	// 步骤唯一前缀命中(当前 workflow 内)
	const stepByPrefix = cmdModT9.resolveStepId(t9Env, "scratch-wf-1");
	assert(stepByPrefix !== null, `步骤完整 id 命中(${stepByPrefix?.id})`);
	// 撞名报错增强:导入同名 workflow 报错含 repo/status 上下文
	const dupImp = orchMod.importPlan(
		db2,
		{
			name: "scratch-wf",
			title: "重名",
			goal: "g",
			repoPath: scratchRepo,
			steps: [{ id: "1", title: "a", agent: "worker", task: "a" }],
		},
		tmpDir,
		AGENTS,
	);
	assert(
		!dupImp.ok &&
			(dupImp.errors ?? []).some(
				(e) => e.includes("已存在") && e.includes("repo:"),
			),
		`撞名报错含 repo/status 上下文(${(dupImp.errors ?? []).join(" | ")})`,
	);

	console.log("== T10 monitor 存活检测 ==");
	const monitorMod = await import("../src/observe/monitor.ts");
	// T7 已 fail 过 scratch-wf-1 一次(retries_done=1);调大上限以便本测试多次重派
	dbMod.buildUpdate(
		db2,
		"workflow_steps",
		{ max_retries: 5 },
		{ id: "scratch-wf-1" },
	);
	// 复用 T6 的 scratch 场景:重新派发(可重派)→ running + tab_id
	const sWf2 = dbMod.getWorkflow(db2, "scratch-wf")!;
	const sStep2 = dbMod.getStep(db2, "scratch-wf-1")!;
	const redispatch = await dispatchMod.dispatchStep(db2, sWf2, sStep2, {
		gittreeBin: "gittree",
		ghostctlBin: fakeGhostctl,
	});
	assert(redispatch.ok, "重新派发成功(可重派)");
	const tabId = redispatch.tabId!;
	assert(tabId === "abcdef0123456789", "重派 tab_id");
	// fake layout 不含该 terminal → 单次未命中不判死(抗 Ghostty layout 瞬时抖动)
	const fakeGone = path.join(tmpDir, "fake-ghostctl-gone.sh");
	fs.writeFileSync(
		fakeGone,
		`#!/bin/bash\necho "$@" >> "${ghostctlLog}"\necho '{"windows":[{"id":"tab-group-aabbccddeeff","tabs":[{"terminals":[]}]}]}'\n`,
		{ mode: 0o755 },
	);
	const gone1 = await monitorMod.pollOnce(db2, { ghostctlBin: fakeGone });
	assert(gone1.closed.length === 0, "单次未命中不误判(抗抖动)");
	assert(
		dbMod.getStep(db2, "scratch-wf-1")?.status === "running",
		"单次未命中后仍 running",
	);
	// 连续两次未命中 → aborted
	const gone = await monitorMod.pollOnce(db2, { ghostctlBin: fakeGone });
	assert(gone.closed.includes("scratch-wf-1"), "连续 2 次未命中 → aborted");
	const sAborted = dbMod.getStep(db2, "scratch-wf-1");
	assert(sAborted?.status === "aborted", "步骤状态 aborted");
	const evtClosed = dbMod
		.getEvents(db2, { workflowId: "scratch-wf", limit: 100 })
		.some((e) => e.type === "step_tab_closed");
	assert(evtClosed, "step_tab_closed 事件");
	// fake layout 含该 terminal → pollOnce 保持 running
	const re2 = await dispatchMod.dispatchStep(
		db2,
		sWf2,
		dbMod.getStep(db2, "scratch-wf-1")!,
		{
			gittreeBin: "gittree",
			ghostctlBin: fakeGhostctl,
		},
	);
	assert(re2.ok, "aborted 后可重派");
	const alive = await monitorMod.pollOnce(db2, { ghostctlBin: fakeGhostctl });
	assert(alive.closed.length === 0, "tab 存活 → 保持 running");
	assert(
		dbMod.getStep(db2, "scratch-wf-1")?.status === "running",
		"步骤保持 running",
	);
	// 命中清零:未命中 1 次 → 命中 1 次 → 再未命中 1 次,仍不判死(计数已被清零)
	await monitorMod.pollOnce(db2, { ghostctlBin: fakeGone });
	await monitorMod.pollOnce(db2, { ghostctlBin: fakeGhostctl });
	const flicker = await monitorMod.pollOnce(db2, { ghostctlBin: fakeGone });
	assert(flicker.closed.length === 0, "命中后计数清零,抖动不累积");
	assert(
		dbMod.getStep(db2, "scratch-wf-1")?.status === "running",
		"清零后仍 running",
	);
	// 去重复用:tab 仍存活时 retry → 不重开新 tab,恢复 running,retries 不消耗
	dbMod.updateStepStatus(db2, "scratch-wf-1", "aborted", {
		error: "模拟 monitor 误判",
	});
	const logBefore = fs
		.readFileSync(ghostctlLog, "utf-8")
		.split("\n")
		.filter(Boolean).length;
	const retriesBefore = dbMod.getStep(db2, "scratch-wf-1")!.retries_done;
	const reuse = await dispatchMod.dispatchStep(
		db2,
		sWf2,
		dbMod.getStep(db2, "scratch-wf-1")!,
		{ gittreeBin: "gittree", ghostctlBin: fakeGhostctl },
	);
	assert(
		reuse.ok && reuse.reused === true,
		`tab 存活 → 复用不重开(${reuse.error ?? ""})`,
	);
	assert(
		dbMod.getStep(db2, "scratch-wf-1")?.status === "running",
		"复用后恢复 running",
	);
	assert(
		dbMod.getStep(db2, "scratch-wf-1")?.tab_id === "abcdef0123456789",
		"复用保留原 tab_id",
	);
	assert(
		dbMod.getStep(db2, "scratch-wf-1")?.retries_done === retriesBefore,
		"复用不消耗 retries_done",
	);
	const logAfterReuse = fs
		.readFileSync(ghostctlLog, "utf-8")
		.split("\n")
		.filter(Boolean)
		.slice(logBefore);
	assert(
		!logAfterReuse.some((l) => l.includes("new-tab")),
		`复用未调用 new-tab(${logAfterReuse.join(" | ")})`,
	);
	// 对照:tab 已死时 retry → 正常重开(new-tab 被调用)
	dbMod.updateStepStatus(db2, "scratch-wf-1", "aborted", {
		error: "tab 已关闭",
	});
	const logBefore2 = fs
		.readFileSync(ghostctlLog, "utf-8")
		.split("\n")
		.filter(Boolean).length;
	const reopen = await dispatchMod.dispatchStep(
		db2,
		sWf2,
		dbMod.getStep(db2, "scratch-wf-1")!,
		{ gittreeBin: "gittree", ghostctlBin: fakeGone },
	);
	assert(reopen.ok && reopen.reused !== true, "tab 已死 → 正常重开");
	const logAfterReopen = fs
		.readFileSync(ghostctlLog, "utf-8")
		.split("\n")
		.filter(Boolean)
		.slice(logBefore2);
	assert(
		logAfterReopen.some((l) => l.includes("new-tab")),
		`重开调用 new-tab(log=${logAfterReopen.join(" | ") || "(空)"})`,
	);

	// ── fs.watch 事件驱动:跨连接写库 → watch 触发 → 毫秒级检测(非轮询)──
	const watchLog = path.join(tmpDir, "watch-events.log");
	fs.writeFileSync(watchLog, "");
	const wfStop = monitorMod.startMonitor(db2, {
		ghostctlBin: fakeGhostctl,
		cwd: scratchRepo,
		intervalMs: 60_000, // 轮询拉长:证明事件由 fs.watch 触发而非轮询
		watchDebounceMs: 50,
		onState: async (items) => {
			fs.appendFileSync(
				watchLog,
				items.map((i) => `${i.kind}:${i.stepId}`).join(",") + "\n",
			);
		},
	});
	// 第二个连接模拟"另一个进程(子 agent/CLI)写库"——WAL 落盘 → 目录 watch 触发
	const watchConn = new DatabaseSync(process.env.WF_DB_PATH!);
	watchConn
		.prepare(
			"UPDATE workflow_steps SET status='reported' WHERE id='scratch-wf-1'",
		)
		.run();
	watchConn.close();
	await new Promise((r) => setTimeout(r, 900)); // debounce(50)+tick(ghostctl)+detect
	wfStop();
	const watchEvts = fs.readFileSync(watchLog, "utf-8");
	assert(
		watchEvts.includes("reported:scratch-wf-1"),
		`fs.watch 写库触发立即检测(${watchEvts.trim() || "(无事件)"})`,
	);
	// 恢复状态(绕过状态机直接还原,不干扰后续测试)
	db2
		.prepare("UPDATE workflow_steps SET status='running' WHERE id='scratch-wf-1'")
		.run();
	dbMod.setStepMeta(db2, "scratch-wf-1", "notify:reported", null);

	console.log("== T11 就绪集 getReadySteps ==");
	const readyWf = orchMod.importPlan(
		db2,
		{
			name: "ready-wf",
			title: "就绪集",
			goal: "测试",
			repoPath: scratchRepo,
			steps: [
				{ id: "1", title: "方案", agent: "planner", task: "方案" },
				{ id: "1.1", title: "A", agent: "worker", deps: ["1"], task: "A" },
				{ id: "1.2", title: "B", agent: "worker", deps: ["1"], task: "B" },
				{
					id: "2",
					title: "评审",
					agent: "reviewer",
					deps: ["1.1", "1.2"],
					task: "评",
				},
			],
		},
		tmpDir,
		AGENTS,
	);
	assert(readyWf.ok, "ready-wf 导入");
	const ready1 = monitorMod.getReadySteps(db2, "ready-wf");
	assert(
		ready1.length === 1 && ready1[0].id === "ready-wf-1",
		`就绪集初始仅顶层(${ready1.map((s) => s.id).join(",")})`,
	);
	dbMod.updateStepStatus(db2, "ready-wf-1", dbMod.STEP_STATUS.done);
	const ready2 = monitorMod.getReadySteps(db2, "ready-wf");
	assert(
		ready2.length === 2 &&
			ready2.every((s) => s.id === "ready-wf-1.1" || s.id === "ready-wf-1.2"),
		`1 done 后就绪集为 1.1/1.2(${ready2.map((s) => s.id).join(",")})`,
	);
	dbMod.updateStepStatus(db2, "ready-wf-1.1", dbMod.STEP_STATUS.done);
	dbMod.updateStepStatus(db2, "ready-wf-1.2", dbMod.STEP_STATUS.done);
	const ready3 = monitorMod.getReadySteps(db2, "ready-wf");
	assert(
		ready3.length === 1 && ready3[0].id === "ready-wf-2",
		`1.1/1.2 done 后就绪集为 2(${ready3.map((s) => s.id).join(",")})`,
	);

	console.log("== T12 mergeWave 真实合并 =");
	const mergeWf = orchMod.importPlan(
		db2,
		{
			name: "merge-wf",
			title: "合并",
			goal: "测试合并",
			repoPath: scratchRepo,
			steps: [
				{ id: "1", title: "改文件A", agent: "worker", task: "A" },
				{ id: "2", title: "改文件B", agent: "worker", task: "B" },
			],
		},
		tmpDir,
		AGENTS,
	);
	assert(mergeWf.ok, "merge-wf 导入");
	const mWf = dbMod.getWorkflow(db2, "merge-wf")!;
	for (const dotted of ["1", "2"]) {
		const step = dbMod.getStep(db2, `merge-wf-${dotted}`)!;
		const res = await dispatchMod.dispatchStep(db2, mWf, step, {
			gittreeBin: "gittree",
			ghostctlBin: fakeGhostctl,
		});
		assert(res.ok, `merge-wf-${dotted} 派发`);
		// 子任务在 worktree 里真实提交
		const wt = path.join(
			scratchRepo,
			".worktrees",
			`gittree-wf-merge-wf-${dotted}`,
		);
		fs.writeFileSync(path.join(wt, `feat-${dotted}.txt`), `${dotted}\n`);
		execFileSync("git", ["-C", wt, "add", "-A"]);
		execFileSync("git", ["-C", wt, "commit", "-q", "-m", `feat ${dotted}`]);
		dbMod.updateStepStatus(db2, `merge-wf-${dotted}`, dbMod.STEP_STATUS.done);
	}
	// 未全部完成时拒绝合并
	dbMod.updateStepStatus(db2, "merge-wf-2", dbMod.STEP_STATUS.running);
	const blockedMerge = await monitorMod.mergeWave(db2, mWf, 1);
	assert(
		!blockedMerge.ok && blockedMerge.error!.includes("未全部完成"),
		"未完成拒绝合并",
	);
	dbMod.updateStepStatus(db2, "merge-wf-2", dbMod.STEP_STATUS.done);
	// 真实串行合并
	const merged = await monitorMod.mergeWave(db2, mWf, 1);
	assert(
		merged.ok && merged.merged.length === 2,
		`wave 合并完成(${merged.merged.join(",")})`,
	);
	const waveRow = db2
		.prepare(
			"SELECT status FROM workflow_waves WHERE workflow_id='merge-wf' AND seq=1",
		)
		.get() as { status: string };
	assert(waveRow.status === "merged", "wave → merged");
	const evtMerged = dbMod
		.getEvents(db2, { workflowId: "merge-wf", limit: 100 })
		.some((e) => e.type === "wave_merged");
	assert(evtMerged, "wave_merged 事件");
	// 主分支应包含子任务提交
	const log = execFileSync(
		"git",
		["-C", scratchRepo, "log", "--oneline", "-5"],
		{
			encoding: "utf-8",
		},
	);
	assert(
		log.includes("feat 1") && log.includes("feat 2"),
		`主分支含子任务提交(${log.trim().split("\n")[0]})`,
	);
	// merge --delete 后 worktree 已清理
	assert(
		!fs.existsSync(path.join(scratchRepo, ".worktrees", "gittree-wf-merge-wf-1")),
		"merge --delete 清理 worktree",
	);
	// skipped 步骤:不合并但 worktree/分支一并清理(合并主线后不留 gittree 残留)
	const sweepWf = orchMod.importPlan(
		db2,
		{
			name: "sweep-wf",
			title: "清理",
			goal: "测试 skipped 清理",
			repoPath: scratchRepo,
			steps: [
				{ id: "1", title: "跳过", agent: "worker", task: "skip" },
				{ id: "2", title: "合并", agent: "worker", task: "merge" },
			],
		},
		tmpDir,
		AGENTS,
	);
	assert(sweepWf.ok, "sweep-wf 导入");
	const swWf = dbMod.getWorkflow(db2, "sweep-wf")!;
	// 步骤 1 派发后人工 skip(worktree 真实存在)
	const sw1 = dbMod.getStep(db2, "sweep-wf-1")!;
	const sw1Res = await dispatchMod.dispatchStep(db2, swWf, sw1, {
		gittreeBin: "gittree",
		ghostctlBin: fakeGhostctl,
	});
	assert(sw1Res.ok, "sweep-wf-1 派发(worktree 创建)");
	const sw1Wt = path.join(scratchRepo, ".worktrees", "gittree-wf-sweep-wf-1");
	assert(fs.existsSync(sw1Wt), "sweep-wf-1 worktree 目录存在");
	dbMod.updateStepStatus(db2, "sweep-wf-1", dbMod.STEP_STATUS.skipped);
	// 步骤 2 派发 + 真实提交 + done
	const sw2 = dbMod.getStep(db2, "sweep-wf-2")!;
	const sw2Res = await dispatchMod.dispatchStep(db2, swWf, sw2, {
		gittreeBin: "gittree",
		ghostctlBin: fakeGhostctl,
	});
	assert(sw2Res.ok, "sweep-wf-2 派发");
	const sw2Wt = path.join(scratchRepo, ".worktrees", "gittree-wf-sweep-wf-2");
	fs.writeFileSync(path.join(sw2Wt, "merge.txt"), "m\n");
	execFileSync("git", ["-C", sw2Wt, "add", "-A"]);
	execFileSync("git", ["-C", sw2Wt, "commit", "-q", "-m", "merge 2"]);
	dbMod.updateStepStatus(db2, "sweep-wf-2", dbMod.STEP_STATUS.done);
	const swept = await monitorMod.mergeWave(db2, swWf, 1);
	assert(swept.ok && swept.merged.length === 1, "sweep-wf 合并完成(仅步骤 2)");
	assert(
		!fs.existsSync(sw1Wt) && !fs.existsSync(sw2Wt),
		"skipped 步骤 worktree 已清理 + 合并步骤已清理",
	);
	const sweepEvt = dbMod
		.getEvents(db2, { stepId: "sweep-wf-1", limit: 20 })
		.some((e) => e.type === "worktree_cleaned");
	assert(sweepEvt, "skipped 清理触发 worktree_cleaned 事件");

	console.log("== T13 retry 上下文注入 / max_retries ==");
	// ready-wf-2 依赖 1.1/1.2(已 done),标 failed 后重派
	dbMod.updateStepStatus(db2, "ready-wf-2", dbMod.STEP_STATUS.failed, {
		error: "编译失败",
	});
	const rw = dbMod.getWorkflow(db2, "ready-wf")!;
	const rwStep2 = dbMod.getStep(db2, "ready-wf-2")!;
	const retryMd = dispatchMod.renderTaskMd(db2, rw, rwStep2, 1);
	assert(
		retryMd.includes("上次尝试反馈") && retryMd.includes("编译失败"),
		"重派注入上次失败原因",
	);
	const retryRes = await dispatchMod.dispatchStep(db2, rw, rwStep2, {
		gittreeBin: "gittree",
		ghostctlBin: fakeGhostctl,
	});
	assert(retryRes.ok, "failed 可重派");
	assert(
		dbMod.getStep(db2, "ready-wf-2")?.retries_done === 1,
		"retries_done 递增",
	);
	// 再失败 → 超过 max_retries(默认 1)拒绝
	dbMod.updateStepStatus(db2, "ready-wf-2", dbMod.STEP_STATUS.failed, {
		error: "又失败",
	});
	const over = await dispatchMod.dispatchStep(
		db2,
		rw,
		dbMod.getStep(db2, "ready-wf-2")!,
		{ gittreeBin: "gittree", ghostctlBin: fakeGhostctl },
	);
	assert(!over.ok && over.error!.includes("上限"), "超过 max_retries 拒绝");

	console.log("== T14 usage 落库 + budget 护栏 ==");
	const r14 = orchMod.reportDone(db2, "ready-wf-2", {
		summary: "完成",
		filesChanged: [],
		issues: [],
		tests: "passed",
		usage: { input: 1000, output: 500, costCents: 200, turns: 3 },
	});
	assert(r14.ok, "带 usage 回报成功");
	const att2 = dbMod.getLatestAttempt(db2, "ready-wf-2");
	assert(
		att2?.usage_input === 1000 && att2?.usage_cost_cents === 200,
		"attempt usage 落库",
	);
	const step2b = dbMod.getStep(db2, "ready-wf-2");
	assert(step2b?.usage_cost_cents === 200, "step usage 汇总");
	dbMod.buildUpdate(db2, "workflow", { budget_cents: 100 }, { id: "ready-wf" });
	const budget = orchMod.checkBudget(db2, dbMod.getWorkflow(db2, "ready-wf")!);
	assert(!budget.ok && budget.reason!.includes("预算"), "预算超限拒绝");
	const budgetOk = orchMod.checkBudget(db2, dbMod.getWorkflow(db2, "merge-wf")!);
	assert(budgetOk.ok, "无预算放行");

	console.log("== T15 超时检查 ==");
	// 构造 running 但 started_at 在 timeout_min 之前的步骤
	dbMod.updateStepStatus(db2, "ready-wf-1", dbMod.STEP_STATUS.running);
	db2
		.prepare(
			"UPDATE workflow_steps SET started_at = ?, timeout_min = 1 WHERE id = 'ready-wf-1'",
		)
		.run(Date.now() - 3 * 60 * 1000);
	const poll = await monitorMod.pollOnce(db2, { ghostctlBin: fakeGhostctl });
	assert(poll.timedOut.includes("ready-wf-1"), "超时标 aborted");
	assert(
		dbMod.getStep(db2, "ready-wf-1")?.status === "aborted",
		"超时步骤 aborted",
	);

	console.log("== T16 planner 输出解析 ==");
	const plannerMod = await import("../src/planner.ts");
	const pure = plannerMod.parsePlannerOutput(
		'{"name":"a","title":"t","goal":"g","steps":[{"id":"1","title":"x","agent":"worker","task":"y"}]}',
	);
	assert(
		(pure as { name: string }).name === "a" &&
			(pure as { steps: unknown[] }).steps.length === 1,
		"纯 JSON 解析",
	);
	const fenced = plannerMod.parsePlannerOutput(
		'好的,计划如下:\n```json\n{"name":"b","title":"t","goal":"g","steps":[]}\n```\n请确认',
	);
	assert((fenced as { name: string }).name === "b", "```json 围栏解析");
	const plain = plannerMod.parsePlannerOutput(
		'计划:{"name":"c","title":"t","goal":"g","steps":[]}完毕',
	);
	assert((plain as { name: string }).name === "c", "前后文夹杂解析");
	let threw = false;
	try {
		plannerMod.parsePlannerOutput("抱歉,我无法完成");
	} catch {
		threw = true;
	}
	assert(threw, "无 JSON 报错");

	console.log("== T17 goal-check 状态机 ==");
	// 进入 verifying
	dbMod.updateWorkflowStatus(db2, "ready-wf", dbMod.WORKFLOW_STATUS.running);
	const gcStart = orchMod.goalCheckEnter(db2, "ready-wf");
	assert(
		gcStart.ok && dbMod.getWorkflow(db2, "ready-wf")?.status === "verifying",
		"进入 verifying",
	);
	const evtStart = dbMod
		.getEvents(db2, { workflowId: "ready-wf", limit: 100 })
		.some((e) => e.type === "workflow_goal_check_started");
	assert(evtStart, "workflow_goal_check_started 事件");
	// approve → completed
	const gcApprove = orchMod.goalCheckApprove(db2, "ready-wf", "全部达成");
	assert(
		gcApprove.ok && dbMod.getWorkflow(db2, "ready-wf")?.status === "completed",
		"approve → completed",
	);
	let goalCheckResult = "";
	try {
		goalCheckResult = (
			JSON.parse(dbMod.getWorkflow(db2, "ready-wf")?.goal_check ?? "{}") as {
				result: string;
			}
		).result;
	} catch {
		goalCheckResult = "";
	}
	assert(goalCheckResult === "passed", "goal_check 落库");
	// reject 路径:merge-wf → verifying → reject → running
	dbMod.updateWorkflowStatus(db2, "merge-wf", dbMod.WORKFLOW_STATUS.running);
	orchMod.goalCheckEnter(db2, "merge-wf");
	const gcReject = orchMod.goalCheckReject(db2, "merge-wf", "还差文档");
	assert(
		gcReject.ok && dbMod.getWorkflow(db2, "merge-wf")?.status === "running",
		"reject → 回 running(gap wave)",
	);
	const evtFail = dbMod
		.getEvents(db2, { workflowId: "merge-wf", limit: 100 })
		.some((e) => e.type === "workflow_goal_check_failed");
	assert(evtFail, "workflow_goal_check_failed 事件");

	console.log("== T18 next 滚动 + appendSteps ==");
	const nextRes = orchMod.nextWave(db2, "merge-wf", "补齐文档");
	assert(nextRes.ok && nextRes.seq === 2, `wave 2 创建(${nextRes.seq})`);
	assert(
		dbMod.getWorkflow(db2, "merge-wf")?.current_wave === 2,
		"current_wave 滚动到 2",
	);
	const evtWave = dbMod
		.getEvents(db2, { workflowId: "merge-wf", limit: 100 })
		.some((e) => e.type === "wave_started");
	assert(evtWave, "wave_started 事件");
	// 追加步骤到 wave 2(gap wave)
	const appendRes = orchMod.appendSteps(
		db2,
		"merge-wf",
		2,
		{
			name: "merge-wf",
			title: "补齐",
			goal: "还差文档",
			steps: [{ id: "3", title: "补文档", agent: "worker", task: "写 README" }],
		},
		tmpDir,
		AGENTS,
	);
	assert(appendRes.ok && appendRes.added === 1, "gap wave 追加步骤");
	assert(dbMod.getStep(db2, "merge-wf-3")?.wave_id !== null, "新步骤挂 wave 2");
	const dupAppend = orchMod.appendSteps(
		db2,
		"merge-wf",
		2,
		{
			name: "merge-wf",
			title: "补齐",
			goal: "还差文档",
			steps: [{ id: "3", title: "重复", agent: "worker", task: "x" }],
		},
		tmpDir,
		AGENTS,
	);
	assert(
		!dupAppend.ok && dupAppend.errors![0].includes("已存在"),
		"重复 dotted 拒绝",
	);

	console.log("== T19 看板 buildBoard / 渲染 ==");
	const boardMod = await import("../src/ui/board.ts");
	const demoBoard = boardMod.buildBoard(db2, "demo-wf");
	assert(demoBoard !== null && demoBoard.total === 4, "看板 4 张卡片");
	const colKeys = demoBoard!.columns.map((c) => c.key);
	assert(
		colKeys.join(",") === "todo,running,verify,done,abnormal",
		"5 列顺序正确",
	);
	const doneCards = demoBoard!.columns.find((c) => c.key === "done")!.cards;
	assert(doneCards.length === 2, "done 列 2 张");
	const abnormalCards = demoBoard!.columns.find(
		(c) => c.key === "abnormal",
	)!.cards;
	assert(
		abnormalCards.length === 1 && abnormalCards[0].status === "needs-fix",
		"异常列 needs-fix",
	);
	const text = boardMod.renderBoardText(demoBoard!);
	assert(
		text.some((l) => l.includes("待办")) && text.some((l) => l.includes("2/4")),
		"文本看板含列头与进度",
	);
	const w2Board = boardMod.buildBoard(db2, "merge-wf", 2);
	assert(w2Board !== null && w2Board.total === 1, "wave 2 过滤(1 张卡片)");
	const html = boardMod.renderBoardHtml(demoBoard!);
	assert(
		html.includes("<!DOCTYPE html>") &&
			html.includes("wf demo-wf 看板") &&
			html.includes('<div class="board">'),
		"HTML 看板结构",
	);
	const htmlEsc = boardMod.renderBoardHtml({
		workflowId: 'x&<>"wf',
		title: "t<>&",
		goal: "g",
		status: "running",
		wave: null,
		columns: [
			{
				key: "todo",
				label: "待办",
				cards: [
					{
						id: 'x&<>"wf-1',
						dotted: "1",
						title: "a<&>",
						agent: "w",
						status: "pending",
						gate: false,
						depth: 1,
						summary: null,
					},
				],
			},
		],
		total: 1,
		done: 0,
	});
	assert(
		!htmlEsc.includes('x&<>"wf-1') && htmlEsc.includes("x&amp;&lt;&gt;"),
		"HTML 转义(XSS 防护)",
	);

	console.log(
		"== T20 状态事件通知 detectStateChanges / markNotified / sendWorkflowNotifications ==",
	);
	// 构造覆盖 6 种步骤级事件的工作流
	const notifyWf = orchMod.importPlan(
		db2,
		{
			name: "notify-wf",
			title: "通知",
			goal: "测试通知",
			repoPath: scratchRepo,
			steps: [
				{ id: "1", title: "非gate回报", agent: "worker", task: "a" },
				{
					id: "1.1",
					title: "gate待核对",
					agent: "reviewer",
					task: "b",
					gate: true,
				},
				{ id: "1.2", title: "失败", agent: "worker", task: "c" },
				{ id: "1.3", title: "中止", agent: "worker", task: "d" },
				{ id: "1.4", title: "冲突", agent: "worker", task: "e" },
				{ id: "1.5", title: "待修复", agent: "worker", task: "f" },
			],
		},
		tmpDir,
		AGENTS,
	);
	assert(notifyWf.ok, "notify-wf 导入");
	dbMod.updateStepStatus(db2, "notify-wf-1", dbMod.STEP_STATUS.reported);
	dbMod.updateStepStatus(db2, "notify-wf-1.1", dbMod.STEP_STATUS.waitingVerify);
	dbMod.updateStepStatus(db2, "notify-wf-1.2", dbMod.STEP_STATUS.failed, {
		error: "x",
	});
	dbMod.updateStepStatus(db2, "notify-wf-1.3", dbMod.STEP_STATUS.aborted, {
		error: "x",
	});
	dbMod.updateStepStatus(db2, "notify-wf-1.4", dbMod.STEP_STATUS.conflict, {
		error: "x",
	});
	dbMod.updateStepStatus(db2, "notify-wf-1.5", dbMod.STEP_STATUS.needsFix, {
		error: "x",
	});
	const notifyFilter = (arr: NotifyItem[]) =>
		arr.filter((i) => i.workflowId === "notify-wf");
	const items1 = notifyFilter(monitorMod.detectStateChanges(db2));
	assert(
		items1.length === 6,
		`6 种步骤事件全部检测(${items1.map((i) => i.kind).join(",")})`,
	);
	const stepKinds = items1.map((i) => i.kind);
	for (const k of [
		"reported",
		"waiting-verify",
		"failed",
		"aborted",
		"conflict",
		"needs-fix",
	]) {
		assert((stepKinds as string[]).includes(k), `检测到 ${k} 事件`);
	}
	assert(
		items1.every((i) => i.text.includes("/wf ")),
		"每条文案含具体 /wf 命令",
	);
	assert(
		items1
			.find((i) => i.stepId === "notify-wf-1")!
			.text.includes("/wf verify notify-wf-1 approve"),
		"reported 文案指向 /wf verify approve",
	);
	assert(
		items1
			.find((i) => i.stepId === "notify-wf-1.1")!
			.text.includes("/wf verify notify-wf-1.1 reject"),
		"waiting-verify 文案含 /wf verify reject 分支",
	);
	assert(
		items1
			.find((i) => i.stepId === "notify-wf-1.2")!
			.text.includes("/wf retry notify-wf-1.2"),
		"failed 文案指向 /wf retry",
	);
	// 标记后同 attempt 不再重复
	for (const item of items1) monitorMod.markNotified(db2, item, { now: 1000 });
	assert(
		notifyFilter(monitorMod.detectStateChanges(db2)).length === 0,
		"同 attempt 标记后不再重复通知",
	);
	// attemptId 变化(重试后)→ 重新通知
	dbMod.createAttempt(db2, "notify-wf-1", { taskMd: "t", pointer: "p" });
	const items2 = notifyFilter(monitorMod.detectStateChanges(db2));
	assert(
		items2.length === 1 &&
			items2[0].stepId === "notify-wf-1" &&
			items2[0].kind === "reported",
		"attemptId 变化(重试)→ 重新通知",
	);
	monitorMod.markNotified(db2, items2[0], { now: 1001 });

	console.log("== T20b wave-done / workflow-done =");
	const doneWf = orchMod.importPlan(
		db2,
		{
			name: "notify-done-wf",
			title: "完成",
			goal: "测试完成通知",
			repoPath: scratchRepo,
			steps: [
				{ id: "1", title: "A", agent: "worker", task: "a" },
				{ id: "2", title: "B", agent: "worker", task: "b" },
			],
		},
		tmpDir,
		AGENTS,
	);
	assert(doneWf.ok, "notify-done-wf 导入");
	dbMod.updateStepStatus(db2, "notify-done-wf-1", dbMod.STEP_STATUS.done);
	dbMod.updateStepStatus(db2, "notify-done-wf-2", dbMod.STEP_STATUS.done);
	const doneFilter = (arr: NotifyItem[]) =>
		arr.filter((i) => i.workflowId === "notify-done-wf");
	const wd = doneFilter(monitorMod.detectStateChanges(db2));
	assert(
		wd.length === 1 && wd[0].kind === "wave-done",
		"wave 全部终态 → wave-done",
	);
	assert(
		wd[0].text.includes("/wf merge") && wd[0].waveSeq === 1,
		"wave-done 文案含 /wf merge",
	);
	monitorMod.markNotified(db2, wd[0], { now: 1000 });
	assert(
		doneFilter(monitorMod.detectStateChanges(db2)).length === 0,
		"wave-done 去重",
	);
	// wave 合并后 → workflow-done
	db2
		.prepare(
			"UPDATE workflow_waves SET status='merged' WHERE workflow_id='notify-done-wf' AND seq=1",
		)
		.run();
	const wfd = doneFilter(monitorMod.detectStateChanges(db2));
	assert(
		wfd.length === 1 &&
			wfd[0].kind === "workflow-done" &&
			wfd[0].text.includes("/wf goal-check approve"),
		"全部 wave 合并 → workflow-done(含 /wf goal-check)",
	);
	monitorMod.markNotified(db2, wfd[0], { now: 1000 });
	assert(
		doneFilter(monitorMod.detectStateChanges(db2)).length === 0,
		"workflow-done 去重",
	);
	// 已 completed(goal-check approve 后)→ 不再补发 workflow-done(过时提醒)
	db2
		.prepare(
			"UPDATE workflow_waves SET status='planned' WHERE workflow_id='notify-done-wf' AND seq=1",
		)
		.run();
	db2
		.prepare(
			"UPDATE workflow_waves SET status='merged' WHERE workflow_id='notify-done-wf' AND seq=1",
		)
		.run();
	const gcr = await orchMod.goalCheckApprove(db2, "notify-done-wf", "通过");
	assert(gcr.ok, "goal-check approve 成功");
	assert(
		doneFilter(monitorMod.detectStateChanges(db2)).length === 0,
		"completed 后不再补发 workflow-done(approve 已标记)",
	);

	console.log("== T20c 聚合发送 sendWorkflowNotifications =");
	const sent: Array<{ content: string; options: unknown }> = [];
	const uiNotifies: Array<{ msg: string; type?: string }> = [];
	const fakeSender = {
		sendMessage: async (msg: { content: string }, options: unknown) => {
			sent.push({ content: msg.content, options });
		},
		ui: {
			notify: (msg: string, type?: string) => {
				uiNotifies.push({ msg, type });
			},
		},
	};
	// 7 条待发事件 → 单条聚合消息最多 5 行,超出留到下一轮
	const overWf = orchMod.importPlan(
		db2,
		{
			name: "notify-over-wf",
			title: "溢出",
			goal: "溢出测试",
			repoPath: scratchRepo,
			steps: Array.from({ length: 7 }, (_, i) => ({
				id: `${i + 1}`,
				title: `S${i + 1}`,
				agent: "worker",
				task: "t",
			})),
		},
		tmpDir,
		AGENTS,
	);
	assert(overWf.ok, "notify-over-wf 导入");
	for (let i = 1; i <= 7; i++) {
		dbMod.updateStepStatus(
			db2,
			`notify-over-wf-${i}`,
			dbMod.STEP_STATUS.reported,
		);
	}
	const overFilter = (arr: NotifyItem[]) =>
		arr.filter((i) => i.workflowId === "notify-over-wf");
	const overItems = overFilter(monitorMod.detectStateChanges(db2));
	assert(overItems.length === 7, `7 个事件待通知(${overItems.length})`);
	await idxMod.sendWorkflowNotifications(db2, fakeSender, overItems);
	assert(sent.length === 1, "一次调用发送一条聚合消息");
	const sentOpts = sent[0].options as {
		deliverAs: string;
		triggerTurn: boolean;
	};
	assert(
		sentOpts.deliverAs === "followUp" && sentOpts.triggerTurn === true,
		"deliverAs=followUp + triggerTurn(不打断,空闲唤醒)",
	);
	const lines = sent[0].content.split("\n").filter((l) => l.startsWith("- "));
	assert(lines.length === 5, "单条聚合最多 5 行");
	assert(
		sent[0].content.includes("workflow-notify") === false &&
			sent[0].content.includes("/wf verify notify-over-wf-1"),
		"聚合文案含具体命令",
	);
	const remain = overFilter(monitorMod.detectStateChanges(db2));
	assert(remain.length === 2, "超出 5 行的留到下一轮(未标记)");
	// 降级:sendMessage 抛错 → ui.notify,仍标记去重
	const throwingSender = {
		sendMessage: async () => {
			throw new Error("sendMessage 不可用");
		},
		ui: {
			notify: (msg: string, type?: string) => {
				uiNotifies.push({ msg, type });
			},
		},
	};
	await idxMod.sendWorkflowNotifications(db2, throwingSender, remain);
	assert(
		uiNotifies.length === 1 && uiNotifies[0].msg.includes("/wf verify"),
		"sendMessage 失败降级 ctx.ui.notify",
	);
	assert(
		overFilter(monitorMod.detectStateChanges(db2)).length === 0,
		"降级发送后同样标记去重",
	);
	// 空 items → 不发送
	sent.length = 0;
	await idxMod.sendWorkflowNotifications(db2, fakeSender, []);
	assert(sent.length === 0, "无事件不发送");

	console.log(
		"== T20d 会话隔离:listActiveWorkflows/detectStateChanges 按 repo 过滤 ==",
	);
	// 两个不同仓库的 workflow
	const isoA = orchMod.importPlan(
		db2,
		{
			name: "iso-a",
			title: "a",
			goal: "g",
			repoPath: "/repo/a",
			steps: [{ id: "1", title: "a1", agent: "worker", task: "a1" }],
		},
		tmpDir,
		AGENTS,
	);
	const isoB = orchMod.importPlan(
		db2,
		{
			name: "iso-b",
			title: "b",
			goal: "g",
			repoPath: "/repo/b",
			steps: [{ id: "1", title: "b1", agent: "worker", task: "b1" }],
		},
		tmpDir,
		AGENTS,
	);
	assert(isoA.ok && isoB.ok, "iso-a/iso-b 导入");
	// 全量 vs 按 repo 过滤
	assert(
		dbMod.listActiveWorkflows(db2).some((w) => w.id === "iso-a") &&
			dbMod.listActiveWorkflows(db2).some((w) => w.id === "iso-b"),
		"全量包含两个仓库",
	);
	const mineA = dbMod.listActiveWorkflows(db2, "/repo/a");
	assert(
		mineA.length === 1 && mineA[0].id === "iso-a",
		`按 repo 过滤: /repo/a 只见 iso-a(${mineA.map((w) => w.id).join(",")})`,
	);
	const subA = dbMod.listActiveWorkflows(db2, "/repo/a/sub/dir");
	assert(
		subA.length === 1 && subA[0].id === "iso-a",
		"cwd 在 repo 子目录内也算归属",
	);
	// detectStateChanges 隔离:iso-a-1 reported → 只有 repoPath=/repo/a 才产出事件
	dbMod.updateStepStatus(db2, "iso-a-1", dbMod.STEP_STATUS.reported);
	const evB = monitorMod.detectStateChanges(db2, { repoPath: "/repo/b" });
	assert(
		!evB.some((i) => i.stepId === "iso-a-1"),
		`/repo/b 会话看不到 iso-a 的事件(${evB.map((i) => i.stepId).join(",") || "无"})`,
	);
	const evA = monitorMod.detectStateChanges(db2, { repoPath: "/repo/a" });
	assert(
		evA.some((i) => i.stepId === "iso-a-1"),
		"/repo/a 会话收到 iso-a 的事件",
	);
	// owner 通道:发起者 cwd(importPlan 的 cwd=tmpDir)也能看到自己发起的 workflow
	const ownerView = dbMod.listActiveWorkflows(db2, tmpDir);
	assert(
		ownerView.some((w) => w.id === "iso-a") &&
			ownerView.some((w) => w.id === "iso-b"),
		`发起者目录(owner_cwd)可见自己发起的 workflow(${ownerView.map((w) => w.id).join(",")})`,
	);
	const evOwner = monitorMod.detectStateChanges(db2, { repoPath: tmpDir });
	assert(
		evOwner.some((i) => i.stepId === "iso-a-1"),
		"发起者目录收到自己 workflow 的事件(owner 通道)",
	);
	const otherView = dbMod.listActiveWorkflows(db2, "/somewhere/else");
	assert(
		!otherView.some((w) => w.id === "iso-a" || w.id === "iso-b"),
		"无关目录双通道都不匹配 → 不可见",
	);

	console.log("== T21 pollTargetReached 纯函数 + wf poll 退出码 ==");
	const pollMod = await import("../src/observe/monitor.ts");
	const mkSteps = (...statuses: string[]): StepRow[] =>
		statuses.map((s, i) => ({ id: `t${i}`, status: s }) as unknown as StepRow);
	{
		const r = pollMod.pollTargetReached(
			mkSteps("done", "done", "skipped"),
			"done",
		);
		assert(
			r.reached && r.unreachable.length === 0 && r.notStarted === 0,
			"达成集:done+skipped 全终态 → reached",
		);
	}
	{
		const r = pollMod.pollTargetReached(mkSteps("done", "pending"), "done");
		assert(
			r.reached && r.notStarted === 1,
			"pending 未派发不阻塞达成(只计 notStarted)",
		);
	}
	{
		const r = pollMod.pollTargetReached(mkSteps("done", "running"), "done");
		assert(!r.reached && r.unreachable.length === 0, "running 未达成不 reached");
	}
	{
		const r = pollMod.pollTargetReached(mkSteps("done", "failed"), "done");
		assert(
			!r.reached && r.unreachable.length === 1 && r.unreachable[0] === "t1",
			"failed 且不在达成集 → unreachable",
		);
	}
	{
		const r = pollMod.pollTargetReached(mkSteps("failed", "skipped"), "failed");
		assert(
			r.reached && r.unreachable.length === 0,
			"until=failed → failed ∈ 达成集",
		);
	}
	{
		const r = pollMod.pollTargetReached(mkSteps("pending", "ready"), "done");
		assert(
			!r.reached && r.notStarted === 2,
			"全部未派发 → 不 reached(不能空轮询即达成)",
		);
	}
	{
		const r = pollMod.pollTargetReached(mkSteps("conflict"), "done");
		assert(
			!r.reached && r.unreachable.length === 1,
			"conflict/aborted/needs-fix 同样不可达",
		);
	}

	// 子进程跑真实 CLI(退出码契约)
	const CLI_PATH = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
	const runCli = (
		args: string[],
		opts: { cwd?: string; env?: Record<string, string> } = {},
	): { code: number; stdout: string; stderr: string } => {
		try {
			const stdout = execFileSync(
				process.execPath,
				["--experimental-strip-types", CLI_PATH, ...args],
				{
					cwd: opts.cwd ?? tmpDir,
					env: { ...process.env, ...opts.env },
					encoding: "utf-8",
					timeout: 90_000,
				},
			);
			return { code: 0, stdout, stderr: "" };
		} catch (e) {
			const err = e as { status?: number; stdout?: string; stderr?: string };
			return {
				code: err.status ?? 1,
				stdout: String(err.stdout ?? ""),
				stderr: String(err.stderr ?? ""),
			};
		}
	};
	const pollRepo = path.join(tmpDir, "pollrepo");
	fs.mkdirSync(pollRepo, { recursive: true });
	const pollImp = orchMod.importPlan(
		db2,
		{
			name: "poll-wf",
			title: "轮询",
			goal: "轮询退出码",
			repoPath: pollRepo,
			steps: [
				{ id: "1", title: "a", agent: "worker", task: "a" },
				{
					id: "1.1",
					title: "b",
					agent: "worker",
					task: "b",
					deps: ["1"],
				},
				{
					id: "1.2",
					title: "c",
					agent: "worker",
					task: "c",
					deps: ["1"],
				},
			],
		},
		tmpDir,
		AGENTS,
	);
	assert(pollImp.ok, "poll-wf 导入");
	const setSt = (id: string, status: string): void => {
		dbMod.buildUpdate(
			db2,
			"workflow_steps",
			{ status, updated_at: Date.now() },
			{ id },
		);
	};
	// 全部终态(done+skipped)→ 0
	setSt("poll-wf-1", "done");
	setSt("poll-wf-1.1", "done");
	setSt("poll-wf-1.2", "skipped");
	let pr = runCli([
		"poll",
		"poll-wf",
		"--until",
		"done",
		"--timeout",
		"3",
		"--interval",
		"1",
	]);
	assert(
		pr.code === 0 && pr.stdout.includes("达成"),
		`poll 全终态 → 退出 0(${pr.code} ${pr.stdout.trim()})`,
	);
	// 失败 → 2
	setSt("poll-wf-1", "failed");
	setSt("poll-wf-1.1", "done");
	setSt("poll-wf-1.2", "done");
	pr = runCli([
		"poll",
		"poll-wf",
		"--until",
		"done",
		"--timeout",
		"3",
		"--interval",
		"1",
	]);
	assert(
		pr.code === 2 && pr.stderr.includes("wf retry"),
		`poll 出现 failed → 退出 2(${pr.code} stderr=${pr.stderr.trim().slice(0, 80)})`,
	);
	// 全部未派发 → 超时 1
	setSt("poll-wf-1", "pending");
	setSt("poll-wf-1.1", "pending");
	setSt("poll-wf-1.2", "pending");
	pr = runCli([
		"poll",
		"poll-wf",
		"--until",
		"done",
		"--timeout",
		"2",
		"--interval",
		"1",
	]);
	assert(
		pr.code === 1 && pr.stdout.includes("超时") && pr.stderr.includes("未派发 3"),
		`poll 超时 → 退出 1(${pr.code} ${pr.stdout.trim().slice(0, 60)})`,
	);
	// 用法错误 → 3
	pr = runCli(["poll", "poll-wf", "--until", "bogus", "--timeout", "2"]);
	assert(
		pr.code === 3 && pr.stderr.includes("--until"),
		"poll 非法 --until → 退出 3",
	);
	pr = runCli(["poll", "poll-wf", "--timeout", "0"]);
	assert(pr.code === 3, "poll timeout<=0 → 退出 3");
	pr = runCli(["poll", "no-such-wf", "--timeout", "2"]);
	assert(
		pr.code === 3 && pr.stderr.includes("workflow 不存在"),
		"poll 不存在 workflow → 退出 3",
	);

	console.log("== T22 session 目录选择 + 行解析 ==");
	const sessMod = await import("../src/session.ts");
	assert(
		sessMod.encodeSessionDir("/Users/geeyu/.pi/agent/extensions/workflow") ===
			"--Users-geeyu-.pi-agent-extensions-workflow--",
		"cwd 编码规则(/ → -,包 --)",
	);
	const sLine1 = '{"type":"session","timestamp":"2026-01-01T00:00:00Z"}';
	const sLine2 =
		'{"type":"message","timestamp":"2026-01-01T00:00:01Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"skip"},{"type":"text","text":"hello "},{"type":"text","text":"world"},{"type":"toolCall","name":"read"}]}}';
	const sLine3 =
		'{"type":"custom_message","customType":"workflow-notify","timestamp":"2026-01-01T00:00:02Z","content":"[wf] 有事件"}';
	const sLine4 =
		'{"type":"message","timestamp":"2026-01-01T00:00:03Z","message":{"role":"user","content":[{"type":"text","text":"继续"}]}}';
	assert(sessMod.parseSessionLine(sLine1) === null, "session 行跳过");
	const pm2 = sessMod.parseSessionLine(sLine2)!;
	assert(
		pm2.role === "assistant" && pm2.text === "hello world",
		`message 提取 text(跳 thinking/toolCall): ${pm2.text}`,
	);
	const pm3 = sessMod.parseSessionLine(sLine3)!;
	assert(
		pm3.role === "notify" && pm3.text.includes("[wf]"),
		"custom_message → notify",
	);
	const sessRepo = path.join(tmpDir, "sessrepo");
	fs.mkdirSync(sessRepo, { recursive: true });
	const sessRoot = path.join(tmpDir, "sessions");
	const sessDir = path.join(sessRoot, sessMod.encodeSessionDir(sessRepo));
	fs.mkdirSync(sessDir, { recursive: true });
	// 两个文件:mtime 最新的被选中(旧文件先写,再 touch 新文件)
	fs.writeFileSync(
		path.join(sessDir, "2026-01-01T00-00-00Z_old.jsonl"),
		[sLine1, sLine4].join("\n"),
	);
	const newFile = path.join(sessDir, "2026-01-01T01-00-00Z_new.jsonl");
	fs.writeFileSync(newFile, [sLine1, sLine2, sLine3, sLine4].join("\n"));
	const sessImp = orchMod.importPlan(
		db2,
		{
			name: "sess-wf",
			title: "会话",
			goal: "读会话",
			repoPath: sessRepo,
			steps: [{ id: "1", title: "a", agent: "worker", task: "a" }],
		},
		tmpDir,
		AGENTS,
	);
	assert(sessImp.ok, "sess-wf 导入");
	assert(
		sessMod.findLatestSessionFile(sessRoot, sessRepo) === newFile,
		"取 mtime 最新 jsonl",
	);
	let sr = runCli(["session", "sess-wf", "-n", "2"], {
		env: { WF_SESSIONS_DIR: sessRoot },
	});
	assert(
		sr.code === 0 &&
			sr.stdout.includes("[notify] [wf] 有事件") &&
			sr.stdout.includes("user: 继续"),
		`session -n 取最近 N 条(含 notify 前缀): ${sr.stdout.split("\n")[0] ?? ""}`,
	);
	sr = runCli(["session", "sess-wf", "-n", "10"], {
		env: { WF_SESSIONS_DIR: sessRoot },
	});
	assert(
		sr.code === 0 && sr.stdout.includes("assistant: hello world"),
		`session 文本输出(跳 thinking/toolCall): ${sr.stdout.split("\n")[0] ?? ""}`,
	);
	sr = runCli(["session", "sess-wf", "--json"], {
		env: { WF_SESSIONS_DIR: sessRoot },
	});
	const sessJson = JSON.parse(sr.stdout) as Array<{
		ts: string;
		role: string;
		text: string;
	}>;
	assert(
		sr.code === 0 &&
			Array.isArray(sessJson) &&
			sessJson.length === 3 &&
			sessJson[0].role === "assistant" &&
			sessJson[2].role === "user",
		`session --json 结构(${sessJson.length} 条)`,
	);
	sr = runCli(["session", "sess-wf"], {
		env: { WF_SESSIONS_DIR: path.join(tmpDir, "no-sessions") },
	});
	assert(
		sr.code === 1 && sr.stderr.includes("无会话文件"),
		"无会话目录 → 退出 1",
	);
	sr = runCli(["session", "no-such-wf"], {
		env: { WF_SESSIONS_DIR: sessRoot },
	});
	assert(
		sr.code === 3 && sr.stderr.includes("workflow 不存在"),
		"session 不存在 workflow → 退出 3",
	);

	console.log("== T23 inject 注入(参数解析 + 三种 target + 退出码) ==");
	const injRepo = path.join(tmpDir, "injrepo");
	fs.mkdirSync(injRepo, { recursive: true });
	const injImp = orchMod.importPlan(
		db2,
		{
			name: "inj-wf",
			title: "注入",
			goal: "注入",
			repoPath: injRepo,
			steps: [
				{ id: "1", title: "a", agent: "worker", task: "a" },
				{ id: "2", title: "b", agent: "worker", task: "b" },
			],
		},
		tmpDir,
		AGENTS,
	);
	assert(injImp.ok, "inj-wf 导入");
	dbMod.buildUpdate(
		db2,
		"workflow_steps",
		{ status: "running", tab_id: "abcdef0123456789", updated_at: Date.now() },
		{ id: "inj-wf-1" },
	);
	const injBin = path.join(tmpDir, "inject-bin");
	fs.mkdirSync(injBin, { recursive: true });
	const injLog = path.join(tmpDir, "inject.log");
	fs.writeFileSync(
		path.join(injBin, "ghostctl"),
		`#!/bin/bash\necho "$@" >> "${injLog}"\n`,
		{ mode: 0o755 },
	);
	fs.writeFileSync(injLog, "");
	const injEnv = { PATH: `${injBin}:${process.env.PATH ?? ""}` };
	let ir = runCli(["inject", "inj-wf-1", "hello world"], {
		cwd: injBin,
		env: injEnv,
	});
	let injCalls = fs.readFileSync(injLog, "utf-8").trim().split("\n");
	assert(
		ir.code === 0 &&
			injCalls.includes("input hello world --to abcdef0123456789") &&
			injCalls.includes("key enter --to abcdef0123456789"),
		`完整 step id → input+enter 序列(${injCalls.join(" | ")})`,
	);
	// 点号 id(身份 env 解析)
	fs.writeFileSync(injLog, "");
	ir = runCli(["inject", "1", "hi"], {
		cwd: injBin,
		env: { ...injEnv, PI_WF_WORKFLOW: "inj-wf", PI_WF_STEP: "1" },
	});
	injCalls = fs.readFileSync(injLog, "utf-8").trim().split("\n");
	assert(
		ir.code === 0 && injCalls.includes("input hi --to abcdef0123456789"),
		"点号 id 按身份 env 解析",
	);
	// terminal 前缀(未命中任何步骤 → 直接注入)
	fs.writeFileSync(injLog, "");
	ir = runCli(["inject", "1CA675C0", "raw"], { cwd: injBin, env: injEnv });
	injCalls = fs.readFileSync(injLog, "utf-8").trim().split("\n");
	assert(
		ir.code === 0 && injCalls.includes("input raw --to 1CA675C0"),
		"terminal 前缀直接注入(不查 DB)",
	);
	// 步骤无 tab → 1
	ir = runCli(["inject", "inj-wf-2", "x"], { cwd: injBin, env: injEnv });
	assert(
		ir.code === 1 && ir.stderr.includes("wf open-tab inj-wf-2"),
		`步骤无 tab → 退出 1 并提示(${ir.stderr.trim().slice(0, 60)})`,
	);
	// 缺参数 → 3
	ir = runCli(["inject"], { cwd: injBin, env: injEnv });
	assert(ir.code === 3, "inject 无参数 → 退出 3");
	// ghostctl 失败 → 1
	const injFailBin = path.join(tmpDir, "inject-fail-bin");
	fs.mkdirSync(injFailBin, { recursive: true });
	fs.writeFileSync(
		path.join(injFailBin, "ghostctl"),
		`#!/bin/bash\necho "$@" >> "${injLog}"\nexit 1\n`,
		{ mode: 0o755 },
	);
	ir = runCli(["inject", "inj-wf-1", "boom"], {
		cwd: injFailBin,
		env: { PATH: `${injFailBin}:${process.env.PATH ?? ""}` },
	});
	assert(
		ir.code === 1 && ir.stderr.includes("注入失败"),
		"ghostctl 失败 → 退出 1",
	);

	console.log("== T24 openStepTab 共享开 tab + open-tab/fix-tab CLI ==");
	const openRepo = path.join(tmpDir, "openrepo");
	fs.mkdirSync(openRepo, { recursive: true });
	const openWt = path.join(openRepo, ".worktrees", "gittree-wf-open-wf-1");
	fs.mkdirSync(openWt, { recursive: true });
	const openImp = orchMod.importPlan(
		db2,
		{
			name: "open-wf",
			title: "补开",
			goal: "补开 tab",
			repoPath: openRepo,
			steps: [
				{ id: "1", title: "a", agent: "worker", task: "a" },
				{ id: "2", title: "b", agent: "worker", task: "b" },
			],
		},
		tmpDir,
		AGENTS,
	);
	assert(openImp.ok, "open-wf 导入");
	dbMod.setWorkflowMeta(db2, "open-wf", "ghostty_window_id", "win-9");
	dbMod.buildUpdate(
		db2,
		"workflow_steps",
		{
			status: "failed",
			worktree: "wf-open-wf-1",
			error: "new-tab 失败(模拟)",
			updated_at: Date.now(),
		},
		{ id: "open-wf-1" },
	);
	const openGhostctl = path.join(tmpDir, "open-ghostctl.sh");
	const openLog = path.join(tmpDir, "open-ghostctl.log");
	fs.writeFileSync(
		openGhostctl,
		`#!/bin/bash\necho "$@" >> "${openLog}"\nif [ "$1" = "layout" ]; then\n  echo '{"windows":[{"id":"win-9","front":true,"tabs":[{"terminals":[{"id":"feedface12345678","cwd":"${openWt}"}]}]}]}'\nelse\n  echo "已创建标签页 (id=tab-open)"\nfi\n`,
		{ mode: 0o755 },
	);
	fs.writeFileSync(openLog, "");
	// openStepTab 单测(共享序列:new-tab(pointer 位置参数)→ 反查 → 落库 + manual 事件)
	const openRes = await dispatchMod.openStepTab(
		db2,
		dbMod.getWorkflow(db2, "open-wf")!,
		dbMod.getStep(db2, "open-wf-1")!,
		{ ghostctlBin: openGhostctl, manual: true },
	);
	assert(
		openRes.ok && openRes.tabId === "feedface12345678",
		`openStepTab 成功(${openRes.error ?? ""})`,
	);
	const openStepAfter = dbMod.getStep(db2, "open-wf-1")!;
	assert(
		openStepAfter.status === "running" &&
			openStepAfter.tab_id === "feedface12345678",
		"openStepTab 写回 running + tab_id",
	);
	const openEvt = dbMod
		.getEvents(db2, { stepId: "open-wf-1", limit: 10 })
		.find((e) => e.type === "step_tab_opened");
	assert(
		openEvt !== undefined &&
			(JSON.parse(openEvt.payload ?? "{}") as { manual?: boolean }).manual ===
				true,
		"step_tab_opened 事件带 manual 标记",
	);
	const openLogRaw = fs.readFileSync(openLog, "utf-8");
	assert(
		openLogRaw.includes("new-tab") &&
			openLogRaw.includes("--window-id win-9") &&
			openLogRaw.includes("--at-end") &&
			openLogRaw.includes("--no-focus"),
		"openStepTab 复用绑定窗口 + 末尾顺序 + 不抢焦点",
	);
	// pointer 改为 pi 位置参数交付:--command 内嵌单引号指引;不再 --input 注入、不再补回车
	assert(
		openLogRaw.includes("'[wf] task ready") && !openLogRaw.includes("--input"),
		`pointer 作为位置参数传入(--input 已移除): ${openLogRaw.slice(0, 160)}`,
	);
	assert(
		!openLogRaw.includes("key enter"),
		"openStepTab 不再盲等 + 补回车(pi 启动即自动发送)",
	);
	// shellQuote:单引号包裹 + 嵌入 ' 按 POSIX '\'' 转义(防御性)
	assert(
		dispatchMod.shellQuote("plain") === "'plain'" &&
			dispatchMod.shellQuote("a'b") === "'a'\\''b'" &&
			dispatchMod.shellQuote("x\ny") === "'x\ny'",
		"shellQuote 单引号包裹 + 嵌入引号转义",
	);
	// open-tab CLI:无参数 → 3;步骤不存在 → 1;tab 存活 → 1;无 worktree → 1
	const openBin = path.join(tmpDir, "open-bin");
	fs.mkdirSync(openBin, { recursive: true });
	fs.copyFileSync(openGhostctl, path.join(openBin, "ghostctl"));
	const openEnv = { PATH: `${openBin}:${process.env.PATH ?? ""}` };
	let or = runCli(["open-tab"], { cwd: openBin, env: openEnv });
	assert(or.code === 3, "open-tab 无参数 → 退出 3");
	or = runCli(["open-tab", "open-wf-9"], { cwd: openBin, env: openEnv });
	assert(
		or.code === 1 && or.stderr.includes("步骤不存在"),
		"open-tab 未知步骤 → 退出 1",
	);
	or = runCli(["open-tab", "open-wf-1"], { cwd: openBin, env: openEnv });
	assert(
		or.code === 1 && or.stderr.includes("无需重开"),
		`open-tab 已绑定且存活 → 退出 1(${or.stderr.trim().slice(0, 60)})`,
	);
	or = runCli(["open-tab", "open-wf-2"], { cwd: openBin, env: openEnv });
	assert(
		or.code === 1 && or.stderr.includes("无 worktree"),
		`open-tab 无 worktree → 退出 1(${or.stderr.trim().slice(0, 60)})`,
	);
	// fix-tab:显式前缀 / auto / 非法前缀 / 缺参数
	let fr = runCli(["fix-tab", "open-wf-1", "feed"], {
		cwd: openBin,
		env: openEnv,
	});
	let fixed = dbMod.getStep(db2, "open-wf-1")!;
	assert(
		fr.code === 0 &&
			fr.stdout.includes("running/feedface12345678") &&
			fixed.status === "running" &&
			fixed.tab_id === "feedface12345678",
		`fix-tab 显式前缀对齐(${fr.stdout.trim()})`,
	);
	let fixEvt = dbMod
		.getEvents(db2, { stepId: "open-wf-1", limit: 10 })
		.find((e) => e.type === "step_tab_fixed");
	assert(
		fixEvt !== undefined &&
			(JSON.parse(fixEvt.payload ?? "{}") as { mode?: string }).mode ===
				"explicit",
		"step_tab_fixed 事件(mode=explicit)",
	);
	// auto:按 worktree cwd 反查
	dbMod.buildUpdate(
		db2,
		"workflow_steps",
		{ tab_id: null, status: "failed", updated_at: Date.now() },
		{ id: "open-wf-1" },
	);
	fr = runCli(["fix-tab", "open-wf-1", "auto"], { cwd: openBin, env: openEnv });
	fixed = dbMod.getStep(db2, "open-wf-1")!;
	assert(
		fr.code === 0 &&
			fr.stdout.includes("mode=auto") &&
			fixed.tab_id === "feedface12345678",
		`fix-tab auto 反查(${fr.stdout.trim()})`,
	);
	fixEvt = dbMod
		.getEvents(db2, { stepId: "open-wf-1", limit: 10 })
		.filter((e) => e.type === "step_tab_fixed")[0];
	assert(
		fixEvt !== undefined &&
			(JSON.parse(fixEvt.payload ?? "{}") as { mode?: string }).mode === "auto",
		"step_tab_fixed 事件(mode=auto)",
	);
	fr = runCli(["fix-tab", "open-wf-1", "zzzz"], { cwd: openBin, env: openEnv });
	assert(
		fr.code === 1 && fr.stderr.includes("无 terminal 前缀"),
		"fix-tab 非法前缀 → 退出 1",
	);
	fr = runCli(["fix-tab", "open-wf-1"], { cwd: openBin, env: openEnv });
	assert(fr.code === 3, "fix-tab 缺 terminal → 退出 3");
	fr = runCli(["fix-tab", "no-such", "auto"], { cwd: openBin, env: openEnv });
	assert(
		fr.code === 1 && fr.stderr.includes("步骤不存在"),
		"fix-tab 未知步骤 → 退出 1",
	);

	console.log("== T25 命令注册表 + parseArgs + 退出码契约 ==");
	const cmdMod = await import("../src/command.ts");
	// 注册表:双入口共享、入口过滤、排序、重复注册保护
	const statusDef = cmdMod.getCommand("status");
	assert(
		statusDef !== undefined && statusDef.widget === "workflow-status",
		"getCommand(status) 命中且带 widget",
	);
	assert(
		cmdMod.getCommand("poll")?.entry === "cli" &&
			cmdMod.getCommand("context")?.entry === undefined &&
			cmdMod.getCommand("skip") !== undefined,
		"入口标记:poll=cli / context+skip=both",
	);
	assert(
		cmdMod.getCommand("merge")?.entry === undefined,
		"缺省 entry = both(双入口共享)",
	);
	const cliNames = cmdMod.listCommands("cli").map((d) => d.name);
	assert(
		cliNames.length === 34 &&
			cliNames.includes("plan-init") &&
			cliNames.includes("context") &&
			cliNames.includes("skip") &&
			cliNames.includes("resolve-conflict") &&
			cliNames.includes("board") &&
			cliNames.includes("fix-tab") &&
			cliNames.includes("create") &&
			cliNames.includes("master-merge") &&
			cliNames.includes("master-fail"),
		`listCommands(cli) = 34 条(${cliNames.length})含 context/skip/resolve-conflict/create/master-merge`,
	);
	const piNames = cmdMod.listCommands("pi").map((d) => d.name);
	assert(
		piNames.length === 24 &&
			piNames.includes("steer") &&
			piNames.includes("resume") &&
			piNames.includes("resolve-conflict") &&
			piNames.includes("create") &&
			piNames.includes("master-merge") &&
			!piNames.includes("poll"),
		`listCommands(pi) = 24 条(${piNames.length})含 both 共享命令`,
	);
	assert(
		cmdMod.listCommands().length === 35,
		`注册表共 35 条(${cmdMod.listCommands().length})`,
	);
	assert(
		[...cliNames].sort().join(",") === cliNames.join(","),
		"listCommands 按 name 排序",
	);
	console.log("== T25b CLI context/skip/resolve-conflict 可用性 ==");
	// CLI 子进程:context 可读任务正文(此前被 entry=pi 拒绝;scratch-wf-1 已 dispatch,task_md 为渲染版)
	const ctxOut = runCli(["context", "scratch-wf-1"]);
	assert(
		ctxOut.code === 0 && ctxOut.stdout.includes("## 需求目标"),
		`CLI context 可读任务(${ctxOut.code} ${ctxOut.stdout.slice(0, 40)})`,
	);
	// 直接调 run(捕获 warn):skip 终态拒绝 / 非终态 → skipped + 事件;resolve-conflict 非冲突拒绝
	const warns: string[] = [];
	const fakeCliEnv = {
		kind: "cli",
		cwd: tmpDir,
		db: db2,
		show: () => {},
		info: () => {},
		warn: (l: string) => warns.push(l),
		fail: () => {},
		notifyPi: () => {},
		setExitCode: () => {},
	};
	cmdMod.getCommand("skip")!.run(["merge-wf-1"], fakeCliEnv as never);
	assert(
		warns.some((w) => w.includes("终态")),
		`skip 终态步骤拒绝(warns=${warns.join(" | ") || "空"}, status=${dbMod.getStep(db2, "merge-wf-1")?.status})`,
	);
	warns.length = 0;
	cmdMod
		.getCommand("resolve-conflict")!
		.run(["merge-wf-1"], fakeCliEnv as never);
	assert(
		warns.some((w) => w.includes("不是 conflict")),
		`resolve-conflict 非冲突拒绝(${warns.join(" | ")})`,
	);
	// skip 非终态步骤 → skipped + 事件
	const skipImp = orchMod.importPlan(
		db2,
		{
			name: "skip-wf",
			title: "skip",
			goal: "g",
			repoPath: scratchRepo,
			steps: [{ id: "1", title: "a", agent: "worker", task: "a" }],
		},
		tmpDir,
		AGENTS,
	);
	assert(skipImp.ok, "skip-wf 导入");
	cmdMod.getCommand("skip")!.run(["skip-wf-1", "不做了"], fakeCliEnv as never);
	assert(
		dbMod.getStep(db2, "skip-wf-1")?.status === "skipped",
		"skip 非终态 → skipped",
	);
	assert(
		dbMod
			.getEvents(db2, { workflowId: "skip-wf", limit: 10 })
			.some((e) => e.type === "step_skipped"),
		"step_skipped 事件",
	);
	let dupErr = "";
	try {
		cmdMod.register({
			name: "status",
			description: "x",
			usage: "x",
			run: () => {},
		});
	} catch (e) {
		dupErr = (e as Error).message;
	}
	assert(dupErr.includes("重复注册"), "重复注册抛错");
	// parseArgs:boolean / value / greedy / 缺值 / 未声明 flag 丢弃
	const pa1 = cmdMod.parseArgs(
		["wf-id", "--json", "--until", "done"],
		[{ name: "--json" }, { name: "--until", value: true }],
	);
	assert(
		pa1.positionals.join(",") === "wf-id" &&
			pa1.bool("--json") &&
			!pa1.bool("--all") &&
			pa1.value("--until") === "done" &&
			pa1.value("--all", "x") === "x",
		"parseArgs:boolean+value 消费,缺省返回默认",
	);
	const pa2 = cmdMod.parseArgs(["a", "--bogus", "c"], []);
	assert(
		pa2.positionals.join(",") === "a,c" && !pa2.bool("--bogus"),
		"未声明 flag 丢弃不进 positionals(与现状 positionalArgs 一致)",
	);
	const pa3 = cmdMod.parseArgs(
		["wf-id", "--note", "hello", "world"],
		[{ name: "--note", value: "greedy" }],
	);
	assert(
		pa3.positionals.join(",") === "wf-id" &&
			pa3.value("--note") === "hello world",
		"greedy flag 消费剩余全部",
	);
	const pa4 = cmdMod.parseArgs(["--until"], [{ name: "--until", value: true }]);
	assert(
		pa4.value("--until") === undefined &&
			pa4.value("--until", "done") === undefined,
		"带值 flag 缺值 → undefined(与现状 flagValue 一致)",
	);
	const pa5 = cmdMod.parseArgs(
		["a", "-n", "3", "b"],
		[{ name: "-n", value: true }],
	);
	assert(
		pa5.value("-n") === "3" && pa5.positionals.join(",") === "a,b",
		"短别名 -n 消费值",
	);
	// resolveIdentity 收敛:command.ts 与 index.ts 再导出同源
	const cmdIdent = cmdMod.resolveIdentity("/x/wf-demo-1.1");
	assert(
		cmdIdent?.workflowId === "demo" && cmdIdent?.dotted === "1.1",
		"resolveIdentity worktree 路径解析(command.ts)",
	);
	assert(
		idxMod.resolveIdentity("/x/wf-demo-1.1")?.stepId === "demo-1.1",
		"index.ts 再导出 resolveIdentity 同源",
	);
	// 退出码契约:用法错误统一 3(原部分命令为 1)、未知命令保持 1
	pr = runCli(["step"], { cwd: tmpDir });
	assert(
		pr.code === 3 && pr.stderr.includes("用法: wf step <id>"),
		`step 缺参数 → 退出 3(${pr.code})`,
	);
	pr = runCli(["import"], { cwd: tmpDir });
	assert(
		pr.code === 3 && pr.stderr.includes("用法: wf import <plan.json>"),
		`import 缺文件 → 退出 3(${pr.code})`,
	);
	pr = runCli(["verify", "demo-wf-1"], { cwd: tmpDir });
	assert(
		pr.code === 3 && pr.stderr.includes("用法: wf verify <id> approve|reject"),
		`verify 缺 action → 退出 3(${pr.code})`,
	);
	pr = runCli(["bogus-command"], { cwd: tmpDir });
	assert(
		pr.code === 1 && pr.stderr.includes("未知命令"),
		`未知命令 → 退出 1(${pr.code})`,
	);
	pr = runCli(["steer", "x"], { cwd: tmpDir });
	assert(
		pr.code === 1 && pr.stderr.includes("未知命令"),
		`pi 独有命令在 CLI 视为未知(${pr.code} ${pr.stderr.trim()})`,
	);
	// help 与注册表命令齐全
	pr = runCli(["help"], { cwd: tmpDir });
	const helpMissing = cmdMod
		.listCommands("cli")
		.map((d) => d.name)
		.filter((n) => !pr.stdout.includes(n));
	assert(
		pr.code === 0 && helpMissing.length === 0,
		`wf help 含全部 ${cmdMod.listCommands("cli").length} 条 CLI 命令${helpMissing.length > 0 ? `(缺:${helpMissing.join(",")})` : ""}`,
	);
	// 注册表派发冒烟:新 workflow 走 status/tree/step/fail/done/verify
	const regRepo = path.join(tmpDir, "regrepo");
	fs.mkdirSync(regRepo, { recursive: true });
	const regImp = orchMod.importPlan(
		db2,
		{
			name: "reg-wf",
			title: "注册表",
			goal: "冒烟",
			repoPath: regRepo,
			steps: [{ id: "1", title: "a", agent: "worker", task: "a" }],
		},
		tmpDir,
		AGENTS,
	);
	assert(regImp.ok, "reg-wf 导入");
	pr = runCli(["status", "reg-wf"], { cwd: tmpDir });
	assert(
		pr.code === 0 && pr.stdout.includes("[reg-wf]"),
		`wf status(注册表派发): ${pr.stdout.split("\n")[0] ?? ""}`,
	);
	pr = runCli(["status", "--json", "reg-wf"], { cwd: tmpDir });
	const regJson = JSON.parse(pr.stdout) as Array<{ id: string }>;
	assert(
		pr.code === 0 && Array.isArray(regJson) && regJson[0].id === "reg-wf",
		"wf status --json 结构(注册表派发)",
	);
	pr = runCli(["tree", "reg-wf"], { cwd: tmpDir });
	assert(
		pr.code === 0 && pr.stdout.includes("1 a [worker]"),
		`wf tree(注册表派发): ${pr.stdout.trim()}`,
	);
	pr = runCli(["step", "reg-wf-1"], { cwd: tmpDir });
	assert(
		pr.code === 0 && pr.stdout.includes("[reg-wf-1]"),
		"wf step(注册表派发)",
	);
	pr = runCli(["fail", "reg-wf-1", "冒烟失败"], { cwd: tmpDir });
	assert(
		pr.code === 0 && pr.stdout.includes("✓ reg-wf-1 → failed"),
		`wf fail(注册表派发): ${pr.stdout.trim()}`,
	);
	pr = runCli(["done", "reg-wf-1", '{"summary":"s","tests":"none"}'], {
		cwd: tmpDir,
	});
	assert(
		pr.code === 0 && pr.stdout.includes("✓ reg-wf-1 → reported"),
		`wf done(注册表派发): ${pr.stdout.trim()}`,
	);
	pr = runCli(["verify", "reg-wf-1", "approve"], { cwd: tmpDir });
	assert(
		pr.code === 0 && pr.stdout.includes("✓ reg-wf-1 → done"),
		`wf verify approve(注册表派发): ${pr.stdout.trim()}`,
	);
	pr = runCli(["verify", "reg-wf-1", "reject", "原因"], { cwd: tmpDir });
	assert(
		pr.code === 1 && pr.stderr.includes("✗"),
		`verify 已 done 步骤 reject → 退出 1(${pr.code})`,
	);
	// UsageError 具体提示:detail + 用法行
	pr = runCli(["poll", "no-such-wf", "--timeout", "2"], { cwd: tmpDir });
	assert(
		pr.code === 3 && pr.stderr.includes("workflow 不存在"),
		"poll 不存在 workflow → 退出 3(UsageError detail)",
	);

	console.log("== T26 状态机迁移校验接线(canTransition/strict/关键入口)= ");
	const stateMod = await import("../src/core/state.ts");
	assert(
		stateMod.canTransition("running", "reported"),
		"running → reported 合法",
	);
	assert(stateMod.canTransition("running", "running"), "同态幂等合法");
	assert(!stateMod.canTransition("done", "running"), "done → running 非法");
	assert(!stateMod.canTransition("skipped", "reported"), "skipped 终态不可回退");
	assert(
		stateMod.canTransition("done", "conflict"),
		"done → conflict(merge 冲突)合法",
	);
	assert(
		stateMod.canTransition("conflict", "skipped"),
		"conflict → skipped(人工终态)合法",
	);
	assert(
		stateMod.legalTargets("done").join(",") === "done,conflict",
		"legalTargets(done) = [done, conflict]",
	);
	// updateStepStatus strict:非法迁移抛 StepTransitionError 且带合法目标列表
	let transErr = "";
	try {
		dbMod.updateStepStatus(
			db2,
			"demo-wf-2",
			dbMod.STEP_STATUS.reported,
			undefined,
			{
				strict: true,
			},
		);
	} catch (e) {
		transErr = (e as Error).message;
	}
	assert(
		transErr.includes("非法状态迁移") &&
			transErr.includes("允许: done, conflict"),
		`strict 非法迁移明确报错+合法目标(${transErr})`,
	);
	// 同态幂等 strict 不抛
	let idemOk = true;
	try {
		dbMod.updateStepStatus(db2, "demo-wf-2", dbMod.STEP_STATUS.done, undefined, {
			strict: true,
		});
	} catch {
		idemOk = false;
	}
	assert(idemOk, "strict 同态幂等不抛");
	// 关键入口:reportDone/reportFail/verifyStep 非法迁移 → 明确错误 + 合法目标
	const re1 = orchMod.reportDone(db2, "demo-wf-2", { summary: "重报" });
	assert(
		!re1.ok && re1.error!.includes("状态迁移非法") && re1.error!.includes("允许"),
		`reportDone 终态拒绝(${re1.error})`,
	);
	const rf1 = orchMod.reportFail(db2, "demo-wf-2", "x");
	assert(
		!rf1.ok && rf1.error!.includes("允许"),
		`reportFail 终态拒绝(${rf1.error})`,
	);
	const vp = orchMod.verifyStep(db2, "skip-wf-1", "approve");
	assert(
		!vp.ok && vp.error!.includes("允许") && vp.error!.includes("reported"),
		`verifyStep 非核对态拒绝(${vp.error})`,
	);
	// conflict 步骤不可回报;但可 skip(人工终态,strict 路径)
	dbMod.updateStepStatus(db2, "demo-wf-1", dbMod.STEP_STATUS.conflict);
	const rc = orchMod.reportDone(db2, "demo-wf-1", { summary: "冲突中回报" });
	assert(!rc.ok && rc.error!.includes("允许"), "reportDone conflict 拒绝");
	const t26Warns: string[] = [];
	const t26Env = {
		kind: "cli",
		cwd: tmpDir,
		db: db2,
		show: () => {},
		info: () => {},
		warn: (l: string) => t26Warns.push(l),
		fail: () => {},
		notifyPi: () => {},
		setExitCode: () => {},
	};
	cmdMod.getCommand("skip")!.run(["demo-wf-1", "人工放弃"], t26Env as never);
	assert(
		dbMod.getStep(db2, "demo-wf-1")?.status === "skipped" &&
			t26Warns.length === 0,
		"conflict → skipped(skip 命令,strict 路径)",
	);
	// fix-tab 终态拒绝(状态机校验先于 ghostctl 查询)
	const ft = runCli(["fix-tab", "demo-wf-2", "auto"], { cwd: tmpDir });
	assert(
		ft.code === 1 && ft.stderr.includes("状态迁移非法"),
		`fix-tab done 拒绝(${ft.stderr.trim().slice(0, 60)})`,
	);

	console.log("== T27 会话隔离强化:子任务会话不渲染编排者面板 = ");
	const indexMod2 = await import("../src/index.ts");
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const extCalls: string[] = [];
	const mockPi = {
		on: (ev: string, h: (event: unknown, ctx: unknown) => unknown) =>
			handlers.set(ev, h),
		registerCommand: () => extCalls.push("registerCommand"),
		registerShortcut: () => extCalls.push("registerShortcut"),
		registerMessageRenderer: () => extCalls.push("registerMessageRenderer"),
		sendMessage: async () => {},
	};
	const mockUi = {
		setTitle: (t: string) => extCalls.push(`setTitle:${t}`),
		setWidget: () => extCalls.push("setWidget"),
		setStatus: () => extCalls.push("setStatus"),
		notify: () => extCalls.push("notify"),
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		setEditorText: () => {},
	};
	indexMod2.default(mockPi as never);
	assert(
		handlers.has("session_start") &&
			handlers.has("agent_start") &&
			handlers.has("session_shutdown"),
		"扩展生命周期注册(session_start/agent_start/shutdown)",
	);
	assert(extCalls.includes("registerShortcut"), "折叠快捷键已注册");
	// 子任务会话:cwd 位于 .worktrees 内 → 只设标题,不渲染面板/状态条、不发通知
	extCalls.length = 0;
	await handlers.get("session_start")!("", {
		cwd: "/repo/.worktrees/gittree-wf-demo-wf-1.1",
		ui: mockUi,
	});
	assert(
		extCalls.includes("setTitle:wf demo-wf/1.1"),
		`子会话设标题(${extCalls.join(", ")})`,
	);
	assert(
		!extCalls.includes("setWidget") &&
			!extCalls.includes("setStatus") &&
			!extCalls.includes("notify"),
		`子会话不渲染编排者面板/状态条(${extCalls.join(", ")})`,
	);

	console.log("== T28 面板配置(config.ts:maxWidgetLines/collapseKey)= ");
	const configMod = await import("../src/config.ts");
	const savedXdg = process.env.XDG_CONFIG_HOME;
	const cfgDir = path.join(tmpDir, "cfg");
	fs.mkdirSync(path.join(cfgDir, "pi-workflow"), { recursive: true });
	const writeCfg = (obj: unknown): void =>
		fs.writeFileSync(
			path.join(cfgDir, "pi-workflow", "config.json"),
			JSON.stringify(obj),
		);
	process.env.XDG_CONFIG_HOME = cfgDir;
	writeCfg({ maxWidgetLines: 8, collapseKey: "alt+t" });
	assert(configMod.getMaxWidgetLines() === 8, "maxWidgetLines 8 生效");
	assert(configMod.resolveCollapseKey() === "alt+t", "collapseKey alt+t 生效");
	writeCfg({ maxWidgetLines: 2 });
	assert(
		configMod.getMaxWidgetLines() === configMod.DEFAULT_MAX_WIDGET_LINES,
		"maxWidgetLines <3 回退默认",
	);
	writeCfg({ maxWidgetLines: "many" });
	assert(
		configMod.getMaxWidgetLines() === configMod.DEFAULT_MAX_WIDGET_LINES,
		"maxWidgetLines 非数字回退默认",
	);
	writeCfg({ collapseKey: "off" });
	assert(
		configMod.resolveCollapseKey() === configMod.COLLAPSE_KEY_OFF,
		"collapseKey off 禁用",
	);
	writeCfg({ collapseKey: "ctr+]" });
	assert(
		configMod.resolveCollapseKey() === configMod.DEFAULT_COLLAPSE_KEY,
		"collapseKey 非法键位回退默认(ctr+] 会误捕所有裸 ])",
	);
	writeCfg({});
	assert(
		configMod.getMaxWidgetLines() === 10 &&
			configMod.resolveCollapseKey() === "ctrl+shift+t",
		"空配置默认值(maxWidgetLines=10, collapseKey=ctrl+shift+t)",
	);

	console.log("== T29 面板折叠 + 完成行收起 = ");
	const hw = dbMod.getWorkflow(db2, "demo-wf")!;
	// 折叠态:仅标题 + 展开提示行,无任务行
	writeCfg({ collapseKey: "alt+t" });
	const colLines = statusUiMod.buildPlanLines(db2, [hw], mockTheme, 120, {
		collapsed: true,
	});
	assert(
		colLines.length === 2 && colLines.join("\n").includes("alt+t 展开"),
		`折叠态=标题+提示行(${colLines.join(" | ")})`,
	);
	// collapseKey off → 静态「已折叠」(不拼键位)
	writeCfg({ collapseKey: "off" });
	const colOff = statusUiMod.buildPlanLines(db2, [hw], mockTheme, 120, {
		collapsed: true,
	});
	assert(colOff.join("\n").includes("已折叠"), "collapseKey off → 已折叠提示");
	if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
	else process.env.XDG_CONFIG_HOME = savedXdg;
	// toggle 切换(恢复原态)
	const wasCollapsed = statusUiMod.isPlanCollapsed();
	statusUiMod.togglePlanCollapsed();
	assert(
		statusUiMod.isPlanCollapsed() === !wasCollapsed,
		"togglePlanCollapsed 切换",
	);
	statusUiMod.togglePlanCollapsed();
	// 完成行收起:本 turn 显示 → 下 turn(agent_start)收起
	statusUiMod.resetCompletedDisplayState();
	// demo-wf 现状:1=skipped(T26 人工终态)、2=done、1.1=reported、1.2=needs-fix
	const h1 = statusUiMod.buildPlanLines(db2, [hw], mockTheme, 120).join("\n");
	assert(h1.includes("– 1") && h1.includes("✓ 2"), "本 turn 完成行显示");
	statusUiMod.hideCompletedFromPreviousTurn();
	const h2 = statusUiMod.buildPlanLines(db2, [hw], mockTheme, 120).join("\n");
	assert(!h2.includes("– 1") && !h2.includes("✓ 2"), "下 turn 完成行收起");
	assert(
		h2.includes("(2/4)") && h2.includes("+2 步未显示"),
		`计数保留在标题,收起行计入未显示(${h2.split("\n").slice(0, 3).join(" | ")})`,
	);
	statusUiMod.resetCompletedDisplayState();
	const h3 = statusUiMod.buildPlanLines(db2, [hw], mockTheme, 120).join("\n");
	assert(h3.includes("– 1"), "reset 后恢复显示");
	// 重派后不再是终态 → 自动恢复显示(清理失效跟踪)
	statusUiMod.hideCompletedFromPreviousTurn();
	dbMod.buildUpdate(
		db2,
		"workflow_steps",
		{ status: "running" },
		{ id: "demo-wf-1" },
	);
	const h4 = statusUiMod.buildPlanLines(db2, [hw], mockTheme, 120).join("\n");
	assert(h4.includes("🔄 1"), "重派后不再终态 → 恢复显示");
	dbMod.buildUpdate(
		db2,
		"workflow_steps",
		{ status: "done" },
		{ id: "demo-wf-1" },
	);
	statusUiMod.resetCompletedDisplayState();

	console.log("== T30 deps 校验文案(悬空/自锁/环路径)= ");
	const vSelf = validateMod.validatePlan(
		{
			...DEMO_PLAN,
			steps: [{ id: "1", title: "a", agent: "worker", deps: ["1"] }],
		},
		AGENTS,
	);
	assert(
		vSelf.errors.some((e) => e.includes("自锁")),
		`自锁文案(${vSelf.errors.join("; ")})`,
	);
	const vHang = validateMod.validatePlan(
		{
			...DEMO_PLAN,
			steps: [{ id: "1", title: "a", agent: "worker", deps: ["9"] }],
		},
		AGENTS,
	);
	assert(
		vHang.errors.some((e) => e.includes("悬空") && e.includes("依赖不存在")),
		`悬空文案(${vHang.errors.join("; ")})`,
	);
	const vCycle = validateMod.validatePlan(
		{
			...DEMO_PLAN,
			steps: [
				{ id: "1", title: "a", agent: "worker", deps: ["1.1"] },
				{ id: "1.1", title: "b", agent: "worker", deps: ["1"] },
			],
		},
		AGENTS,
	);
	assert(
		vCycle.errors.some(
			(e) => e.includes("循环依赖") && e.includes("1 → 1.1 → 1"),
		),
		`环路径文案(${vCycle.errors.join("; ")})`,
	);

	console.log("== T26 P0-1 终端净化:sanitize 纯函数 + 落库/渲染接线 ==");
	const sanMod = await import("../src/sanitize.ts");
	assert(
		sanMod.sanitizeTerminalText("a\x1b[31mb") === "ab",
		"CSI 整段剥离不残留 [31m",
	);
	assert(
		sanMod.sanitizeTerminalText("a\x1b]0;改标题\x07b") === "ab",
		"OSC 负载整段剥离",
	);
	assert(
		sanMod.sanitizeTerminalText("a\u202eb\u200f") === "ab",
		"双向控制符删除",
	);
	assert(
		sanMod.sanitizeTerminalText("a\nb\tc") === "a b c",
		"换行/制表符变空格(不能改布局)",
	);
	assert(
		sanMod.sanitizeTerminalText("\x1b[1;31m红\x1b[0m") === "红",
		"ANSI 着色序列剥净",
	);
	assert(
		sanMod.sanitizeTerminalText("普通文本 123") === "普通文本 123",
		"普通文本原样保留",
	);
	assert(
		sanMod.sanitizeTerminalLines(["a\x1b[m", "b"]).join("|") === "a|b",
		"数组逐行净化",
	);
	// 落库接线:title/task/expectations 导入即净化
	const sanRepo = path.join(tmpDir, "sanrepo");
	fs.mkdirSync(sanRepo, { recursive: true });
	const sanImp = orchMod.importPlan(
		db2,
		{
			name: "san-wf",
			title: "净化\x1b[31m工作流",
			goal: "净化目标",
			repoPath: sanRepo,
			steps: [
				{
					id: "1",
					title: "任务\x1b]0;x\x07一",
					agent: "worker",
					task: "正文\n\x1b[33m第二行",
					expectations: ["期望\x1b[35mA"],
				},
			],
		},
		tmpDir,
		AGENTS,
	);
	assert(sanImp.ok, "san-wf 导入");
	const sanStep = dbMod.getStep(db2, "san-wf-1")!;
	assert(
		sanStep.title === "任务一",
		`title 落库已净化(实际: ${JSON.stringify(sanStep.title)})`,
	);
	assert(
		sanStep.task_md === "正文 第二行",
		`task 落库已净化(换行变空格: ${JSON.stringify(sanStep.task_md)})`,
	);
	assert(
		sanStep.expectations === '["期望A"]',
		`expectations 落库已净化(${sanStep.expectations})`,
	);
	// 回报落库净化:summary / issues
	const sanDone = orchMod.reportDone(db2, "san-wf-1", {
		summary: "完成\x1b[32m了",
		issues: ["转义\x1b]0;x\x07问题"],
		filesChanged: ["a.ts"],
		tests: "passed",
	});
	assert(sanDone.ok, "san-wf-1 回报成功");
	const sanStep2 = dbMod.getStep(db2, "san-wf-1")!;
	assert(
		sanStep2.summary === "完成了",
		`summary 落库已净化(${sanStep2.summary})`,
	);
	assert(
		sanStep2.issues === '["转义问题"]',
		`issues 落库已净化(${sanStep2.issues})`,
	);
	// fail reason 落库净化
	const sanFail = orchMod.reportFail(db2, "san-wf-1", "失败了\x1b[41m");
	assert(
		sanFail.ok && dbMod.getStep(db2, "san-wf-1")!.error === "失败了",
		"fail reason 落库已净化",
	);
	// 面板渲染防护:历史脏数据(绕过净化直接写库)渲染前仍被净化
	dbMod.buildUpdate(
		db2,
		"workflow_steps",
		{ title: "脏\x1b[36m标题" },
		{ id: "san-wf-1" },
	);
	const statusMod = await import("../src/ui/status.ts");
	const fakeTheme = {
		fg: (_c: string, t: string) => t,
		strikethrough: (t: string) => t,
		bold: (t: string) => t,
	};
	const sanPlanLines = statusMod.buildPlanLines(
		db2,
		dbMod.listActiveWorkflows(db2, sanRepo),
		fakeTheme as never,
		80,
	);
	assert(
		sanPlanLines.some((l) => l.includes("脏标题")) &&
			!sanPlanLines.some((l) => l.includes("\x1b[36m")),
		`面板对历史脏标题渲染前净化(${sanPlanLines.find((l) => l.includes("脏")) ?? "无脏行"})`,
	);

	console.log(
		"== T26b P0-3 workflow-notify 结构化渲染(字形 + 进度 + details + renderer) ==",
	);
	const notifyMod = await import("../src/ui/notify.ts");
	const renderMod = await import("../src/ui/renderers.ts");
	const sent2: Array<{ content: string; details?: unknown }> = [];
	const fakeSender2 = {
		sendMessage: async (m: { content: string; details?: unknown }) => {
			sent2.push({ content: m.content, details: m.details });
		},
		ui: { notify: () => {} },
	};
	// san-wf-1 已 failed(fail 事件尚未通知)→ 检测出 1 条 failed 事件
	const sanItems = monitorMod
		.detectStateChanges(db2)
		.filter((i) => i.workflowId === "san-wf");
	assert(
		sanItems.length === 1 && sanItems[0]!.kind === "failed",
		"san-wf failed 事件待通知",
	);
	await notifyMod.sendWorkflowNotifications(db2, fakeSender2, sanItems);
	assert(sent2.length === 1, "发送一条聚合消息");
	const nContent = sent2[0]!.content;
	assert(
		nContent.includes("● san-wf") &&
			nContent.includes("0/1") &&
			nContent.includes("✗1"),
		`内容含进度摘要+字形(${nContent.split("\n")[0]})`,
	);
	assert(
		nContent.includes("- ✗ 步骤 san-wf-1 失败") &&
			nContent.includes("/wf retry san-wf-1"),
		"事件行字形前缀 + 可执行命令",
	);
	const details = sent2[0]!.details as WorkflowNotifyDetails;
	assert(
		details.items.length === 1 &&
			details.items[0]!.kind === "failed" &&
			details.items[0]!.glyph === "✗",
		"details.items 结构化(kind/glyph/text)",
	);
	assert(
		details.progress.length === 1 && details.progress[0]!.text.includes("✗1"),
		"details.progress 结构化",
	);
	// 渲染器:字形按 kind 着色 + /wf 命令 accent 高亮 + 宽度截断
	const cmdTheme = {
		fg: (c: string, t: string) => `<${c}>${t}</${c}>`,
		strikethrough: (t: string) => t,
		bold: (t: string) => t,
	};
	const msg = {
		role: "custom" as const,
		customType: "workflow-notify",
		content: nContent,
		display: true,
		details,
		timestamp: Date.now(),
	};
	const component = renderMod.renderWorkflowNotify(
		msg,
		{ expanded: false, outputPad: 1 },
		cmdTheme as never,
	)!;
	const rendered = component.render(200);
	assert(
		rendered[0]!.includes("<dim>[wf]") && rendered[0]!.includes("● san-wf"),
		`进度行 dim 渲染(${rendered[0]})`,
	);
	assert(
		rendered[1]!.includes("<error>✗</error>") &&
			rendered[1]!.includes("<accent>/wf step san-wf-1</accent>") &&
			rendered[1]!.includes("<accent>/wf retry san-wf-1</accent>"),
		`事件行字形着色 + 命令高亮(${rendered[1]})`,
	);
	const narrow = component.render(30);
	assert(
		narrow.every((l) => l.length <= 31) && narrow.some((l) => l.includes("…")),
		`超宽截断(窄宽 ${narrow.map((l) => l.length).join(",")})`,
	);
	// 降级:无 details 的旧消息按 content 行渲染(首行 dim,命令仍高亮)
	const legacy = renderMod.renderWorkflowNotify(
		{ ...msg, details: undefined },
		{ expanded: false, outputPad: 1 },
		cmdTheme as never,
	)!;
	const legacyLines = legacy.render(120);
	assert(
		legacyLines[0]!.includes("<dim>") &&
			legacyLines.some((l) => l.includes("<accent>/wf retry san-wf-1</accent>")),
		"无 details 降级渲染(首行 dim + 命令高亮)",
	);

	console.log("== T26c P0-5 空态引导:plan/import/plan-init 模板提示 ==");
	pr = runCli(["import"], { cwd: tmpDir });
	assert(
		pr.code === 3 &&
			pr.stderr.includes("用法: wf import <plan.json>") &&
			pr.stderr.includes('"name": "demo-wf"'),
		`import 缺文件 → 退出 3 + plan.json 模板(${pr.stderr.slice(0, 60).replace(/\n/g, " ")})`,
	);
	pr = runCli(["plan"], { cwd: tmpDir });
	assert(
		pr.code === 3 &&
			pr.stderr.includes("用法: wf plan") &&
			pr.stderr.includes('"steps"'),
		`plan 缺目标 → 退出 3 + 模板(${pr.stderr.slice(0, 60).replace(/\n/g, " ")})`,
	);
	pr = runCli(["plan-init"], { cwd: tmpDir });
	assert(
		pr.code === 3 &&
			pr.stderr.includes("用法: wf plan-init") &&
			pr.stderr.includes('"name": "demo-wf"'),
		`plan-init 缺参 → 退出 3 + 模板(${pr.stderr.slice(0, 60).replace(/\n/g, " ")})`,
	);
	// pi 模式:plan/import 空态 → warn 含用法 + 模板
	const guideWarns: string[] = [];
	const guideEnv = {
		kind: "pi",
		cwd: tmpDir,
		db: db2,
		show: () => {},
		info: () => {},
		warn: (l: string) => guideWarns.push(l),
		fail: () => {},
		notifyPi: () => {},
		setExitCode: () => {},
	};
	void cmdMod.getCommand("plan")!.run([], guideEnv as never);
	assert(
		guideWarns.some(
			(w) => w.includes("用法: /wf plan") && w.includes('"name": "demo-wf"'),
		),
		`pi plan 空态 → warn 含用法+模板(${guideWarns.length} 条 warn)`,
	);
	guideWarns.length = 0;
	cmdMod.getCommand("import")!.run([], guideEnv as never);
	assert(
		guideWarns.some(
			(w) => w.includes("用法: /wf import") && w.includes("plan.json 模板"),
		),
		`pi import 空态 → warn 含用法+模板(${guideWarns.length} 条 warn)`,
	);
	// 校验错误可读性:非法 plan 逐条列出
	fs.writeFileSync(
		path.join(tmpDir, "bad-plan.json"),
		JSON.stringify({
			name: "bad-wf",
			title: "t",
			goal: "g",
			steps: [{ id: "x", title: "t", agent: "worker" }],
		}),
	);
	pr = runCli(["import", "bad-plan.json"], { cwd: tmpDir });
	assert(
		pr.code === 1 && pr.stderr.includes("导入失败") && pr.stderr.includes("点号"),
		`非法 plan 校验错误逐条可读(${pr.stderr.slice(0, 80).replace(/\n/g, " ")})`,
	);

	console.log("== T26d P0-4 状态机迁移校验接线 ==");
	// 合法链:running → done / running → needs-fix / done → conflict(merge 冲突重开)
	dbMod.updateStepStatus(db2, "san-wf-1", dbMod.STEP_STATUS.dispatched);
	dbMod.updateStepStatus(db2, "san-wf-1", dbMod.STEP_STATUS.running);
	dbMod.updateStepStatus(db2, "san-wf-1", dbMod.STEP_STATUS.done);
	assert(
		dbMod.getStep(db2, "san-wf-1")!.status === "done",
		"合法链 pending→dispatched→running→done 通过",
	);
	dbMod.updateStepStatus(db2, "san-wf-1", dbMod.STEP_STATUS.conflict);
	assert(
		dbMod.getStep(db2, "san-wf-1")!.status === "conflict",
		"done → conflict(merge 冲突重开)合法",
	);
	// 非法迁移:明确错误 + 允许列表;同状态重复写入幂等
	try {
		dbMod.updateStepStatus(
			db2,
			"san-wf-1",
			dbMod.STEP_STATUS.dispatched,
			undefined,
			{
				strict: true,
			},
		);
		assert(false, "conflict → dispatched 应被拒绝");
	} catch (e) {
		const msg = (e as Error).message;
		assert(
			msg.includes("非法状态迁移: san-wf-1 conflict → dispatched") &&
				msg.includes("允许: conflict, done, failed, aborted, needs-fix, skipped"),
			`非法迁移报错含状态/允许集(${msg.slice(0, 60)}…)`,
		);
	}
	dbMod.updateStepStatus(db2, "san-wf-1", dbMod.STEP_STATUS.done);
	dbMod.updateStepStatus(db2, "san-wf-1", dbMod.STEP_STATUS.done);
	assert(
		dbMod.getStep(db2, "san-wf-1")!.status === "done",
		"done → done 幂等(重复写入不报错)",
	);
	try {
		dbMod.updateStepStatus(
			db2,
			"san-wf-1",
			dbMod.STEP_STATUS.running,
			undefined,
			{
				strict: true,
			},
		);
		assert(false, "done → running 应被拒绝");
	} catch (e) {
		assert(
			(e as Error).message.includes("非法状态迁移: san-wf-1 done → running") &&
				(e as Error).message.includes("允许: done, conflict"),
			`done → running 拒绝且列出仅存出口(${(e as Error).message.slice(0, 50)}…)`,
		);
	}
	try {
		dbMod.updateStepStatus(
			db2,
			"no-such-step",
			dbMod.STEP_STATUS.done,
			undefined,
			{
				strict: true,
			},
		);
		assert(false, "不存在步骤应报错");
	} catch (e) {
		assert(
			(e as Error).message.includes("步骤不存在"),
			"不存在步骤 → 步骤不存在错误",
		);
	}
	// 状态机接线不破坏真实 CLI 链路:skip 从 needs-fix 合法
	const smWf = orchMod.importPlan(
		db2,
		{
			name: "sm-wf",
			title: "状态机",
			goal: "接线",
			repoPath: sanRepo,
			steps: [{ id: "1", title: "a", agent: "worker", task: "a" }],
		},
		tmpDir,
		AGENTS,
	);
	assert(smWf.ok, "sm-wf 导入");
	dbMod.updateStepStatus(db2, "sm-wf-1", dbMod.STEP_STATUS.dispatched);
	dbMod.updateStepStatus(db2, "sm-wf-1", dbMod.STEP_STATUS.running);
	dbMod.updateStepStatus(db2, "sm-wf-1", dbMod.STEP_STATUS.needsFix, {
		error: "驳回",
	});
	pr = runCli(["skip", "sm-wf-1", "人工终态"], { cwd: tmpDir });
	assert(
		pr.code === 0 && dbMod.getStep(db2, "sm-wf-1")!.status === "skipped",
		`needs-fix → skipped 人工终态合法(${pr.code} ${pr.stdout.trim().slice(0, 40)})`,
	);

	// ────────────────────────────────────────────────────────
	// T27 master-agent 模式(主控 gittree 自主编排,发起方不阻塞)
	// ────────────────────────────────────────────────────────
	console.log("== T27 master-agent 模式 =");
	const masterMod = await import("../src/master.ts");
	const mRepo = path.join(tmpDir, "mrepo");
	fs.mkdirSync(mRepo, { recursive: true });
	execFileSync("git", ["init", "-q", mRepo]);
	execFileSync("git", ["-C", mRepo, "config", "user.email", "test@test.local"]);
	execFileSync("git", ["-C", mRepo, "config", "user.name", "test"]);
	fs.writeFileSync(path.join(mRepo, "README.md"), "master\n");
	execFileSync("git", ["-C", mRepo, "add", "-A"]);
	execFileSync("git", ["-C", mRepo, "commit", "-q", "-m", "init"]);

	// T27a 身份识别(master 优先于步骤,歧义按 workflow 存在性)
	const mWfId = "m-demo";
	process.env.PI_WF_MASTER = "env-master-wf";
	const envIdent = cmdMod.resolveIdentity("/whatever", db2);
	assert(
		envIdent?.master === true && envIdent.workflowId === "env-master-wf",
		"PI_WF_MASTER env → master 身份",
	);
	delete process.env.PI_WF_MASTER;
	const cwdIdent = cmdMod.resolveIdentity(
		path.join(mRepo, ".worktrees/gittree-wf-master-m-demo"),
		db2,
	);
	assert(
		cwdIdent?.master === true && cwdIdent.workflowId === "m-demo",
		"cwd 段 wf-master-<id> → master 身份",
	);
	// 歧义:仅 workflow cache-2 存在 → wf-master-cache-2 是它的主控;
	// 若 workflow master-cache 也存在 → 步骤解释优先(tie-break,文档化)
	const ambImport1 = orchMod.importPlan(
		db2,
		{
			name: "cache-2",
			title: "c",
			goal: "c",
			repoPath: tmpDir,
			steps: [{ id: "1", title: "a", agent: "worker", task: "a" }],
		},
		tmpDir,
		AGENTS,
	);
	assert(ambImport1.ok, "歧义测试 workflow cache-2 就绪");
	const ambMaster = cmdMod.resolveIdentity(
		"/r/.worktrees/gittree-wf-master-cache-2",
		db2,
	);
	assert(
		ambMaster?.master === true && ambMaster.workflowId === "cache-2",
		`wf-master-cache-2 → workflow cache-2 的主控(${ambMaster?.workflowId}/${ambMaster?.master})`,
	);
	// 两个 workflow 同时存在 → 步骤解释优先(与无 db 旧行为一致)
	const ambImport2 = orchMod.importPlan(
		db2,
		{
			name: "master-cache",
			title: "mc",
			goal: "mc",
			repoPath: tmpDir,
			steps: [{ id: "1", title: "a", agent: "worker", task: "a" }],
		},
		tmpDir,
		AGENTS,
	);
	assert(ambImport2.ok, "歧义测试 workflow master-cache 就绪");
	const ambBoth = cmdMod.resolveIdentity(
		"/r/.worktrees/gittree-wf-master-cache-2",
		db2,
	);
	assert(
		!ambBoth?.master &&
			ambBoth?.workflowId === "master-cache" &&
			ambBoth.dotted === "2",
		"两 workflow 并存 → 步骤解释优先(tie-break)",
	);
	const ambStep = cmdMod.resolveIdentity(
		"/r/.worktrees/gittree-wf-master-foo-1.1",
		db2,
	);
	assert(
		!ambStep?.master &&
			ambStep?.workflowId === "master-foo" &&
			ambStep.dotted === "1.1",
		`wf-master-foo-1.1 → workflow master-foo 的步骤(${ambStep?.workflowId}/${ambStep?.dotted})`,
	);

	// T27b createWorkflowWithMaster(真实 gittree + fake ghostctl)
	const mWtPath = path.join(mRepo, ".worktrees", "gittree-wf-master-m-demo");
	const fakeMCtl = path.join(tmpDir, "fake-ghostctl-master.sh");
	const mLog = path.join(tmpDir, "ghostctl-master.log");
	fs.writeFileSync(
		fakeMCtl,
		`#!/bin/bash\necho "$@" >> "${mLog}"\ncase "$1" in\n  layout)\n    echo '{"windows":[{"id":"tab-group-aabbccdd","front":true,"tabs":[{"terminals":[{"id":"masterterm0001","cwd":"${mWtPath}"}]}]}]}'\n    ;;\n  new-window)\n    echo "已创建窗口 (id=tab-group-aabbccdd)"\n    ;;\n  *)\n    echo "已创建标签页 (id=tab-master)"\n    ;;\nesac\n`,
		{ mode: 0o755 },
	);
	fs.writeFileSync(mLog, "");
	const mCreate = await masterMod.createWorkflowWithMaster(db2, {
		repoPath: mRepo,
		ownerCwd: tmpDir,
		workflowId: mWfId,
		title: "master demo",
		goal: "完成 demo 改造",
		gittreeBin: "gittree",
		ghostctlBin: fakeMCtl,
	});
	assert(mCreate.ok, `create 成功: ${mCreate.error ?? ""}`);
	assert(
		mCreate.masterBranchName === "gittree-wf-master-m-demo",
		`master 分支名(${mCreate.masterBranchName})`,
	);
	const mWfRow = dbMod.getWorkflow(db2, mWfId);
	assert(
		mWfRow?.status === "running" &&
			mWfRow.owner_cwd === tmpDir &&
			mWfRow.goal === "完成 demo 改造",
		"workflow 落库(running + owner_cwd + goal)",
	);
	assert(
		dbMod.getWorkflowMeta(db2, mWfId, "mode") === "master",
		"mode=master 元数据",
	);
	assert(
		dbMod.getWorkflowMeta(db2, mWfId, "ghostty_window_id") ===
			"tab-group-aabbccdd",
		"专属窗口绑定",
	);
	assert(
		dbMod.getWorkflowMeta(db2, mWfId, "master_tab_id") === "masterterm0001",
		"master tab id 落库",
	);
	assert(fs.existsSync(mWtPath), "master gittree 目录已创建");
	const mBr = execFileSync(
		"git",
		["-C", mRepo, "branch", "--list", "gittree-wf-master-m-demo"],
		{ encoding: "utf-8" },
	);
	assert(mBr.includes("gittree-wf-master-m-demo"), "master 分支已创建");
	const mRaw = fs.readFileSync(mLog, "utf-8");
	assert(
		mRaw.includes("new-window") &&
			mRaw.includes("--no-focus") &&
			mRaw.includes(`--cwd ${mRepo}`),
		"专属窗口后台创建(new-window --no-focus)",
	);
	assert(
		mRaw.includes("new-tab") &&
			mRaw.includes("--window-id tab-group-aabbccdd") &&
			mRaw.includes(`--cwd ${mWtPath}`) &&
			mRaw.includes("--at-end") &&
			mRaw.includes("--no-focus"),
		"主控 tab 开在专属窗口末尾(不抢焦点)",
	);
	assert(
		mRaw.includes("PI_WF_MASTER=m-demo") &&
			mRaw.includes("PI_WF_REPO") &&
			mRaw.includes("/wf plan"),
		"PI_WF_MASTER/PI_WF_REPO + 主控 pointer",
	);
	const mEvts = dbMod
		.getEvents(db2, { workflowId: mWfId, limit: 100 })
		.map((e) => e.type);
	assert(
		mEvts.includes("master_started"),
		`master_started 事件(${mEvts.join(",")})`,
	);
	// dry-run 零副作用
	const mDry = await masterMod.createWorkflowWithMaster(db2, {
		repoPath: mRepo,
		ownerCwd: tmpDir,
		workflowId: "m-dry",
		title: "dry",
		goal: "dry",
		dryRun: true,
	});
	assert(
		mDry.ok &&
			mDry.masterBranchName === "gittree-wf-master-m-dry" &&
			!dbMod.getWorkflow(db2, "m-dry") &&
			!fs.existsSync(path.join(mRepo, ".worktrees/gittree-wf-master-m-dry")),
		"create dry-run 零副作用",
	);
	// 残留防护:master gittree 已存在 → 拒绝
	const mDup = await masterMod.createWorkflowWithMaster(db2, {
		repoPath: mRepo,
		ownerCwd: tmpDir,
		workflowId: "m-demo",
		title: "t",
		goal: "g",
		gittreeBin: "gittree",
		ghostctlBin: fakeMCtl,
	});
	assert(!mDup.ok, "workflow 已存在拒绝创建");

	// T27b2 新建专属窗口的初始空白 tab 清理(Ghostty new window 自带一个空 tab)
	const sweepFake = path.join(tmpDir, "fake-ghostctl-sweep.sh");
	const sweepLog = path.join(tmpDir, "ghostctl-sweep.log");
	const sweepWt = path.join(mRepo, ".worktrees", "gittree-wf-master-m-sweep");
	fs.writeFileSync(
		sweepFake,
		`#!/bin/bash\necho "$@" >> "${sweepLog}"\ncase "$1" in\n  layout)\n    echo '{"windows":[{"id":"tab-group-aabbcc11","front":true,"tabs":[{"id":"tab-sweep-empty","terminals":[{"id":"emptyterm0001","cwd":"${mRepo}"}]},{"id":"tab-sweep-biz","terminals":[{"id":"sweterm0001","cwd":"${sweepWt}"}]}]}]}'\n    ;;\n  new-window)\n    echo "已创建窗口 (id=tab-group-aabbcc11)"\n    ;;\n  close-tab)\n    echo "已关闭标签页 $2"\n    ;;\n  *)\n    echo "已创建标签页 (id=tab-sweep-biz)"\n    ;;\nesac\n`,
		{ mode: 0o755 },
	);
	fs.writeFileSync(sweepLog, "");
	const sweepRes = await masterMod.createWorkflowWithMaster(db2, {
		repoPath: mRepo,
		ownerCwd: tmpDir,
		workflowId: "m-sweep",
		title: "sweep",
		goal: "sweep",
		gittreeBin: "gittree",
		ghostctlBin: sweepFake,
	});
	assert(sweepRes.ok, `sweep create 成功: ${sweepRes.error ?? ""}`);
	const sweepRaw = fs.readFileSync(sweepLog, "utf-8");
	assert(
		sweepRaw.includes("close-tab tab-sweep-empty"),
		`初始空白 tab 已清理(${sweepRaw.split("\n").filter(Boolean).join(" | ")})`,
	);
	assert(!sweepRaw.includes("close-tab tab-sweep-biz"), "业务 tab 保留(不误关)");

	// T27b3 sweep 重试:刚创建窗口的 tab 在 AppleScript 侧引用未就绪(-1728),
	// close-tab 失败后按退避重试,最终关闭空白 tab 且不误关业务 tab
	const wndMod = await import("../src/exec/window.ts");
	const retryFake = path.join(tmpDir, "fake-ghostctl-retry.sh");
	const retryLog = path.join(tmpDir, "ghostctl-retry.log");
	const retryFlag = path.join(tmpDir, "retry-fail.flag");
	fs.writeFileSync(
		retryFake,
		`#!/bin/bash\necho "$@" >> "${retryLog}"\ncase "$1" in\n  layout)\n    echo '{"windows":[{"id":"tab-group-sweepwin","front":true,"tabs":[{"id":"tab-sweep-empty","terminals":[{"id":"emptyterm0001"}]},{"id":"tab-sweep-biz","terminals":[{"id":"sweterm0001"}]}]}]}'\n    ;;\n  close-tab)\n    if [ ! -f "${retryFlag}" ]; then\n      touch "${retryFlag}"\n      echo "AppleScript 错误: -1728" >&2\n      exit 1\n    fi\n    echo "已关闭标签页 $2"\n    ;;\n  *)\n    echo "已创建标签页 (id=tab-sweep-biz)"\n    ;;\nesac\n`,
		{ mode: 0o755 },
	);
	fs.writeFileSync(retryLog, "");
	fs.rmSync(retryFlag, { force: true });
	await wndMod.sweepInitialTabs(
		retryFake,
		mRepo,
		"tab-group-sweepwin",
		"sweterm0001",
		{
			retryDelaysMs: [10, 10],
		},
	);
	const retryRaw = fs.readFileSync(retryLog, "utf-8");
	assert(
		(retryRaw.match(/close-tab tab-sweep-empty/g) ?? []).length === 2,
		`close-tab 失败后重试至成功(${retryRaw.split("\n").filter(Boolean).join(" | ")})`,
	);
	assert(!retryRaw.includes("close-tab tab-sweep-biz"), "重试不误关业务 tab");

	// T27c 空 workflow 首 wave 自动创建(主控 /wf plan --workflow 落点)
	const appRes = orchMod.appendSteps(
		db2,
		mWfId,
		1,
		{
			name: "m-demo",
			title: "t",
			goal: "g",
			steps: [
				{ id: "1", title: "改造 A", agent: "worker", task: "实现 A" },
				{
					id: "2",
					title: "改造 B",
					agent: "worker",
					task: "实现 B",
					deps: ["1"],
				},
			],
		},
		tmpDir,
		AGENTS,
	);
	assert(
		appRes.ok,
		`空 workflow 首 wave 自动创建(${appRes.errors?.join("; ") ?? ""})`,
	);
	assert(dbMod.getWorkflow(db2, mWfId)?.current_wave === 1, "current_wave=1");
	assert(dbMod.getStepsByWorkflow(db2, mWfId).length === 2, "2 步落库");
	const appRes2 = orchMod.appendSteps(
		db2,
		mWfId,
		1,
		{
			name: "m-demo",
			title: "t",
			goal: "g",
			steps: [{ id: "3", title: "改造 C", agent: "worker", task: "实现 C" }],
		},
		tmpDir,
		AGENTS,
	);
	assert(appRes2.ok && appRes2.added === 1, "已有 wave 追加照旧");

	// T27d 子任务 gittree 基于主控分支创建
	fs.writeFileSync(path.join(mWtPath, "MASTER.md"), "master work\n");
	execFileSync("git", ["-C", mWtPath, "add", "-A"]);
	execFileSync("git", ["-C", mWtPath, "commit", "-q", "-m", "master 首个提交"]);
	const masterHead = execFileSync(
		"git",
		["-C", mRepo, "rev-parse", "gittree-wf-master-m-demo"],
		{ encoding: "utf-8" },
	).trim();
	const subWt = path.join(mRepo, ".worktrees", "gittree-wf-m-demo-1");
	const fakeSubCtl = path.join(tmpDir, "fake-ghostctl-sub.sh");
	const subLog = path.join(tmpDir, "ghostctl-sub.log");
	const fakeGittree = path.join(tmpDir, "fake-gittree.sh");
	const gLog = path.join(tmpDir, "gittree-sub.log");
	fs.writeFileSync(
		fakeGittree,
		`#!/bin/bash\necho "$@" >> "${gLog}"\nexec gittree "$@"\n`,
		{ mode: 0o755 },
	);
	fs.writeFileSync(gLog, "");
	fs.writeFileSync(
		fakeSubCtl,
		`#!/bin/bash\necho "$@" >> "${subLog}"\ncase "$1" in\n  layout)\n    echo '{"windows":[{"id":"tab-group-aabbccdd","front":true,"tabs":[{"terminals":[{"id":"subterm0001","cwd":"${subWt}"}]}]}]}'\n    ;;\n  *)\n    echo "已创建标签页 (id=tab-sub)"\n    ;;\nesac\n`,
		{ mode: 0o755 },
	);
	fs.writeFileSync(subLog, "");
	const dRes = await dispatchMod.dispatchStep(
		db2,
		dbMod.getWorkflow(db2, mWfId)!,
		dbMod.getStep(db2, "m-demo-1")!,
		{ gittreeBin: fakeGittree, ghostctlBin: fakeSubCtl },
	);
	assert(dRes.ok, `master 模式派发成功: ${dRes.error ?? ""}`);
	assert(fs.existsSync(subWt), "子 worktree 已创建");
	const subHead = execFileSync(
		"git",
		["-C", mRepo, "rev-parse", "gittree-wf-m-demo-1"],
		{ encoding: "utf-8" },
	).trim();
	assert(subHead === masterHead, "子分支起点 = 主控分支 HEAD");
	assert(dbMod.getStep(db2, "m-demo-1")?.status === "running", "步骤 running");
	assert(
		fs
			.readFileSync(gLog, "utf-8")
			.includes("create wf-m-demo-1 gittree-wf-master-m-demo"),
		`gittree create 显式传主控分支为 base(${fs.readFileSync(gLog, "utf-8").split("\n").filter(Boolean).join(" | ")})`,
	);

	// T27e 子任务合并进主控分支(非主分支)
	fs.writeFileSync(path.join(subWt, "FEATURE.md"), "feature A\n");
	execFileSync("git", ["-C", subWt, "add", "-A"]);
	execFileSync("git", ["-C", subWt, "commit", "-q", "-m", "feat A"]);
	dbMod.updateStepStatus(db2, "m-demo-1", dbMod.STEP_STATUS.done);
	dbMod.updateStepStatus(db2, "m-demo-2", dbMod.STEP_STATUS.done);
	dbMod.updateStepStatus(db2, "m-demo-3", dbMod.STEP_STATUS.skipped);
	const mainHeadBefore = execFileSync(
		"git",
		["-C", mRepo, "rev-parse", "HEAD"],
		{ encoding: "utf-8" },
	).trim();
	const mwRow = dbMod.getWorkflow(db2, mWfId)!;
	const mergeRes = await monitorMod.mergeWave(db2, mwRow, 1);
	assert(mergeRes.ok, `wave 合并进主控分支: ${mergeRes.error ?? ""}`);
	assert(
		mergeRes.merged.includes("m-demo-1"),
		"done 步骤已合并(未派发步骤不参与合并)",
	);
	const masterLog = execFileSync(
		"git",
		["-C", mWtPath, "log", "--oneline", "-3"],
		{ encoding: "utf-8" },
	);
	assert(
		masterLog.includes("feat A"),
		`子提交合入主控分支(${masterLog.trim().split("\n").join(" | ")})`,
	);
	assert(
		fs.existsSync(path.join(mWtPath, "FEATURE.md")),
		"子功能文件已在主控 worktree",
	);
	assert(!fs.existsSync(subWt), "子 gittree 已删除(合并后)");
	assert(
		execFileSync("git", ["-C", mRepo, "rev-parse", "HEAD"], {
			encoding: "utf-8",
		}).trim() === mainHeadBefore,
		"主分支未动(master-merge 之前)",
	);
	assert(dbMod.getWave(db2, mWfId, 1)?.status === "merged", "wave merged");
	const wmEvts = dbMod
		.getEvents(db2, { workflowId: mWfId, limit: 100 })
		.map((e) => e.type);
	assert(
		wmEvts.includes("worktree_merged") && wmEvts.includes("wave_merged"),
		"worktree_merged + wave_merged 事件",
	);

	// T27f goal-check master 模式 → awaiting-merge + master_done
	const gc = orchMod.goalCheckApprove(db2, mWfId, "达标");
	assert(
		gc.ok && gc.status === "awaiting-merge",
		`goal-check approve → awaiting-merge(${gc.status})`,
	);
	const mWf2 = dbMod.getWorkflow(db2, mWfId)!;
	assert(
		mWf2.status === "awaiting-merge" &&
			Boolean(mWf2.goal_check?.includes("passed")) &&
			!mWf2.completed_at,
		"状态 awaiting-merge + goal_check 落库(未 completed)",
	);
	const gcEvts = dbMod
		.getEvents(db2, { workflowId: mWfId, limit: 100 })
		.map((e) => e.type);
	assert(
		gcEvts.includes("master_done") &&
			gcEvts.includes("workflow_goal_check_passed"),
		"master_done + workflow_goal_check_passed 事件",
	);

	// T27g 终局通知检测 + 会话角色过滤(mRepo 位于 tmpDir 内,前缀匹配会把
	// 其他 workflow 的事件也带进来,故先按 workflowId 收敛到 m-demo)
	const mOnly = (arr: NotifyItem[]): NotifyItem[] =>
		arr.filter((i) => i.workflowId === mWfId);
	const items = monitorMod.detectStateChanges(db2, { repoPath: mRepo });
	const mdItem = mOnly(items).find((i) => i.kind === "master-done");
	assert(
		mdItem?.workflowId === mWfId &&
			(mdItem.text.includes("/wf master-merge m-demo") ?? false),
		"master-done 通知项(含可执行命令)",
	);
	const asMaster = monitorMod.filterNotifyItems(db2, items, mWfId);
	assert(
		!mOnly(asMaster).some((i) => i.kind === "master-done"),
		"主控会话不接收自己的终局通知",
	);
	const asInitiator = monitorMod.filterNotifyItems(db2, items, null);
	assert(
		mOnly(asInitiator).some((i) => i.kind === "master-done"),
		"发起方会话收到 master-done",
	);
	assert(
		!mOnly(asInitiator).some(
			(i) =>
				i.kind === "reported" ||
				i.kind === "wave-done" ||
				i.kind === "workflow-done",
		),
		"发起方不收 step/wave 级事件(master 模式)",
	);
	// 主控会话收 step 级事件
	dbMod.updateStepStatus(db2, "m-demo-3", dbMod.STEP_STATUS.reported);
	const mItems2 = monitorMod.detectStateChanges(db2, { repoPath: mRepo });
	const asMaster2 = monitorMod.filterNotifyItems(db2, mItems2, mWfId);
	assert(
		mOnly(asMaster2).some(
			(i) => i.stepId === "m-demo-3" && i.kind === "reported",
		),
		"主控会话收到步骤级事件(reported)",
	);
	const asInitiator2 = monitorMod.filterNotifyItems(db2, mItems2, null);
	assert(
		!mOnly(asInitiator2).some((i) => i.stepId === "m-demo-3"),
		"发起方会话不收步骤级事件",
	);
	// markNotified 去重
	monitorMod.markNotified(db2, {
		workflowId: mWfId,
		kind: "master-done",
		text: "",
	});
	const mItems3 = monitorMod.detectStateChanges(db2, { repoPath: mRepo });
	assert(
		!mItems3.some((i) => i.kind === "master-done" && i.workflowId === mWfId),
		"markNotified 后 master-done 不再重复",
	);

	// T27h master-merge:发起方合并回主分支 + 清理
	// 守卫:非 awaiting-merge 拒绝
	dbMod.updateWorkflowStatus(db2, mWfId, "running");
	const badMerge = await masterMod.mergeMaster(db2, mWfId, {
		gittreeBin: "gittree",
		ghostctlBin: fakeMCtl,
	});
	assert(
		!badMerge.ok && (badMerge.error?.includes("awaiting-merge") ?? false),
		"非 awaiting-merge 拒绝合并",
	);
	dbMod.updateWorkflowStatus(db2, mWfId, "awaiting-merge");
	// 主控 worktree 残留 pi 运行时目录 → master-merge 前自动清理(否则 gittree 干净检查拦截)
	fs.mkdirSync(path.join(mWtPath, ".pi-glla"), { recursive: true });
	fs.writeFileSync(path.join(mWtPath, ".pi-glla", "state.json"), "{}");
	const mRes = await masterMod.mergeMaster(db2, mWfId, {
		gittreeBin: "gittree",
		ghostctlBin: fakeMCtl,
	});
	assert(mRes.ok, `master-merge 成功(自动清 .pi-glla): ${mRes.error ?? ""}`);
	assert(
		!fs.existsSync(path.join(mWtPath, ".pi-glla")),
		"master-merge 已清理主控 worktree 的 .pi-glla",
	);
	const mWf3 = dbMod.getWorkflow(db2, mWfId)!;
	assert(
		mWf3.status === "completed" && Boolean(mWf3.completed_at),
		"workflow completed",
	);
	assert(!fs.existsSync(mWtPath), "master gittree 已删除");
	const mBr2 = execFileSync(
		"git",
		["-C", mRepo, "branch", "--list", "gittree-wf-master-m-demo"],
		{ encoding: "utf-8" },
	);
	assert(!mBr2.includes("gittree-wf-master-m-demo"), "master 分支已删除");
	const mainLog = execFileSync("git", ["-C", mRepo, "log", "--oneline", "-4"], {
		encoding: "utf-8",
	});
	assert(
		mainLog.includes("feat A") && mainLog.includes("master 首个提交"),
		`主分支已包含主控全部提交(${mainLog.trim().split("\n").join(" | ")})`,
	);
	const mmEvts = dbMod
		.getEvents(db2, { workflowId: mWfId, limit: 100 })
		.map((e) => e.type);
	assert(
		mmEvts.includes("master_merged") && mmEvts.includes("workflow_completed"),
		"master_merged + workflow_completed 事件",
	);
	// 幂等
	const again = await masterMod.mergeMaster(db2, mWfId, {
		gittreeBin: "gittree",
		ghostctlBin: fakeMCtl,
	});
	assert(again.ok, "重复 master-merge 幂等(ok)");

	// T27i master-fail:主控放弃 → 通知发起方
	const mfFail = masterMod.markMasterFailed(db2, mWfId, "x");
	assert(!mfFail.ok, "已 completed 拒绝标记失败");
	const fCreate = await masterMod.createWorkflowWithMaster(db2, {
		repoPath: mRepo,
		ownerCwd: tmpDir,
		workflowId: "m-fail",
		title: "f",
		goal: "f",
		gittreeBin: "gittree",
		ghostctlBin: fakeMCtl,
	});
	assert(fCreate.ok, "m-fail create");
	const mfRes = masterMod.markMasterFailed(db2, "m-fail", "无法继续");
	assert(mfRes.ok, "master-fail 标记成功");
	assert(dbMod.getWorkflow(db2, "m-fail")?.status === "failed", "status=failed");
	const fEvts = dbMod
		.getEvents(db2, { workflowId: "m-fail", limit: 10 })
		.map((e) => e.type);
	assert(fEvts.includes("master_failed"), "master_failed 事件");
	const fItems = monitorMod.detectStateChanges(db2, { repoPath: mRepo });
	assert(
		fItems.some((i) => i.kind === "master-failed" && i.workflowId === "m-fail"),
		"master-failed 通知项(发起方可接管)",
	);

	// T27j CLI 双入口
	pr = runCli(
		["create", "CLI 目标", "--repo", mRepo, "--id", "cli-master", "--dry-run"],
		{ cwd: tmpDir },
	);
	assert(
		pr.code === 0 &&
			pr.stdout.includes("cli-master") &&
			pr.stdout.includes("gittree-wf-master-cli-master") &&
			!dbMod.getWorkflow(db2, "cli-master"),
		`CLI create --dry-run 零副作用(${pr.stdout.trim().slice(0, 60)})`,
	);
	pr = runCli(["master-merge", "m-demo"], { cwd: tmpDir });
	assert(
		pr.code === 0 && pr.stdout.includes("已合并完成"),
		`重复 master-merge 幂等(exit ${pr.code})`,
	);
	pr = runCli(["master-merge"], { cwd: tmpDir });
	assert(pr.code === 3, "master-merge 缺参 → 退出 3");
	pr = runCli(["master-fail"], { cwd: tmpDir });
	assert(pr.code === 3, "master-fail 缺参 → 退出 3");
	const plainWf = orchMod.importPlan(
		db2,
		{
			name: "plain-wf",
			title: "p",
			goal: "p",
			repoPath: mRepo,
			steps: [{ id: "1", title: "a", agent: "worker", task: "a" }],
		},
		tmpDir,
		AGENTS,
	);
	assert(plainWf.ok, "plain-wf 导入(对照)");
	pr = runCli(["master-merge", "plain-wf"], { cwd: tmpDir });
	assert(
		pr.code === 1 && pr.stderr.includes("不是 master-agent 模式"),
		"非 master 模式 master-merge 拒绝",
	);
	pr = runCli(["master-fail", "plain-wf", "x"], { cwd: tmpDir });
	assert(
		pr.code === 1 && pr.stderr.includes("不是 master-agent 模式"),
		"非 master 模式 master-fail 拒绝",
	);
	// import --workflow:主控自研计划导入已有 workflow(空 workflow 自动建 wave 1)
	const impWf = await masterMod.createWorkflowWithMaster(db2, {
		repoPath: mRepo,
		ownerCwd: tmpDir,
		workflowId: "m-imp",
		title: "imp",
		goal: "imp",
		gittreeBin: "gittree",
		ghostctlBin: fakeMCtl,
	});
	assert(impWf.ok, "m-imp create");
	const impPlan = path.join(tmpDir, "m-imp-plan.json");
	fs.writeFileSync(
		impPlan,
		JSON.stringify({
			name: "m-imp",
			title: "t",
			goal: "g",
			steps: [{ id: "1", title: "a", agent: "worker", task: "a" }],
		}),
	);
	pr = runCli(["import", impPlan, "--workflow", "m-imp"], { cwd: tmpDir });
	assert(
		pr.code === 0 &&
			pr.stdout.includes("已向 m-imp 导入 1 个步骤") &&
			dbMod.getStep(db2, "m-imp-1") !== undefined,
		`import --workflow 追加到已有 workflow(${pr.stdout.trim().slice(0, 60)})`,
	);
	// 终态 workflow 拒绝追加
	pr = runCli(["import", impPlan, "--workflow", "m-demo"], { cwd: tmpDir });
	assert(
		pr.code === 1 && pr.stderr.includes("已终态"),
		"终态 workflow 拒绝追加步骤",
	);

	// T27j2 .pi-glla 启动即忽略(会话启动时确保进 .gitignore,防 merge 干净检查拦截)
	assert(
		cmdMod.ensureGllaIgnored(mRepo) === true,
		"ensureGllaIgnored 首次追加 .gitignore 条目",
	);
	const giAfter = fs.readFileSync(path.join(mRepo, ".gitignore"), "utf-8");
	assert(
		giAfter.includes(".pi-glla/"),
		".gitignore 含 .pi-glla/ 条目",
	);
	assert(
		cmdMod.ensureGllaIgnored(mRepo) === false,
		"ensureGllaIgnored 幂等(已存在不再追加)",
	);
	assert(
		cmdMod.ensureGllaIgnored(path.join(tmpDir, "no-such-dir")) === false,
		"非 git 仓库静默跳过",
	);

	// T27k dead-master:主控 tab 消失 → 标记 + 通知(独立于 running 步骤)
	const deadFake = path.join(tmpDir, "fake-ghostctl-dead.sh");
	fs.writeFileSync(
		deadFake,
		`#!/bin/bash\ncase "$1" in\n  layout)\n    echo '{"windows":[{"id":"tab-group-aabbccdd","front":true,"tabs":[]}]}'\n    ;;\n  *)\n    echo "已创建标签页 (id=tab-dead)"\n    ;;\nesac\n`,
		{ mode: 0o755 },
	);
	const deadCreate = await masterMod.createWorkflowWithMaster(db2, {
		repoPath: mRepo,
		ownerCwd: tmpDir,
		workflowId: "m-dead",
		title: "d",
		goal: "d",
		gittreeBin: "gittree",
		ghostctlBin: fakeMCtl,
	});
	assert(deadCreate.ok, "m-dead create(无 running 步骤场景)");
	// 模拟已绑定的主控 tab(create 时 fake layout 的 cwd 不匹配,master_tab_id 未落库)
	dbMod.setWorkflowMeta(db2, "m-dead", "master_tab_id", "deadterm0001");
	await monitorMod.pollOnce(db2, { repoPath: mRepo, ghostctlBin: deadFake });
	await monitorMod.pollOnce(db2, { repoPath: mRepo, ghostctlBin: deadFake });
	assert(
		dbMod.getWorkflowMeta(db2, "m-dead", "master_dead_at") !== undefined,
		"连续 2 轮未命中 → master_dead_at 标记",
	);
	const deadEvts = dbMod
		.getEvents(db2, { workflowId: "m-dead", limit: 10 })
		.map((e) => e.type);
	assert(
		deadEvts.includes("master_tab_closed"),
		"master_tab_closed 事件(dead-master)",
	);
	const deadItems = monitorMod.detectStateChanges(db2, { repoPath: mRepo });
	assert(
		deadItems.some(
			(i) => i.kind === "master-failed" && i.workflowId === "m-dead",
		),
		"dead-master → master-failed 通知项(发起方可接管)",
	);
	// 主控恢复存活 → 计数清零,不再误报
	const aliveFake = path.join(tmpDir, "fake-ghostctl-alive.sh");
	fs.writeFileSync(
		aliveFake,
		`#!/bin/bash\ncase "$1" in\n  layout)\n    echo '{"windows":[{"id":"tab-group-aabbccdd","front":true,"tabs":[{"terminals":[{"id":"deadterm0001","cwd":"x"}]}]}]}'\n    ;;\n  *)\n    echo "x"\n    ;;\nesac\n`,
		{ mode: 0o755 },
	);
	await monitorMod.pollOnce(db2, { repoPath: mRepo, ghostctlBin: aliveFake });
	assert(
		dbMod.getWorkflowMeta(db2, "m-dead", "master_tab_miss") === 0,
		"主控恢复 → 未命中计数清零",
	);

	// status --json 不因新状态(awaiting-merge/completed/failed)崩溃
	pr = runCli(["status", "--json"], { cwd: mRepo });
	assert(
		pr.code === 0 && pr.stdout.includes("m-demo") && pr.stdout.includes("m-fail"),
		`status --json 全状态可渲染(${pr.stdout.slice(0, 60).replace(/\n/g, " ")})`,
	);

	// 清理
	try {
		db2.close();
	} catch {
		/* ignore */
	}
	fs.rmSync(tmpDir, { recursive: true, force: true });

	console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
	if (failed > 0) process.exit(1);
}

main().catch((e) => {
	console.error("测试异常:", e);
	process.exit(1);
});
