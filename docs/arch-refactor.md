> [!NOTE] 实施状态(2026-08-15)
> 本文为架构重构(wf-arch)的施工契约/记录,**已全部实施并合并回主分支**(合并树 276 测试全绿)。
> 当前代码结构以本文为准;如后续再重构,请更新 DESIGN.md 后再改本文。

# 架构重构细化设计(任务 1 输出)

> 依据:docs/arch-review.md(主控问题清单与目标布局)+ 对 src/ 全量通读(本任务执行时点)。
> 本文是任务 1.1 / 1.2 的**实现契约**:接口签名可照抄、迁移清单无遗漏、文件边界不重叠。
> 总原则:纯重构。命令语义、DB schema、事件类型、输出文案(除 §6 明列的统一错误格式)一律不变,测试全绿。

---

## 0. 事实基线(本设计立足的现状数据)

| 项 | 数值 |
| --- | --- |
| src/ 模块 | 12 个(index/cli/dispatch/monitor/orchestrator/db/board/planner/validate/agents/session/pi-types) |
| cli.ts | 1589 行;25 个 CLI 子命令(main switch)+ help |
| index.ts | 1343 行;workflowExtension 单函数,18 个 cmd* 闭包 + handler switch(20 个 pi 子命令) |
| process.exit | cli.ts 共 **74 处**:`process.exit(` 68 处 + `process.exitCode =` 6 处(见 §6 分类) |
| STATUS_ICON | index.ts 1 份 + cli.ts 1 份 + board.ts `STATUS_ICON_BOARD` 1 份(值完全相同) |
| 命令集 | 共享 16 条(import/dispatch/verify/retry/rebind-window/merge/plan/goal-check/next/status/board/tree/step/events/done/fail) |
| 命令集 | CLI 独有 11 条(plan-init/clean/tabs/inject/poll/session/open-tab/fix-tab/cleanup/doctor/debug);pi 独有 4 条(context/steer/resolve-conflict/resume) |
| 测试依赖 | test/workflow.test.ts(1912 行)动态 import:`../src/dispatch.ts`(renderTaskMd/injectDeps/dispatchStep/piInvocation/openStepTab)、`../src/index.ts`(resolveIdentity/workflowStatusSegment/sendWorkflowNotifications)、`../src/monitor.ts`(mergeWave/detectStateChanges/markNotified/pollOnce/getReadySteps/NotifyItem)、`../src/board.ts`、`../src/orchestrator.ts`、`../src/db.ts`、`../src/validate.ts` |

**由此导出两条硬约束**:
1. 被迁移函数所在**旧模块路径必须继续导出同名符号**(兼容再导出壳,§3.9),否则测试/既有调用面必破;
2. 1.1 与 1.2 的文件集必须**尽量不相交**,相交处只能是「单行区域」,且 1.1 先行合并(§4.2)。

---

## 1. 目标布局(修订版)

arch-review §3 的布局基础上做两处修订,理由见 §4.3:

```text
src/
├── index.ts        # 插件入口:注册命令 + 生命周期(session_start/shutdown);resolveIdentity/sendWorkflowNotifications 兼容再导出
├── cli.ts          # CLI 入口:main 查注册表,统一退出码;bin/wf 不变
├── command.ts      # ★(1.1 新建)命令注册表:CommandDef/CmdEnv/UsageError/parseArgs/registry + 全部 31 条命令体
├── core/
│   ├── state.ts    # ★(1.1 新建)STATUS_ICON/stepIcon 单一来源 + 状态机迁移表(数据+canTransition,本期不接线)
│   └── db.ts       # (不变,原样;位置迁移留后续 wave)
├── exec/
│   ├── shell.ts    # ★(1.2 新建)run/resolveBin/resolveOnPath/piInvocation/worktreeName/worktreePath
│   ├── window.ts   # ★(1.2 新建)sendTextToTerminal/openStepTab/findTerminalId/parseLayout/resolveWorkflowWindow
│   └── template.ts # ★(1.2 新建)renderTaskMd/injectDeps/getDepSummaries/parseExpectations/buildPointer
├── observe/
│   ├── wave.ts     # ★(1.2 新建)mergeWave/mergePreview(自 monitor 拆出)
│   └── monitor.ts  # (不变,原样;减 merge 后为再导出壳,位置留后续 wave)
├── ui/
│   ├── status.ts   # ★(1.1 新建)statusCountsLine/renderWorkflowStatus/workflowStatusSegment/WF_ANSI/WF_STATUS_COLOR
│   ├── notify.ts   # ★(1.2 新建)sendWorkflowNotifications/WorkflowNotifySender/NOTIFY_MAX_LINES
│   └── board.ts    # (不变,原样;STATUS_ICON_BOARD 改为引用 core/state,位置留后续 wave)
├── plan/           # (后续 wave:planner/validate/agents 内迁,本期不建)
├── dispatch.ts     # (1.2 改)派发流程 + 兼容再导出壳(位置留后续 wave)
└── session.ts      # (不变,原样)
```

> 与 arch-review 布局的差异:`exec/dispatch.ts`、`observe/monitor.ts`、`core/db.ts`、`ui/board.ts`、`plan/*` 的**目录搬迁本期不做**(避免测试 import 面与文件集膨胀),仅完成「职责拆分 + 图标收敛」;目录搬迁列为后续 wave(见 §9 后续项)。

---

## 2. command.ts 完整接口设计(任务 ①)

### 2.1 类型与注册表(可直接照抄)

```ts
// src/command.ts(1.1 新建)
import type { DatabaseSync } from "node:sqlite";
import type { StepRow } from "./db.ts";

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
	if (registry.has(def.name)) throw new Error(`命令重复注册: ${def.name}`);
	registry.set(def.name, def);
}

export function getCommand(name: string): CommandDef | undefined {
	return registry.get(name);
}

/** 列出命令(可按入口过滤),按 name 排序;help 与补全共用 */
export function listCommands(entry?: "cli" | "pi"): CommandDef[] {
	return [...registry.values()]
		.filter((d) => !entry || d.entry === entry || d.entry === "both")
		.sort((a, b) => a.name.localeCompare(b.name));
}
```

### 2.2 参数解析(flagValue/positionalArgs 收敛)

