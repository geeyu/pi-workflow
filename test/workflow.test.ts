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
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

// 必须在 import db.ts 之前设置(DB_PATH 模块加载时计算)
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
	const dbMod = await import("../src/db.ts");
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
	assert(ver === 1, `user_version = 1(实际 ${ver})`);
	dbMod.resetDbForTests();
	const db2 = dbMod.getDb();
	const ver2 = (
		db2.prepare("PRAGMA user_version").get() as { user_version: number }
	).user_version;
	assert(ver2 === 1, "迁移幂等:重连后 user_version 仍为 1");

	console.log("== T2 validatePlan ==");
	const validateMod = await import("../src/validate.ts");
	const okPlan = validateMod.validatePlan(DEMO_PLAN, AGENTS);
	assert(okPlan.ok, "合法计划通过");
	assert(okPlan.steps.length === 4, "4 个步骤");
	const s11 = okPlan.steps.find((s) => s.dotted === "1.1")!;
	assert(s11.parentId === "demo-wf-1", `1.1 父 id 推导: ${s11.parentId}`);
	assert(s11.fullId === "demo-wf-1.1", "完整 id = workflowId-dotted");
	assert(s11.sortOrder === 1001, `sort_order 层级编码: ${s11.sortOrder}`);
	assert(
		validateMod.packDotted("1.2.3") === 1002003,
		"packDotted(1.2.3)=1002003",
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
		steps.every((s) => s.task_md === DEMO_PLAN.steps.find((p) => p.id === s.id.slice("demo-wf".length + 1))?.task),
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
	const dispatchMod = await import("../src/dispatch.ts");
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
		dry.pointer!.includes("/wf context") &&
			dry.pointer!.includes("/wf done 1.1"),
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
	const wt1Path = path.join(
		scratchRepo,
		".worktrees",
		"gittree-wf-scratch-wf-1",
	);
	fs.writeFileSync(
		fakeGhostctl,
		`#!/bin/bash\nif [ "$1" = "layout" ]; then\n  echo '{"windows":[{"id":"win-test-1","front":true,"tabs":[{"terminals":[{"id":"abcdef0123456789","cwd":"${wt1Path}"}]}]}]}'\nelse\n  echo "已创建标签页 (id=tab-xyz)"\nfi\n`,
		{ mode: 0o755 },
	);
	const sWf = dbMod.getWorkflow(db2, "scratch-wf")!;
	const sStep = dbMod.getStep(db2, "scratch-wf-1")!;
	const real = await dispatchMod.dispatchStep(db2, sWf, sStep, {
		gittreeBin: "gittree",
		ghostctlBin: fakeGhostctl,
	});
	assert(real.ok, `派发成功: ${real.error ?? ""}`);
	const boundWin = dbMod.getWorkflowMeta(
		db2,
		"scratch-wf",
		"ghostty_window_id",
	);
	assert(boundWin === "win-test-1", "workflow 绑定焦点窗口(meta)");
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
	assert(!v2.ok && v2.error!.includes("仅 reported"), "已 done 不可重复核对");
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
	assert(
		costScratch !== null && costScratch.attempts === 1,
		"成本聚合(1 尝试)",
	);
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

	console.log("== T10 monitor 存活检测 ==");
	const monitorMod = await import("../src/monitor.ts");
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
	// fake layout 不含该 terminal → pollOnce 标记 aborted
	const fakeGone = path.join(tmpDir, "fake-ghostctl-gone.sh");
	fs.writeFileSync(
		fakeGone,
		`#!/bin/bash\necho '{"windows":[{"tabs":[{"terminals":[]}]}]}'\n`,
		{ mode: 0o755 },
	);
	const gone = await monitorMod.pollOnce(db2, { ghostctlBin: fakeGone });
	assert(gone.closed.includes("scratch-wf-1"), "tab 消失未回报 → aborted");
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
		!fs.existsSync(
			path.join(scratchRepo, ".worktrees", "gittree-wf-merge-wf-1"),
		),
		"merge --delete 清理 worktree",
	);

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
	db2.prepare(
		"UPDATE workflow_steps SET started_at = ?, timeout_min = 1 WHERE id = 'ready-wf-1'",
	).run(Date.now() - 3 * 60 * 1000);
	const poll = await monitorMod.pollOnce(db2, { ghostctlBin: fakeGhostctl });
	assert(poll.timedOut.includes("ready-wf-1"), "超时标 aborted");
	assert(
		dbMod.getStep(db2, "ready-wf-1")?.status === "aborted",
		"超时步骤 aborted",
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
