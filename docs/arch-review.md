# 架构 Review 与重构设计(主控通读全库后输出)

> 基于对 src/ 全部 11 个模块、test(1912 行,T1-T24)、DESIGN.md、SKILL.md 的完整通读。
> 目标:分层规范化、设计模式化、可扩展化、可编排化;行为零变化,测试全绿。

## 1. 现状(做得好的,保留)

- **分层清晰**:db(数据)→ orchestrator(纯流程逻辑)→ dispatch/monitor(副作用)→ index/cli(适配层);
- **事件审计**:workflow_events 只增不改,全生命周期可追溯;
- **双入口共享核心**:`/wf`(插件)与 `wf`(CLI)共用 orchestrator/dispatch/monitor,行为一致;
- **契约化回报** + 模板注入 + metadata KV 扩展点 + 测试覆盖全状态机。

## 2. 问题清单(按严重度)

### P0 坏味道(重构重点)

| # | 问题 | 位置 | 影响 |
| --- | --- | --- | --- |
| 1 | **巨型函数**:workflowExtension 单函数 1343 行、复杂度 196,18 个 cmd* 闭包内定义 | index.ts | 不可测、不可扩展 |
| 2 | **双入口命令重复**:/wf 与 CLI 各一套 cmd*、两套参数解析(flagValue/positionalArgs)、两套错误处理(notify vs console.error) | index.ts / cli.ts | 行为漂移(已实际发生:CLI piInvocation bug) |
| 3 | **process.exit 散落 74 处**:管道下截断输出(已修 poll 一处,其余同险) | cli.ts | 输出丢失、不可测试 |
| 4 | **同域常量重复**:STATUS_ICON 在 index.ts 与 cli.ts 各一份,board.ts 还有 STATUS_ICON_BOARD | 多处 | 不一致风险 |
| 5 | **职责混杂**:dispatch.ts 同时是进程执行+二进制解析+窗口解析+模板渲染+派发流程 | dispatch.ts(824 行) | 单一文件多职责 |
| 6 | **monitor.ts 混杂**:存活轮询 + 事件检测 + wave 合并(mergeWave 属流程逻辑) | monitor.ts(621 行) | 职责边界模糊 |
| 7 | **main() 手写 switch 分发**(25 命令),新命令要改两处 | cli.ts / index.ts | 不可扩展 |

### P1 规范一致

| # | 问题 | 位置 |
| --- | --- | --- |
| 8 | UI 渲染函数(statusCountsLine/renderWorkflowStatus)与通知发送(sendWorkflowNotifications)驻留 index.ts | index.ts |
| 9 | cli.ts 部分命令直接 buildUpdate 写库,绕过 orchestrator | cli.ts(cmdGoalCheck 等) |
| 10 | 状态迁移校验散落各 if 判断,无单一状态机表 | orchestrator/dispatch |

## 3. 目标布局(重构后)

```text
src/
├── index.ts        # 插件入口:注册命令到注册表 + 生命周期(session_start/shutdown)
├── cli.ts          # CLI 入口:main 查注册表,统一退出码;bin/wf 不变
├── command.ts      # ★ 命令注册表(CommandDef + 双入口适配器 + 统一参数解析)
├── core/
│   ├── db.ts           # SQLite repository(不变,原样移动)
│   ├── orchestrator.ts # 流程纯逻辑(不变)
│   └── state.ts        # ★ 状态机表:合法迁移 + 状态→图标/文案单一来源
├── exec/
│   ├── dispatch.ts     # 派发流程(dispatchStep/retry 语义)
│   ├── shell.ts        # ★ run/resolveBin/resolveOnPath/piInvocation(自 dispatch 拆出)
│   ├── window.ts       # ★ parseLayout/resolveWorkflowWindow/findTerminalId/sendTextToTerminal/openStepTab
│   └── template.ts     # ★ renderTaskMd/injectDeps/getDepSummaries/parseExpectations/truncate
├── observe/
│   ├── monitor.ts      # 存活轮询 + 事件检测(原样,减 merge)
│   └── wave.ts         # ★ mergeWave/mergePreview(自 monitor 拆出)
├── ui/
│   ├── status.ts       # ★ STATUS_ICON/stepIcon/statusCountsLine/renderWorkflowStatus/workflowStatusSegment
│   ├── notify.ts       # ★ sendWorkflowNotifications/WorkflowNotifySender
│   └── board.ts        # 看板(原样)
├── plan/
│   ├── planner.ts      # headless planner(原样)
│   ├── validate.ts     # 计划校验(原样)
│   └── agents.ts       # agent 发现(原样)
└── session.ts          # 会话解析(原样)
```