```ts
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
	readonly values: Map<string, string> = new Map();   // 带值 flag:名(含前缀)→ 值
	readonly bools: Set<string> = new Set();            // 出现的 boolean flag 名(含前缀)
	readonly positionals: string[] = [];                // 位置参数(跳过全部 flag 及其值)

	/** 带值 flag 取值(缺省返回默认) */
	value(name: string, def?: string): string | undefined;
	/** boolean flag 是否出现 */
	bool(name: string): boolean;
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
			out.values.set(spec.name, args[i + 1]);   // 与现状 flagValue 一致:取下一个 token,可为 undefined
			i += 2;
		} else if (spec && spec.value === "greedy") {
			out.values.set(spec.name, args.slice(i + 1).join(" "));
			break;                                     // 消费剩余全部
		} else if (spec) {
			out.bools.add(spec.name);
			i += 1;
		} else {
			out.positionals.push(tok);                 // 非 flag(含未声明 "--xxx" → 与现状 positionalArgs 一致:凡以 - 开头未命中 spec 也丢弃)
			i += 1;
		}
	}
	return out;
}
```

行为等价性说明:
- 现状 `positionalArgs` 丢弃所有 `--` 开头 token 与 `-n`;**parseArgs 对未声明 flag 同样丢弃**(不落入 positionals),等价;
- 现状 `flagValue` 取 `args[idx+1]`(不校验是否为另一 flag),parseArgs 同样直取,等价;
- `--note` 用 `"greedy"` 精确复刻现状 `args.slice(noteIdx + 1).join(" ")`;`wf next <wfId> --note ...` 标准用法完全一致,`--note` 在 wfId 之前的畸形用法两者都报错(错误形态略有差异,见 §9);
- 各命令的 flag 表见 §2.5,实现时逐命令核对「现状读法 → spec」对照。

### 2.3 共享解析助手(自 index.ts/cli.ts 收敛)

```ts
/** 子 pi 身份(自 index.ts 移入;index.ts 保留 `export { resolveIdentity } from "./command.ts"` 兼容) */
export interface WfIdentity {
	workflowId: string;
	dotted: string | null;
	stepId: string | null;
}
export function resolveIdentity(cwd: string): WfIdentity | null;

/** workflow 解析:显式参数 → 身份 env → cwd 所在仓库的活动 workflow(自两入口收敛,env.cwd 取代 process.cwd()/ctx.cwd) */
export function resolveWorkflowId(env: CmdEnv, explicit?: string): string | null;

/** 步骤解析:完整 id 直接命中 → 点号 id 按身份/活动 workflow 兜底(自 cli.resolveStepId + index.findStep 收敛) */
export function resolveStepId(env: CmdEnv, token: string): StepRow | null;

/** JSON 参数解析(自 index.parseJsonArg 收敛;CLI cmdImport/cmdDone 的裸 JSON.parse 改用它) */
export function parseJsonArg(raw: string): { ok: boolean; value?: unknown; error?: string };
```

### 2.4 适配器(伪代码,可直接照抄)

**CLI 适配器(cli.ts,1.1 后全文件):**

```ts
// src/cli.ts — 仅剩:适配器 + help 渲染
import { getCommand, listCommands, UsageError, type CmdEnv } from "./command.ts";
import { getDb } from "./db.ts";

function createCliEnv(): CmdEnv {
	return {
		kind: "cli",
		cwd: process.cwd(),
		db: getDb(),
		show: (lines) => { for (const l of lines) console.log(l); },
		info: (line) => console.log(line),
		warn: (line) => console.warn(line),
		fail: (line) => { console.error(line); process.exitCode = 1; },
		notifyPi: () => { /* pi 专属提示,CLI 不输出 */ },
		setExitCode: (code) => { process.exitCode = code; },
	};
}

function printHelp(): void {
	// 与现状 help 文本逐字一致(静态首部 + listCommands("cli") 生成的命令行)
	// 验收:改后跑 `wf help` 与改前 diff,除格式外必须等价、命令齐全(27 条 + help)。
}

async function main(): Promise<void> {
	const [cmd, ...args] = process.argv.slice(2);
	if (cmd === "help" || cmd === undefined) { printHelp(); return; }
	const def = getCommand(cmd);
	if (!def) {
		console.error(`未知命令: ${cmd}(wf help 查看用法)`);
		process.exitCode = 1;                       // 现状 exit(1)
		return;
	}
	const env = createCliEnv();
	try {
		await def.run(args, env);
	} catch (e) {
		if (e instanceof UsageError) {
			console.error(`用法: ${def.usage}`);      // 用法错误 → 3(§6.2)
			process.exitCode = 3;
		} else {
			console.error("执行失败:", (e as Error).message);
			if (process.exitCode === undefined) process.exitCode = 1;
		}
	}
}

main().catch((e) => {
	console.error("执行失败:", (e as Error).message);
	if (process.exitCode === undefined) process.exitCode = 1;   // 尾部统一兜底
});
```

**pi 适配器(index.ts handler,1.1 后):**

```ts
handler: async (args, ctx) => {
	const [sub, ...rest] = args.trim().split(/\s+/);
	const def = getCommand(sub);
	if (!def) {
		notify(ctx, `用法: /wf import|dispatch|context|done|fail|verify|merge|status|tree|step|events\n示例: /wf status / /wf import plan.json / /wf done 1.1 '{"summary":"..."}'`, "warning");
		return;
	}
	const env: CmdEnv = {
		kind: "pi",
		cwd: ctx.cwd,
		db,
		show: (lines) => {
			if (def.widget) ctx.ui.setWidget(def.widget, lines);
			else notify(ctx, lines.join("\n"), "info");
		},
		info: (line) => notify(ctx, line, "info"),
		warn: (line) => notify(ctx, line, "warning"),
		fail: (line) => notify(ctx, line, "error"),
		notifyPi: (line) => notify(ctx, line, "info"),
		setExitCode: () => { /* pi 无退出码 */ },
	};
	try {
		await def.run(rest, env);
	} catch (e) {
		if (e instanceof UsageError) notify(ctx, `用法: ${def.usage}`, "warning");
		else notify(ctx, `wf 命令失败: ${(e as Error).message}`, "error");
	} finally {
		renderWorkflowStatus(ctx, db);   // 状态条刷新,import 自 ./ui/status.ts
	}
},
```

补全列表(现状 12 词 → 补齐 20 词,验收 #5「命令齐全」):

```ts
getArgumentCompletions: (prefix) =>
	listCommands("pi")
		.map((d) => d.name)
		.filter((w) => w.startsWith(prefix))
		.map((w) => ({ value: w, label: w })),
```

### 2.5 命令清单与 flag 表(31 条,实现对照)

| name | entry | widget | async | 现状来源 | flag specs |
| --- | --- | --- | --- | --- | --- |
| plan-init | cli | – | – | cli cmdPlanInit | --repo(v), --steps(v) |
| import | both | – | – | cli cmdImport + pi cmdImport | (无) |
| status | both | workflow-status | – | cli printStatusText/printStatusJson + pi cmdStatus | --json(b), --all(b) |
| tree | both | workflow-tree | – | cli printTree + pi cmdTree | (无) |
| board | both | workflow-board | – | cli cmdBoard + pi cmdBoard | --html(v), --wave(v) |
| step | both | workflow-step | – | cli cmdStep + pi cmdStep | (无) |
| events | both | workflow-events | – | cli cmdEvents + pi cmdEvents | --follow(b) |
| dispatch | both | – | ✓ | cli cmdDispatch + pi cmdDispatch | --dry-run(b), --workflow(v) |
| verify | both | – | – | cli cmdVerify + pi cmdVerify | (无) |
| merge | both | – | ✓ | cli cmdMerge + pi cmdMerge | --wave(v) |
| retry | both | – | ✓ | cli cmdRetry + pi cmdRetry | --fresh(b) |
| rebind-window | both | – | ✓ | cli cmdRebindWindow + pi cmdRebindWindow | (无) |
| plan | both | workflow-plan | ✓ | cli cmdPlan + pi cmdPlan | --repo(v), --workflow(v), --dry-run(b) |
| goal-check | both | workflow-goal-check | – | cli cmdGoalCheck + pi cmdGoalCheck | --workflow(v) |
| next | both | – | – | cli cmdNext + pi cmdNext | --note(greedy) |
| done | both | – | – | cli cmdDone + pi cmdDone | (无) |
| fail | both | – | – | cli cmdFail + pi cmdFail | (无) |
| clean | cli | – | – | cli cmdClean | (无) |
| tabs | cli | – | ✓ | cli cmdTabs | --json(b) |
| inject | cli | – | ✓ | cli cmdInject | (无) |
| poll | cli | – | ✓ | cli cmdPoll | --until(v), --timeout(v), --interval(v) |
| session | cli | – | ✓ | cli cmdSession | -n(v, alias 无长名), --json(b), --last(b) |
| open-tab | cli | – | ✓ | cli cmdOpenTab | (无) |
| fix-tab | cli | – | ✓ | cli cmdFixTab | (无) |
| cleanup | cli | – | ✓ | cli cmdCleanup | --dry-run(b), --no-fix(b) |
| doctor | cli | – | – | cli cmdDoctor | (无) |
| debug | cli | – | – | cli cmdDebug | (无) |
| context | pi | workflow-task | – | pi cmdContext | (无) |
| steer | pi | – | ✓ | pi cmdSteer | (无) |
| resolve-conflict | pi | – | – | pi cmdResolveConflict | (无) |
| resume | pi | – | – | pi cmdResume | (无) |

实现注意:
- `session` 的 `--last` 必须声明为 boolean flag(现状 `wfArg === "--last"` 判断依赖它不进 positionals);
- `poll`/`events` 的 `--follow`/`--until` 等值不得落入 positionals(由 spec 消费);
- `board`/`merge` 的 wfId 位置参数现状跳过 `/^\d+$/`(wave 数字),parseArgs 给出原始 positionals 后由命令体按现状规则再过滤(命令级过滤允许,见 §2.6)。

### 2.6 命令体结构(「共用段 + 输出段」模式)

run() 一律按三段组织:

```text
① 解析段   parsed = parseArgs(args, FLAGS); resolveWorkflowId/resolveStepId/校验
② 执行段   调用 orchestrator/dispatch/monitor/board 等(双入口共用,零分支)
③ 输出段   按 env.kind 渲染与现状逐字一致的两套文案;用法错误 throw UsageError;业务失败 env.fail(...)
```

**入口特有逻辑**(现状行为差异,必须逐条保留,仅允许在输出段或显式标注的入口分支中体现):

| # | 命令 | pi 特有 | CLI 特有 |
| --- | --- | --- | --- |
| 1 | dispatch | 预算护栏(checkBudget→paused)、无参数=派发就绪步骤、step.workflow_id 归属检查 | 无参数=空循环(现状) |
| 2 | verify | 缺省 action = approve | 缺省 action = 用法错误 |
| 3 | status | --all;行内容含 waves/最近事件 | --json;行内容含 repo/base/绑定窗口/运行中 tab |
| 4 | merge | 成功行追加 `,N 个跳过`(skipped>0 时) | 不追加 |
| 5 | goal-check | enter 分支 → show()+notifyPi;approve/reject 走 orchestrator(goalCheckEnter/Approve/Reject) | enter 分支直接 buildUpdate 写库(现状绕过 orchestrator,见 arch-review P1 #9;**本期保留现状**,列入后续 wave) |
| 6 | plan | dry-run → widget + notify;planner 进行中 notify 在 await 前立即输出 | dry-run → JSON 打印 |
| 7 | done/fail/import/rebind-window | 文案不同(见下表) | 文案不同 |

**输出段契约表**(11 条双入口文案差异命令;其余命令两入口共用同一文本,直接 env.info/show):

| 命令 | CLI 输出(现状逐字) | pi 输出(现状逐字) |
| --- | --- | --- |
| import | `✓ 已导入 ${id}:${n} 个步骤(wave ${w})` | `已导入 ${id}:${n} 个步骤(wave ${w}),可用 /wf dispatch 派发` |
| dispatch | 逐 token `✓ ${t}: running tab=… worktree=…` / `◦ …[dry-run]` / `✗ ${t}: ${err}` | 一次 `results.join("\n\n")`(含 attempt= 字段) |
| verify | `✓ ${id} → ${res.status}` / `✗ ${res.error}` | `已核对通过 ${id} → done` / `已驳回 ${id} → needs-fix` / `未知动作: ${a}(approve\|reject)` |
| merge | `✓ wave ${n} 合并完成:${m} 个步骤合回主分支` / `✗ wave ${n} 合并未完成: ${err}` | 同左 + (skipped>0) `,${s} 个跳过`;失败走 warn |
| retry | `✓ 已重派 ${id}${fresh?" (--fresh)":""} tab=…` | `已重派 ${id}${fresh?" (--fresh 重建 worktree)":""} tab=…` |
| plan | `✓ 已向 ${wf} 追加 ${n} 个步骤` / `✓ 已生成 workflow …` / `✗ …` | `✓ 已向 ${wf} 追加 ${n} 个步骤(wave ${w}),可 /wf dispatch 派发` / `✓ 已生成 workflow …,可 /wf dispatch 派发` |
| goal-check | approve `✓ ${id} 目标核对通过 → completed`;reject `✗ ${id} 目标未达成 → 回到 running;/wf next 拆 gap wave` | approve `✓ ${id} 目标核对通过 → completed`;reject `${id} 目标未达成 → 回到 running;/wf next 拆 gap wave 补齐`(warn) |
| next | `✓ wave ${n} 已创建${note?`(${note})`:""};wf plan --workflow ${id} 补步骤` | `wave ${n} 已创建${…};用 /wf plan --workflow ${id} 补步骤,或 /wf dispatch 派发` |
| done | `✓ ${id} → ${res.status}` | waiting-verify:`已回报 ${id},等待编排者 /wf verify approve\|reject`;否则 `已回报 ${id},编排者将核对期望(或 /wf verify)` |
| fail | `✓ ${id} → failed` | `已标记失败 ${id}`(warn) |
| rebind-window | `✓ ${wfId} 绑定窗口: ${old} → ${new}(当前焦点窗口)` | `✓ ${wfId} 绑定窗口: ${old} → ${new}(当前焦点窗口)`(pi 无 ✓,其余同) |

> 实现方式:输出段形如 `env.info(env.kind === "cli" ? "✓ …" : "已…")`。**只允许在文本构造处分支,禁止逻辑分支**。

---

## 3. 新文件函数级迁移清单(任务 ②)

> 改名策略:全部**同名迁移**(`truncate`/`parseLayout`/`TAB_ID_RE` 等私有符号随迁不导出);原文件位置保留兼容再导出(§3.9)。`→` 表示迁移,`留在` 表示不迁移。

### 3.1 src/core/state.ts(1.1 新建)

| 原文件/函数 | 新文件/函数 | 说明 |
| --- | --- | --- |
| index.ts `STATUS_ICON` | core/state.ts `STATUS_ICON` | 值不变;单一来源(§5) |
| index.ts `stepIcon(step: StepRow)` | core/state.ts `stepIcon(status: string)` | **签名微调**:入参由 StepRow 改为 status 字符串(调用点同步改,如 `stepIcon(s.status)`),行为不变 |
| cli.ts `STATUS_ICON` | (删除,并入上) | printTree 改调 stepIcon |
| board.ts `STATUS_ICON_BOARD` | (1.2 改为 `= STATUS_ICON`,§5.2) | 兼容导出名保留 |
| (新)状态机迁移表 | core/state.ts `STEP_TRANSITIONS` / `canTransition(from,to)` | 从现状迁移调用点提炼(**初稿见 §5.3,1.1 只建表不接线**,接线列为后续 wave) |

### 3.2 src/ui/status.ts(1.1 新建)

| 原文件/函数 | 新文件/函数 | 说明 |
| --- | --- | --- |
| index.ts `statusCountsLine` | ui/status.ts `statusCountsLine` | 同名 |
| index.ts `renderWorkflowStatus` | ui/status.ts `renderWorkflowStatus` | 同名;依赖 ctx 类型(pi-types.d.ts) |
| index.ts `workflowStatusSegment` | ui/status.ts `workflowStatusSegment` | 同名;index.ts 保留再导出(测试 T9 用) |
| index.ts `WF_ANSI` | ui/status.ts `WF_ANSI` | 私有 |
| index.ts `WF_STATUS_COLOR` | ui/status.ts `WF_STATUS_COLOR` | 私有 |
| index.ts `notify`(包装 ctx.ui.notify) | 留在 index.ts | 适配器私有助手,不迁 |

### 3.3 src/ui/notify.ts(1.2 新建)

| 原文件/函数 | 新文件/函数 | 说明 |
| --- | --- | --- |
| index.ts `WorkflowNotifySender`(interface) | ui/notify.ts `WorkflowNotifySender` | 同名 |
| index.ts `NOTIFY_MAX_LINES` | ui/notify.ts `NOTIFY_MAX_LINES` | 同名,值 5 |
| index.ts `sendWorkflowNotifications` | ui/notify.ts `sendWorkflowNotifications` | 同名;依赖 monitor.markNotified(import ./monitor.ts) |

### 3.4 src/exec/shell.ts(1.2 新建)

| 原文件/函数 | 新文件/函数 | 说明 |
| --- | --- | --- |
| dispatch.ts `RunResult`(interface) | exec/shell.ts `RunResult` | 同名 |
| dispatch.ts `run` | exec/shell.ts `run` | 同名 |
| dispatch.ts `resolveOnPath`(私有) | exec/shell.ts `resolveOnPath` | 私有,不导出 |
| dispatch.ts `piInvocation` | exec/shell.ts `piInvocation` | 同名 |
| dispatch.ts `resolveBin` | exec/shell.ts `resolveBin` | 同名 |
| dispatch.ts `worktreeName` | exec/shell.ts `worktreeName` | 同名;**必须迁出 dispatch.ts**(window/template/dispatch 三方共用,留在 dispatch 会与 window/template 成环,见 §4.4) |
| dispatch.ts `worktreePath` | exec/shell.ts `worktreePath` | 同上 |

> shell.ts 定位:「无状态工具层」= 进程执行 + 可执行文件解析 + worktree 路径计算(三者均无依赖,最先 import)。

### 3.5 src/exec/window.ts(1.2 新建)

| 原文件/函数 | 新文件/函数 | 说明 |
| --- | --- | --- |
| dispatch.ts `sendTextToTerminal` | exec/window.ts `sendTextToTerminal` | 同名 |
| dispatch.ts `OpenStepTabResult`(interface) | exec/window.ts `OpenStepTabResult` | 同名 |
| dispatch.ts `OpenStepTabOptions`(interface) | exec/window.ts `OpenStepTabOptions` | 同名 |
| dispatch.ts `openStepTab` | exec/window.ts `openStepTab` | 同名 |
| dispatch.ts `TAB_ID_RE`(私有) | exec/window.ts `TAB_ID_RE` | 私有 |
| dispatch.ts `WfWindowInfo`(私有 interface) | exec/window.ts `WfWindowInfo` | 私有 |
| dispatch.ts `parseLayout`(私有) | exec/window.ts `parseLayout` | 私有 |
| dispatch.ts `resolveWorkflowWindow`(私有) | exec/window.ts `resolveWorkflowWindow` | 私有 |
| dispatch.ts `findTerminalId` | exec/window.ts `findTerminalId` | 同名 |
| dispatch.ts `WF_WINDOW_META_KEY` | exec/window.ts `WF_WINDOW_META_KEY` | 同名;const 值 "ghostty_window_id" |

### 3.6 src/exec/template.ts(1.2 新建)

| 原文件/函数 | 新文件/函数 | 说明 |
| --- | --- | --- |
| dispatch.ts `DepSummary`(interface) | exec/template.ts `DepSummary` | 同名 |
| dispatch.ts `MAX_INJECT`(私有) | exec/template.ts `MAX_INJECT` | 私有,值 8*1024 |
| dispatch.ts `truncate`(私有) | exec/template.ts `truncate` | 私有 |
| dispatch.ts `getDepSummaries` | exec/template.ts `getDepSummaries` | 同名 |
| dispatch.ts `injectDeps` | exec/template.ts `injectDeps` | 同名 |
| dispatch.ts `parseExpectations` | exec/template.ts `parseExpectations` | 同名 |
| dispatch.ts `renderTaskMd` | exec/template.ts `renderTaskMd` | 同名 |
| dispatch.ts `buildPointer` | exec/template.ts `buildPointer` | 同名 |

### 3.7 src/observe/wave.ts(1.2 新建)

| 原文件/函数 | 新文件/函数 | 说明 |
| --- | --- | --- |
| monitor.ts `MergeResult`(interface) | observe/wave.ts `MergeResult` | 同名 |
| monitor.ts `mergeWave` | observe/wave.ts `mergeWave` | 同名 |
| monitor.ts `mergePreview` | observe/wave.ts `mergePreview` | 同名 |

### 3.8 留在原地的函数(明确不迁移)

| 文件 | 保留清单 |
| --- | --- |
| dispatch.ts | `dispatchStep`、`DispatchResult`、`DispatchOptions`、`depsDone`、`ensureBaseSha`、`abortDispatch`(私有)、`DISPATCHABLE`(私有) |
| monitor.ts | `pollTargetReached`、`fetchLiveTabIds`、`PollResult`、`pollOnce`、`recoverStaleSteps`、`MonitorOptions`、`startMonitor`、`NotifyKind`、`NotifyItem`、`DetectOptions`、`detectStateChanges`、`markNotified`、`getReadySteps` |
| index.ts | `workflowExtension`(生命周期)、`notify`(私有)、`resolveIdentity` 的**导出名**(定义移 command.ts,index 再导出) |
| board.ts | 全部(buildBoard/renderBoardText/renderBoardHtml/cardLine/esc/COLUMNS/Board*),仅 `STATUS_ICON_BOARD` 改源 |
| cli.ts | 仅适配器(§2.4) |
| orchestrator.ts / db.ts / planner.ts / validate.ts / agents.ts / session.ts / pi-types.d.ts | 原样,1.1 与 1.2 均不碰 |

### 3.9 兼容再导出壳(shim,兼容策略的落地形式)

```ts
// dispatch.ts 末尾(1.2):被拆函数同名再导出,调用面零改动
export {
	sendTextToTerminal,
	openStepTab,
	findTerminalId,
	WF_WINDOW_META_KEY,
	run,
	resolveBin,
	piInvocation,
	worktreeName,
	worktreePath,
	getDepSummaries,
	injectDeps,
	parseExpectations,
	renderTaskMd,
	buildPointer,
} from "./exec/shell.ts";   // 注意按实际文件分两条/多条 import
// + export type { RunResult, OpenStepTabResult, OpenStepTabOptions, DepSummary } from "...";

// monitor.ts 末尾(1.2):
export { mergeWave, mergePreview } from "./observe/wave.ts";
export type { MergeResult } from "./observe/wave.ts";

// index.ts(1.1):resolveIdentity 定义已移 command.ts
export { resolveIdentity, type WfIdentity } from "./command.ts";
// index.ts(1.2):sendWorkflowNotifications 定义已移 ui/notify.ts(§4.1 唯一单行区域)
export { sendWorkflowNotifications, NOTIFY_MAX_LINES, type WorkflowNotifySender } from "./ui/notify.ts";
```

> 各新文件之间**内部 import 一律指向新文件**(如 window.ts import shell.ts / template.ts,wave.ts import shell.ts),不再经由 dispatch.ts 中转;shim 只为「外部调用面」(cli/index/command/test)提供兼容。

### 3.10 迁移后 import 图(无环)

```text
core/state.ts ─→ db.ts
ui/status.ts  ─→ db.ts, core/state.ts, pi-types.d.ts(仅类型)
ui/notify.ts  ─→ db.ts, monitor.ts(markNotified)
exec/shell.ts ─→ (仅 node 内置)
exec/template.ts ─→ db.ts, exec/shell.ts(worktreeName)
exec/window.ts ─→ db.ts, exec/shell.ts(run/resolveBin/worktreePath), exec/template.ts(buildPointer)
observe/wave.ts ─→ db.ts, exec/shell.ts(run/resolveBin/worktreeName/worktreePath)
dispatch.ts   ─→ db.ts, exec/shell.ts, exec/window.ts(openStepTab), exec/template.ts(renderTaskMd/buildPointer)
monitor.ts    ─→ db.ts, dispatch.ts(depsDone), exec/shell.ts(run/resolveBin), observe/wave.ts(再导出)
command.ts    ─→ db.ts, orchestrator.ts, dispatch.ts, monitor.ts, board.ts, planner.ts, session.ts,
                 ui/status.ts(statusCountsLine), core/state.ts(stepIcon), node 内置
index.ts      ─→ command.ts, ui/status.ts, ui/notify.ts, monitor.ts, orchestrator.ts, planner.ts,
                 board.ts, db.ts, pi-types.d.ts
cli.ts        ─→ command.ts, db.ts
```

方向:entry(command/cli/index)→ ui → observe/exec → core → db;无环。**关键约束:exec/* 与 observe/* 不得 import dispatch.ts / monitor.ts / index.ts / cli.ts**(仅允许反向)。

---

## 4. 1.1 与 1.2 文件边界(任务 ③)

### 4.1 文件集(完全不相交,除一处单行区域)

| 任务 | 新建 | 修改 | 禁止触碰 |
| --- | --- | --- | --- |
| **1.1 命令注册表化** | `src/command.ts`、`src/core/state.ts`、`src/ui/status.ts` | `src/cli.ts`(整体重写为适配器)、`src/index.ts`(命令区 + 展示区 → import) | dispatch.ts / monitor.ts / board.ts / orchestrator.ts / db.ts / planner.ts / validate.ts / agents.ts / session.ts / test/ |
| **1.2 模块拆分** | `src/exec/shell.ts`、`src/exec/window.ts`、`src/exec/template.ts`、`src/observe/wave.ts`、`src/ui/notify.ts` | `src/dispatch.ts`(删被拆函数 + 再导出)、`src/monitor.ts`(删 merge* + 再导出)、`src/board.ts`(STATUS_ICON_BOARD 改源)、`src/index.ts`(**仅 sendWorkflowNotifications 定义块 → 再导出,§4.1**) | command.ts / core/state.ts / ui/status.ts / cli.ts / orchestrator.ts / db.ts / planner.ts / validate.ts / agents.ts / session.ts / test/ |

- 两任务共同触碰文件:**仅 index.ts 一个**,且区域分隔(1.1 = 命令区 + 展示区;1.2 = notify 定义块,位于展示区与命令区之间的独立段),满足验收 #7「不重叠或仅 import 行重叠」;
- 1.2 **不改 cli.ts**(cli 适配器只 import command.ts,command.ts 的 import 面由 shim 保持稳定)→ cli.ts 零合并冲突;
- 1.2 **不改 command.ts**(命令体经 dispatch.ts/monitor.ts shim 取函数)→ command.ts 零合并冲突。

### 4.2 迁移顺序(1.1 先行,已由 sort_order 保证)

wave 1 合并按 sort_order 串行:`1`(本文档)→ `1.1` → `1.2`。1.1 先合入后,1.2 的 index.ts 改动(notify 定义块删除 + 再导出)基于 1.1 保留的**字节不变区域**应用,git 3-way 可干净合并。
**1.1 实现约束**:重写 index.ts 时,`sendWorkflowNotifications`/`WorkflowNotifySender`/`NOTIFY_MAX_LINES` 定义块(现状 index.ts 约 262–330 行)**原样保留、一字不改**;`notify` 助手与 `workflowExtension` 生命周期段保留(仅 handler 内部改查注册表)。
**1.2 实现约束**:对 index.ts 只做「删除 notify 定义块 → 替换为 §3.9 再导出行」,不碰其他任何行。

### 4.3 与 arch-review §5 的差异及理由(已与主控对齐)

| review §5 原方案 | 本设计 | 理由 |
| --- | --- | --- |
| 1.1 只建 command.ts;1.2 建全部 7 个新文件(含 core/state.ts、ui/status.ts) | 1.1 建 command.ts + core/state.ts + ui/status.ts;1.2 建其余 5 个 | command.ts 的 4 条命令依赖 stepIcon/statusCountsLine;若等 1.2 建 ui/status.ts,command.ts←→index.ts 必成循环依赖;且 1.2 从 command.ts 再搬图标会跨任务改文件 |
| 1.2 改 dispatch/monitor/index/cli 的 import 与调用点 | 1.2 改 dispatch/monitor/board + index.ts 单区域;**cli.ts 零改动** | shim 策略(§3.9)保持 dispatch/monitor 导出面不变,cli.ts/command.ts 的 import 全部不动,合并冲突降为零 |
| 目标布局含 exec/dispatch.ts、observe/monitor.ts、core/db.ts、ui/board.ts、plan/* 目录搬迁 | 本期只拆职责、不搬目录 | 目录搬迁会破坏测试动态 import 路径(§0 硬约束 1);搬迁列入后续 wave(§9) |
| 状态机迁移表(新逻辑)由 1.2 实现 | 1.1 建表(数据 + canTransition,不接线);接线列为后续 wave | 1.2 约束为「纯移动,禁止改任何行为」,接线会引入行为面变化 |

### 4.4 循环依赖规避要点(1.2 实现时逐条核对)

1. `worktreeName`/`worktreePath` **必须**离开 dispatch.ts 进 exec/shell.ts —— 否则 window.ts(openStepTab)与 template.ts(renderTaskMd)将反向 import dispatch.ts,与 dispatchStep→openStepTab/renderTaskMd 成环;
2. `buildPointer` 进 template.ts、`piInvocation`/`run`/`resolveBin` 进 shell.ts —— window.ts 的 openStepTab 全部依赖来自 shell/template,不 import dispatch.ts;
3. `depsDone` 留在 dispatch.ts,monitor.ts(getReadySteps)单向 import dispatch.ts(现状即如此,保持);
4. ui/notify.ts import monitor.ts(markNotified)是「ui→observe」方向,与分层一致。

---

## 5. STATUS_ICON / stepIcon 收敛方案(任务 ④)

### 5.1 单一来源

```ts
// src/core/state.ts(1.1 新建)
export const STATUS_ICON: Record<string, string> = {
	pending: "○", ready: "○", dispatched: "▶", running: "▶",
	reported: "◐", "waiting-verify": "◐", done: "✓", skipped: "–",
	failed: "✗", aborted: "✗", conflict: "⚠", "needs-fix": "↻",
};
/** 入参改为 status 字符串(原 index.ts 版入参为 StepRow) */
export function stepIcon(status: string): string {
	return STATUS_ICON[status] ?? "?";
}
```

### 5.2 各引用方改造

| 引用方 | 改造 |
| --- | --- |
| command.ts(1.1) | `import { STATUS_ICON, stepIcon } from "./core/state.ts"`;cmdTree/cmdStep/cmdGoalCheck 用 `stepIcon(s.status)`;printTree 的 `STATUS_ICON[s.status]` 改 `stepIcon(s.status)`(输出等价) |
| ui/status.ts(1.1) | `import { stepIcon, STATUS_ICON } from "./core/state.ts"`;renderWorkflowStatus 中硬编码的 `▶`/`◐`/`✗` 字面量改为 `STATUS_ICON.running`/`STATUS_ICON.reported`/`STATUS_ICON.failed`(值相同,文案零变化) |
| index.ts(1.1) | 删除本地 STATUS_ICON/stepIcon 定义;不再引用(命令已移 command.ts) |
| cli.ts(1.1) | 删除本地 STATUS_ICON(printTree 已移 command.ts) |
| board.ts(1.2) | 删除本地 `STATUS_ICON_BOARD` 定义,改为:`import { STATUS_ICON } from "./core/state.ts"; export const STATUS_ICON_BOARD: Record<string, string> = STATUS_ICON;`(兼容导出名 + 单一来源,cardLine 等调用点不变) |

### 5.3 状态机迁移表(初稿,1.1 建表不接线)

```ts
// core/state.ts(与图标同文件;接线 = 后续 wave 的 P1 #10 项)
/** 步骤状态合法迁移:key = 当前状态 → 允许的目标状态集(从现状调用点提炼,初稿) */
export const STEP_TRANSITIONS: Record<string, readonly string[]> = {
	pending:        ["ready", "dispatched", "failed", "aborted", "skipped"],
	ready:          ["dispatched", "failed", "aborted", "skipped"],
	dispatched:     ["running", "failed", "aborted", "skipped"],
	running:        ["reported", "waiting-verify", "failed", "aborted", "conflict", "needs-fix", "done", "skipped"],
	reported:       ["done", "needs-fix", "failed", "skipped"],
	"waiting-verify": ["done", "needs-fix", "failed", "skipped"],
	done:           [],
	skipped:        [],
	failed:         ["dispatched", "running", "failed", "aborted", "needs-fix"],   // 可重派
	aborted:        ["dispatched", "running", "failed", "aborted", "needs-fix"],
	"needs-fix":    ["dispatched", "running", "failed", "aborted", "needs-fix"],
	conflict:       ["done", "failed", "aborted", "needs-fix"],                    // resolve-conflict → done
};
export function canTransition(from: string, to: string): boolean {
	return STEP_TRANSITIONS[from]?.includes(to) ?? false;
}
export const WORKFLOW_TRANSITIONS: Record<string, readonly string[]> = {
	idle: ["running"], running: ["paused", "verifying", "completed", "failed", "aborted"],
	paused: ["running"], verifying: ["completed", "running"],
	completed: [], failed: [], aborted: [],
};
```

现状迁移调用点核对清单(建表时对照,不接线所以不阻塞):orchestrator reportDone(running/reported/waiting-verify→reported/waiting-verify)、verifyStep(→done/needs-fix)、reportFail(→failed)、goalCheck*(workflow)、monitor pollOnce(→aborted)、mergeWave(→conflict)、index resolveConflict(conflict→done)、dispatch dispatchStep(→dispatched/running)、importPlan(初始 pending/ready)。

---

## 6. process.exit 收敛策略(任务 ⑤,74 处)

### 6.1 现状构成(已逐行清点)

| 类别 | 数量 | 位置 |
| --- | --- | --- |
| `process.exit(1)` 业务/用法错误 | 61 | printTree 1、cmdBoard 2、cmdPlanInit 1、cmdImport 3、cmdDispatch 2、cmdVerify 2、cmdRebindWindow 5、cmdMerge 3、cmdRetry 5、cmdPlan 5、cmdGoalCheck 3、cmdNext 2、cmdDone 3、cmdFail 2、cmdStep 2、cmdTabs 2、cmdCleanup 1、cmdInject 3、cmdSession 1、cmdOpenTab 5、cmdFixTab 6、main 2 |
| `process.exit(3)` 用法错误(新命令) | 5 | cmdInject 1、cmdSession 2、cmdOpenTab 1、cmdFixTab 1(行号 1011/1170/1178/1241/1315) |
| `process.exitCode = 3`(poll 已先行改造) | 5 | cmdPoll 用法校验 |
| `process.exitCode = code`(poll 达成/超时/不可达) | 1 | cmdPoll finish |
| `process.exit(0)` / `process.exit(130)`(SIGINT) | 2 | cmdEvents --follow 结束、cmdPoll 中断 |

### 6.2 四类处理规则

| 类别 | 处理 | CLI 结果 | pi 结果 |
| --- | --- | --- | --- |
| **A. 用法/参数错误**(缺参数、非法 action、非法 --until/--timeout/--interval、-n 非数字、缺 token 等) | run 内 `throw new UsageError(具体提示)` | 适配器 `console.error("用法: " + def.usage)` + **exitCode=3** | 适配器 notify(warning) |
| **B. 业务错误**(workflow/步骤不存在、JSON 解析失败、ghostctl/gittree/planner 失败、校验失败、导入失败、超限等) | `env.fail(提示)` 后 return | console.error + exitCode=1 | notify(error) |
| **C. 特殊退出码**(poll 达成 0/超时 1/不可达 2、SIGINT 130、events follow 结束 0) | `env.setExitCode(n)` + 清理定时器 + 自然返回 | exitCode=n | no-op |
| **D. main 尾部兜底** | `main().catch`:console.error + `process.exitCode ??= 1`;未知命令 exitCode=1 | exitCode=1 | — |

**A 类语义变化(唯一允许的退出码变化,已文档化)**:旧命令用法错误原为 exit(1),统一为 exit(3) —— 与新增命令(inject/poll/session/open-tab/fix-tab)既有约定一致,也是「统一错误格式」的一部分。业务错误仍为 1,成功为 0,与 SKILL §5.5.1 退出码约定一致。

### 6.3 命令级对照(1.1 迁移时逐条勾销)

| 命令 | A 用法→UsageError | B 业务→env.fail | C 特殊→setExitCode |
| --- | --- | --- | --- |
| plan-init | 缺 name/goal(原 exit1) | – | – |
| import | 缺 file(原 exit1) | JSON 解析失败、读取失败、导入失败(原 exit1) | – |
| status | – | – | – |
| tree | – | 无法确定 workflow(原 exit1) | – |
| board | – | 无法确定 workflow、workflow 不存在(原 exit1) | – |
| step | 缺 id | 步骤不存在 | – |
| events | – | – | follow 结束 SIGINT → setExitCode(0)+clearInterval(原 exit(0)) |
| dispatch | – | 无法确定 workflow、workflow 不存在 | – |
| verify | 缺 id/action 非法 | 核对失败 | – |
| merge | – | 无法确定 workflow、workflow 不存在、合并失败 | – |
| retry | 缺 token | 步骤不存在、状态不可重试、workflow 不存在、重派失败 | – |
| rebind-window | – | 5 处(workflow 解析/ghostctl/JSON/无窗口) | – |
| plan | 空 request | planner 失败、输出缺 name/steps、追加失败、导入失败 | – |
| goal-check | action 非法 | 无法确定 workflow、workflow 不存在 | – |
| next | – | 无法确定 workflow、workflow 不存在 | – |
| done | 缺 id/JSON | JSON 解析失败、回报失败 | – |
| fail | 缺 id | 标记失败失败 | – |
| inject | 缺 target/text(原 exit3) | 无 tab、注入失败(原 exit1) | – |
| poll | --until/--timeout/--interval 非法、无法确定 wf、wf 不存在(原 exitCode=3,保持) | – | 达成 0 / 超时 1 / 不可达 2;SIGINT → setExitCode(130)+clearInterval(原 exit(130)) |
| session | -n 非法、wf 不存在(原 exit3) | 无会话文件(原 exit1) | – |
| open-tab | 缺 token/tid(原 exit3) | 步骤/workflow 不存在、无 worktree、tab 存活、layout 失败、open 失败(原 exit1) | – |
| fix-tab | 缺 token/tid(原 exit3) | 步骤/workflow 不存在、layout 校验失败、前缀不唯一(原 exit1) | – |
| cleanup | – | 无法确定 workflow(原 exit1) | – |
| tabs | – | 无法确定 workflow、layout 失败(原 exit1) | – |
| main | 未知命令 → exitCode=1(现状 exit(1),保持 1 不归 3:未知命令≠用法错误) | catch 兜底 exitCode=1 | – |

### 6.4 定时器注意点(1.1 实现必须处理)

改用自然退出后,**不得残留存活定时器**(否则进程挂起):
1. cmdPoll:finish() 已 clearInterval;tick 需加 try/catch(异常 → finish(1, …)),SIGINT 改 `clearInterval + setExitCode(130)`;
2. cmdEvents --follow:SIGINT 改 `clearInterval + setExitCode(0)`;
3. 上述两条为唯一注册 process.on("SIGINT") 的命令,保留在命令体内(注册表世界一个进程只跑一个命令,安全)。

### 6.5 最终验收形态

```bash
grep -n "process\.exit(" src/cli.ts src/command.ts   # → 空
grep -rn "process\.exit" src/cli.ts src/command.ts   # 仅允许 process.exitCode 赋值
```

---

## 7. 已知行为变化(全部,共 4 处,均为文档化改进)

1. **用法错误退出码 1 → 3**(§6.2 A 类):旧命令(plan-init/import/verify/retry/plan/goal-check/done/fail/step 等 9 条)的用法错误原 exit(1),统一为 3(与新增命令 inject/poll/session/open-tab/fix-tab 既有约定一致);
2. **/wf 补全列表 12 词 → 20 词**(§2.4):补齐 steer/merge/plan/goal-check/next/board/resume/resolve-conflict(验收 #5「命令齐全」);
3. **状态条图标引用统一**:renderWorkflowStatus 的字面量 ▶◐✗ 改为 STATUS_ICON 常量(渲染值逐字节相同,肉眼零变化);
4. **畸形用法差异**:`wf next --note x <wfId>`(--note 在 wfId 前)等非标准用法,错误提示形态可能变化(均报错,不再细究)。

其余(命令语义、DB schema、事件类型、全部输出文案、退出码 0/1/2、poll 行为、SIGINT 码、--json 结构)一律不变。

---

## 8. 验收清单(任务 ⑥,1.1/1.2 共用,全部必须)

1. **测试全绿**:`node --experimental-strip-types test/workflow.test.ts` 全绿(PATH 需含 ~/.local/bin;T1–T24 全过);
2. **无循环依赖**:按 §3.10 import 图核对,exec/*、observe/* 不反向 import 入口层;可用 `grep -rn "from \"\./" src/exec src/observe src/ui src/core` 抽查;
3. **process.exit 收敛**:`grep -n "process\.exit(" src/cli.ts src/command.ts` 为空;`process.exit` 全库仅剩 process.exitCode 赋值(信号/定时器路径已按 §6.4 处理);
4. **图标单一来源**:`grep -rn "STATUS_ICON" src/core/state.ts` 是唯一定义处;index.ts/cli.ts/board.ts/ui/status.ts/command.ts 均引用之;board.ts 的 STATUS_ICON_BOARD 为别名;
5. **命令齐全**:`wf help` 与改前输出等价且包含全部 27 条 CLI 命令;`/wf` 补全列表 = 20 词(listCommands("pi") 全量);
6. **冒烟**:`wf status`、`wf doctor`、`wf import`(临时 plan.json)、`wf tree` 可运行且输出与改前一致;pi 侧 `/wf status`、`/wf step <id>` 行为一致;
7. **边界验收**:1.1 与 1.2 改动文件集按 §4.1 不相交(index.ts 仅 sendWorkflowNotifications 区域分隔);合并顺序 1.1 → 1.2;
8. **行为零漂移抽查**:`wf poll --until done --timeout 1`(超时路径 exitCode=1)、`wf poll --until bogus`(用法 exitCode=3)、`wf events --follow` + Ctrl+C(exitCode=0)三点人工验证;
9. 1.1 完成时:index.ts 的 sendWorkflowNotifications 定义块一字未动(供 1.2 干净替换);1.2 完成时:index.ts 除 notify 块外无其他改动。

---

## 9. 后续 wave(不在本期范围,仅备案)

- `exec/dispatch.ts`、`observe/monitor.ts`、`core/db.ts`、`ui/board.ts`、`plan/{planner,validate,agents}.ts` 目录内迁(需要同步改 test 动态 import 或保留 shim);
- 状态机迁移表**接线**:用 canTransition 替换 orchestrator/dispatch 的散落 if 校验(arch-review P1 #10);
- cli goal-check 直写库改走 orchestrator(arch-review P1 #9);
- 输出文案统一为「语义结果 + 双适配器渲染」(消除 §2.6 输出段 kind 分支);
- 去 shim:调用面全部指向新文件后删除旧路径再导出壳。