## 4. 命令注册表设计(command.ts)

```ts
/** 命令上下文:适配器提供具体实现(pi: notify→ctx.ui.notify;CLI: notify→console) */
export interface CmdEnv {
	cwd: string;
	db: DatabaseSync;
	notify(message: string, type?: "info" | "warning" | "error"): void;
	/** 取绑定窗口/ghostctl 等宿主能力(CLI 与插件相同) */
}

export interface CommandDef {
	name: string;
	description: string;
	usage: string;
	/** 参数解析错误时抛 UsageError,适配器统一处理 */
	run(args: string[], env: CmdEnv): Promise<void> | void;
}

export class UsageError extends Error {}

export const registry = new Map<string, CommandDef>();
export function register(def: CommandDef): void;
export function getCommand(name: string): CommandDef | undefined;
export function listCommands(): CommandDef[];   // help/补全共用
```

- **CLI 适配器**:`main()` 查注册表,run 抛 UsageError → stderr 用法 + exitCode=3;业务错误 → console.error + exitCode=1;成功自然退出(不再裸 process.exit,输出先 flush);
- **pi 适配器**:handler 查注册表,UsageError → notify(warning);异常 → notify(error);finally 统一刷新状态条;
- **参数解析**:flagValue/positionalArgs 收敛为 command.ts 的 parseArgs(args, flagSpecs)(支持 --flag value / 位置参数),两入口共用;
- resolveWorkflowId/resolveStepId 移入 command.ts(或 core/identity.ts),两入口共用同一实现。

## 5. 执行边界(文件级,冲突最小化)

- **任务 1.1(命令注册表)**:新建 src/command.ts;改 cli.ts(main 分发、process.exit 收敛、cmd* 迁移);改 index.ts(handler 改查注册表、cmd* 迁移)——注意 1.1 与 1.2 都动 index.ts/cli.ts 的**不同区域**(1.1:命令函数区;1.2:import 区),git 行级自动合并;
- **任务 1.2(模块拆分)**:新建 src/exec/shell.ts、src/exec/window.ts、src/exec/template.ts、src/observe/wave.ts、src/ui/status.ts、src/ui/notify.ts、src/core/state.ts;改 dispatch.ts/monitor.ts/index.ts/cli.ts 的 import 与调用点;**纯移动,禁止改任何行为**;STATUS_ICON 收敛为 state.ts 单一导出(保留兼容导出名);
- 两任务都不得修改:db.ts、orchestrator.ts、board.ts、planner.ts、validate.ts、agents.ts、session.ts 的行为;不得改 DB schema;不得改命令语义与输出文案(除统一错误格式)。

## 6. 验收标准(全部必须)

1. `node --experimental-strip-types test/workflow.test.ts` 全绿(需 PATH 含 ~/.local/bin);
2. 新文件职责单一,无循环依赖(import 图无环:core←exec/observe←ui←入口);
3. cli.ts 不再有裸 `process.exit(code)` 残留(允许 `process.exitCode =` 或 main 尾部统一);
4. STATUS_ICON/stepIcon 单一来源,index.ts/cli.ts/board.ts 均引用之;
5. wf help 输出与 /wf 补全列表与现状等价(命令齐全);
6. 手动冒烟:`wf status`、`wf doctor`、`wf import`(临时 plan)可运行;
7. 1.1 与 1.2 各自独立可合(改动文件不重叠或仅 import 行重叠)。
