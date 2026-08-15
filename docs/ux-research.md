# UX 调研报告:rpiv-todo 对照与 pi-workflow 体验优化方案

> 状态:调研完成(wf-ux step 1,wave 1)
> 范围:对照 `@juicesharp/rpiv-todo`(todo 工具 + /todos 命令 + 持久 overlay)的完整实现,
> 确认 pi 扩展 API 能力(registerTool 渲染钩子 vs registerCommand),对照本插件 `src/` 现状,
> 输出差距清单与 P0/P1/P2 分级优化方案。**本步只交付方案,不实施代码改动**(实施列后续 wave)。

---

## 1. 结论摘要

- rpiv-todo 的核心竞争力不在"功能多",而在**三层渲染反馈**:① 工具级 `renderCall`/`renderResult`
  (对话流内每一笔 todo 调用都有字形 + 语义色回显);② 持久 overlay(编辑区上方实时面板,折叠/
  行预算/完成隐藏/`+N more` 汇总);③ 命令级 `/todos`(纯文本分组总览)。三者共用同一套
  **状态字形/语义色/i18n 文案表**(`view/format.ts` + `state/i18n-bridge.ts`),渲染一致性由架构保证。
- workflow 现状:**命令 + 通知 + widget 面板**模式,已有最近几轮 UI 增强(面板已是 rpiv-todo 风格:
  树形连接线、主题语义色、执行时长、完成置顶删除线),但**缺工具注册、缺对话流渲染、缺配置化、
  缺 i18n 层、状态机迁移表未接线**。
- pi API 确认:`registerTool` 的 `renderCall`/`renderResult` 是**唯一**的对话流内自定义渲染入口;
  `registerCommand` **没有**任何渲染钩子,命令输出只能走 `ctx.ui.notify`(toast)或
  `sendMessage` + `registerMessageRenderer` 注入对话流(替代方案,已验证可用)。
- 最值得先做的 P0:① 终端控制字符 sanitize(安全);② 面板折叠热键 + 行预算配置化;
  ③ `workflow-notify` 结构化渲染;④ 状态机迁移校验接线(表已建,未强制)。

---

## 2. rpiv-todo 实现剖析(模块地图)

源码:`~/.pi/agent/npm/node_modules/@juicesharp/rpiv-todo/`(模块化分层,~1400 行 + 9 语言 locale)

| 模块 | 职责 | 关键机制(对照点) |
| --- | --- | --- |
| `todo.ts` | 工具 + 命令注册壳 | `registerTool` 完整字段:`name/label/description/promptSnippet/promptGuidelines/parameters/execute/renderCall/renderResult`;`registerTodosCommand` 走 `ctx.ui.notify` 分组输出 |
| `tool/types.ts` | 参数 schema(TypeBox) | 每个字段的 `description` 兼作 LLM prompt 文案;`StringEnum` 枚举;`details`(TaskDetails)为**持久化 + 重放快照**形状,字段名/顺序被跨版本重放 pin 死 |
| `tool/response-envelope.ts` | 结果封装 | `content`(LLM 可见文本)+ `details`(结构化快照);`formatContent` 对 `Op` 闭包 switch(编译期穷尽);"No change" 防模型空转循环 |
| `tool/sanitize.ts` | 终端文本净化 | 剥离 CSI/OSC/控制字符/双向控制符——**模型可控文本进入终端渲染器前的安全闸**(workflow 缺失!) |
| `state/state.ts` | 状态形状 | 最小化 `{tasks, nextId}`,派生全在 selectors |
| `state/store.ts` | 会话级状态 | `Map<sid, TaskState>` 按 session keyed;`sid(ctx)=ctx.sessionManager.getSessionId() ?? ""`;`getRenderState()` 解析**前台会话槽**(ctx-less 渲染指针);`commitState/replaceState/evictSession` 三个写入缝 |
| `state/state-reducer.ts` | 纯 reducer | 校验内联在 reducer:`blockedBy` 悬空 id / 已删任务拒绝;`addBlockedBy` 自锁拒绝 + 环检测;非法状态迁移拒绝;`taskChanged` 区分"无变化 update" |
| `state/task-graph.ts` | 依赖图 | `detectCycle`(DFS 三色标记,纯函数,先算后改);`deriveBlocks`(反向邻接表) |
| `state/invariants.ts` | 状态机 | `VALID_TRANSITIONS` 表 + `isTransitionValid`;completed 单向 → deleted;deleted 终态 |
| `state/selectors.ts` | 派生查询 | 可见/分组/计数/`selectOverlayLayout`(行预算:先丢 completed,再截断非完成尾 + 汇总行)/`selectShowTaskIds`(有 ⛓ 才显示 #id 前缀) |
| `state/replay.ts` | 会话重放 | 分支里**最后一个** `todo` toolResult 的 details 胜出(last-write-wins),恢复模块状态 |
| `view/format.ts` | 字形/色表 + 渲染 | `STATUS_GLYPH`(○◐●⊘)/`STATUS_COLOR`(dim/warning/success/muted)/`ACTION_GLYPH`(+→×›☰∅);`renderTodoCall`(调用行:工具名 + 字形 + 主题色)+ `renderTodoResult`(状态回显);`formatOverlayTaskLine`(字形 + #id + 删除线 + activeForm + ⛓ 依赖) |
| `todo-overlay.ts` | 持久面板 | `setWidget` factory 形式(每帧拿 theme/width);**自动隐藏**(空列表 unregister);**折叠**(快捷键,折叠态只留标题 + "└─ 按 {key} 展开");行预算 = `getMaxWidgetLines()-1`;`+N more (已完成 x, 待处理 y)` 汇总;完成项**当轮展示、下一轮隐藏**(`agent_start` 时 `hideCompletedTasksFromPreviousTurn`);`└─/├─` 连接线 + 末尾 spacer |
| `config.ts` | 配置 | `loadJsonConfigWithLegacyFallback("rpiv-todo")`;`maxWidgetLines`(默认 12,逐渲染读,无需 /reload);`collapseKey`(默认 `ctrl+shift+t`,`"off"` 禁用,KeyId 语法校验) |
| `state/i18n-bridge.ts` + `locales/` | i18n | `t(key, fallback)` 动态 import rpiv-i18n SDK(缺失时降级英文内联);状态词单一本地化点 `formatStatusLabel`;9 语言 locale 文件,渲染时取词(非烘焙) |
| `index.ts` | 生命周期装配 | 懒加载 overlay 图(prewarm 2s)+ `session_start` 重放 + 前台会话认领 + `tool_execution_end` 刷新 overlay + `agent_start` 隐藏上轮完成项 + 折叠快捷键 `registerShortcut`(register-once 契约) |

**rpiv-todo 的可复用设计模式(workflow 直接可抄)**:
1. **纯函数渲染层**:`format*` 全部 `(data, theme) → string/Text`,单测友好(workflow `buildPlanLines` 已走此路线);
2. **渲染一致性**:字形/色表/文案三张表各一个权威定义点,overlay、命令、工具渲染共用;
3. **安全闸**:所有模型可控文本过 `sanitizeTerminalText` 才进终端;
4. **配置逐渲染读取**:改配置不用 `/reload`(快捷键例外,register-once)。

---

## 3. pi 扩展 API 能力确认

来源:pi 包 `dist/core/extensions/types.d.ts`(1107+ 行,权威);本插件 `src/pi-types.d.ts` 只是其最小子集。

### 3.1 registerTool —— 有完整对话流渲染钩子 ✅

```ts
interface ToolDefinition {
  name; label; description;
  promptSnippet?: string;          // 系统提示 "Available tools" 段一行
  promptGuidelines?: string[];     // 系统提示 Guidelines 段(教 LLM 何时用/怎么用)
  parameters: TSchema;             // TypeBox
  constrainedSampling?; renderShell?: "default" | "self";  // "self" = 完全自绘外壳
  prepareArguments?; executionMode?;
  execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<TDetails>>;
  renderCall?(args, theme, context): Component;    // 对话流"调用行"
  renderResult?(result, opts, theme, context): Component;  // 对话流"结果回显"
}
```

- `ToolRenderContext`:`args/toolCallId/invalidate/lastComponent/state(每个调用槽共享渲染器状态)/cwd/executionStarted/argsComplete/isPartial/expanded/showImages/isError`。
- **关键限制(与 rpiv-todo 注释一致):`ToolRenderContext` 无 sessionId/sessionManager**——渲染钩子无法按调用者会话重新取状态,只能渲染前台会话槽;跨会话查找会错(subject 会张冠李戴),rpiv-todo 因此用 `#id` 兜底。**workflow 若注册工具,渲染钩子只能取"前台会话"的 DB 状态,或回退纯参数渲染,不能按子会话渲染**。
- 返回值 `AgentToolResult<TDetails>` = `{content, details}`——`details` 是持久化/重放快照通道(workflow 有 SQLite,不需要重放,但可用 details 传结构化摘要供 renderResult)。

### 3.2 registerCommand —— 无渲染钩子 ⚠️(替代方案明确)

```ts
interface RegisteredCommand { name; description?; getArgumentCompletions?; handler(args, ctx) }
```

- 命令输出唯一的两个出口:`ctx.ui.notify(...)`(toast,不进对话流)+ `ctx.ui.setWidget(...)`(面板)。
- **替代方案(已验证):`pi.sendMessage({customType, content, display: true})` + `pi.registerMessageRenderer(customType, renderer)`**——自定义消息可进入对话流并以自定义 Component 渲染(不参与 LLM 上下文时可 `display` 控制;参与则 `content` 进上下文)。workflow 已用 `sendMessage`(notify.ts),只是没注册 renderer。
- `registerEntryRenderer`(CustomEntry,不进 LLM 上下文)与 `registerMarkdownTransformer`(用户/助手 markdown 转换)是另外两条渲染定制路。

### 3.3 ExtensionUI / ExtensionContext 全能力(workflow 未用到的)

- UI:`select/confirm/input/editor(多行)/custom(可聚焦 overlay + OverlayHandle)/setFooter/setHeader/setTitle/pasteToEditor/onTerminalInput/setWorkingMessage/setWorkingIndicator/setHiddenThinkingLabel/addAutocompleteProvider/setEditorComponent/theme 族(getAllThemes/getTheme/setTheme)/getToolsExpanded/setToolsExpanded`。
- 上下文:`mode/hasUI/cwd/sessionManager(getSessionId/getBranch)/model/isIdle/isProjectTrusted/signal/abort/getContextUsage/compact/getSystemPrompt`。
- 事件(workflow 未用到的):`tool_call`(可 block + **原地改写参数**)、`tool_result`(可改写 content/details)、`input`(可 transform 用户输入)、`before_agent_start`(可**注入/替换 systemPrompt**)、`agent_settled`、`turn_start/end`、`message_end`(可替换消息)。
- 其余:`registerShortcut(KeyId)`(rpiv-todo 折叠键)、`exec`(扩展内跑 shell)、`getAllTools/setActiveTools`(动态启停工具集)、`getCommands`。

### 3.4 能力对照结论

| 能力 | rpiv-todo 用法 | workflow 现状 | workflow 可用性 |
| --- | --- | --- | --- |
| 工具级对话流渲染 | `renderCall`/`renderResult` | 无工具注册 | ✅ 完整支持,直接可用 |
| 命令级对话流渲染 | 无(命令走 notify) | notify | ⚠️ 无钩子;替代 = sendMessage + registerMessageRenderer |
| 持久面板 | setWidget factory | ✅ workflow-plan | ✅ 已用(factory 形式) |
| 快捷键 | registerShortcut(折叠) | ❌ 未用 | ✅ 可用 |
| 系统提示引导 | promptSnippet/promptGuidelines(静态) | ❌ 未用 | ✅ 可用;动态注入走 before_agent_start |
| i18n | rpiv-i18n 桥 + locales | ❌ 硬编码中文 | ✅ 可自建轻量桥(不依赖 rpiv-i18n) |
| 配置 | 读 JSON 配置逐渲染取 | ❌ 硬编码常量 | ✅ 自建 |

---

## 4. 差距清单(对照 8 个维度)

### 4.1 对话流反馈(工具/命令在对话流中的渲染)

| # | 差距 | rpiv-todo 参照 | workflow 现状 |
| --- | --- | --- | --- |
| G1 | **无 LLM 工具注册** | todo 工具(execute + renderCall/renderResult + promptGuidelines) | DESIGN §9.3 规划的 `workflow` 工具未实现;主 agent 只能被 `sendMessage` 文本通知,对话流里看不到工具调用回显 |
| G2 | **workflow-notify 无结构化渲染** | —(todo 无通知消息) | notify.ts 发 `customType:"workflow-notify"` 但未注册 `registerMessageRenderer`,默认 markdown 文本,无状态色/字形/可操作命令高亮 |
| G3 | **命令结果不进对话流历史** | /todos 走 notify(同局限) | `/wf status/tree/board/verify` 结果只在 toast/widget,会话重载后不可回溯(除非 sendMessage 注入) |
| G4 | 调用/结果无字形语义回显 | ACTION_GLYPH + STATUS_COLOR 回显 | 无(面板有字形,对话流无) |

### 4.2 创建任务与进度追踪引导

| # | 差距 | rpiv-todo 参照 | workflow 现状 |
| --- | --- | --- | --- |
| G5 | **无 promptGuidelines 引导** | 8 条 guidelines 教 LLM:何时建任务/状态机/blockedBy 语义/何时置 in_progress | 主 agent 无工具,自然无引导;子 agent 的 task_md 模板已含"执行前设定期望"引导(renderTaskMd) |
| G6 | 空态引导不完整 | `MSG_NO_TODOS` + `/todos` 空态 | status 空态有"(无 workflow,先用 /wf import <plan.json> 导入计划)" ✅;但 **import 的 plan.json 无示例模板引导**(用户要先自己会写 plan.json);plan 命令的 `--steps` 交互收集无 |
| G7 | 子侧任务展示无渲染 | —(todo 无子任务概念) | `/wf context` 把 task_md 原样塞 widget(workflow-task),markdown 不渲染、无状态头(期望/约束/输出契约无视觉区分) |

### 4.3 进度可见性

| # | 差距 | rpiv-todo 参照 | workflow 现状 |
| --- | --- | --- | --- |
| G8 | 面板无折叠 | overlay 折叠(collapseKey 快捷键,折叠态标题 + 展开提示) | workflow-plan 常驻展开,无折叠能力;任务多时占满编辑器上方 |
| G9 | 行预算硬编码 | `maxWidgetLines`(默认 12)配置化,`+N more` 汇总 | `PLAN_MAX_ROWS=10` 硬编码;有 `+N 步未显示(✓ 折叠)` 汇总 ✅ |
| G10 | 完成项不隐藏 | 当轮展示、下轮隐藏(`agent_start` 钩子) | 完成项删除线置顶(✅ 好),但永远占行;没有"下轮隐藏"降噪 |
| G11 | 多 workflow 面板截断 | —(单会话单列表) | `workflows.slice(0,2)` 静默截断,无提示无切换 |

### 4.4 面板配置

| # | 差距 | rpiv-todo 参照 | workflow 现状 |
| --- | --- | --- | --- |
| G12 | **无配置机制** | config.ts:`maxWidgetLines`/`collapseKey` 逐渲染读 | 无 config;行数/字形/快捷键全硬编码;改行数要改代码 |
| G13 | 无 trailing spacer | overlay 末尾空行,不与输入框贴死 | 面板底部直接贴输入框(有无 spacer 待视觉确认) |

### 4.5 状态机与依赖校验

| # | 差距 | rpiv-todo 参照 | workflow 现状 |
| --- | --- | --- | --- |
| G14 | **状态机迁移表未接线** | `isTransitionValid` 在 reducer 强制执行(非法迁移 → Error) | `STEP_TRANSITIONS` 表已建(core/state.ts)但 `updateStepStatus`(db.ts:728)不校验,任何状态可被直接写入(注释自认"只建表不接线") |
| G15 | 依赖运行时不可变 | addBlockedBy/removeBlockedBy + 自锁/悬空/已删/环 四重校验(detectCycle 先算后改) | deps 导入时固定(workflow_step_deps);导入校验已有:引用存在/无自引用/无环(validate.ts ✅);但 **appendSteps(gap wave 追加)与后续无 deps 变更能力**,不存在"悬空/循环"演化路径(因为没有运行时变更) |
| G16 | 更新无"无变化"语义 | taskChanged → "No change" 防模型空转 | 无运行时更新工具,不适用;但 verify/retry 重复调用幂等性靠 DB 状态判断,错误信息可再清晰 |

### 4.6 会话隔离

| # | 差距 | rpiv-todo 参照 | workflow 现状 |
| --- | --- | --- | --- |
| G17 | 隔离维度不同,均已实现 | 按 sessionId(Map<sid>) | 按 repo(cwd 前缀匹配,listActiveWorkflows/detectStateChanges/状态条/面板),✅ 已实现且适合"谁发起谁看" |
| G18 | 子侧身份解析报错可更友好 | — | resolveIdentity 失败时 fail 文案列出 3 种补救(传 stepId/PI_WF_*/worktree)✅;但 cwd 在子 tab 里解析失败(如未开 worktree)时提示可指向 `/wf context <stepId>` |

### 4.7 i18n

| # | 差距 | rpiv-todo 参照 | workflow 现状 |
| --- | --- | --- | --- |
| G19 | **无 i18n 层** | `t(key, fallback)` 桥 + 9 语言 locales,渲染时取词 | 全部中文硬编码(命令文案/面板/通知/错误),中英混杂(如 `(待核对)` 与 `(skipped)`);单语场景可接受,但做"面板/通知可切换语言"成本随规模上升 |

### 4.8 错误提示与安全

| # | 差距 | rpiv-todo 参照 | workflow 现状 |
| --- | --- | --- | --- |
| G20 | **终端控制字符未净化** | sanitizeTerminalText:模型可控文本进终端前剥 CSI/OSC/双向符 | task_md/标题/agent 回报文本直接进 widget(truncWidth 不防转义序列),**恶意/失控模型输出可污染终端布局**(安全相关) |
| G21 | 错误下一步引导 | —(工具错误回传 LLM 文本) | 已有部分:dispatch 失败提示 `/wf rebind-window`、poll 失败提示 `wf retry <id>` ✅;但 pi 模式下命令失败只 toast,主 agent 不知情(需 sendMessage 注入) |

---

## 5. 优化项分级(P0 / P1 / P2)

> 工作量按单人天估计;风险 = 实现/回归风险;每项标注依赖的 pi API。

### P0 — 高价值低风险(建议下一 wave 立即做)

| # | 目标 | 实现位置 | 风险 | 工作量 | pi API 依赖 |
| --- | --- | --- | --- | --- | --- |
| P0-1 | **终端净化**:所有模型可控文本(step.title/task_md/agent 回报/error)进入 widget/notify/对话流前过 sanitize | 新增 `src/sanitize.ts`(照搬 rpiv-todo tool/sanitize.ts,~25 行);接线:`ui/status.ts`(planStepLine/truncWidth 前)、`command.ts` 输出段、`orchestrator.ts`(回报落库前) | 低(纯函数 + 调用点替换;注意 widget 是唯一未净化路径) | 0.5d | 无(纯字符串) |
| P0-2 | **面板折叠 + 行预算配置化**:`wf.config.json`(或复用 rpiv-config 风格)支持 `maxWidgetLines`(默认 10)/`collapseKey`(默认 `ctrl+shift+t`,`"off"` 禁用);快捷键折叠到标题行 + `└─ 按 {key} 展开` | 新增 `src/config.ts`(仿 rpiv-todo config.ts:逐渲染读 maxWidgetLines,register-once 读 collapseKey);`src/index.ts`(registerShortcut);`src/ui/status.ts`(折叠分支 + 行预算替换 PLAN_MAX_ROWS) | 中低(registerShortcut 一次绑定、KeyId 语法校验照抄;折叠态渲染是纯新增分支) | 1d | `registerShortcut` ✅、`setWidget` ✅ |
| P0-3 | **workflow-notify 结构化渲染**:注册 `registerMessageRenderer("workflow-notify")`,通知在对话流中以组件渲染(状态色行 + 可操作命令高亮),并顺带把面板字形/色表复用到对话流 | `src/index.ts`(注册 renderer)+ `src/ui/notify.ts`(消息结构:带 status/glyph 的列表)+ 新 `src/ui/renderers.ts`(renderer 实现,复用 core/state.ts STATUS_ICON) | 低(纯新增渲染路径;不改变 sendMessage 内容格式则零回归) | 0.5–1d | `registerMessageRenderer` ✅(无消息渲染器时降级 markdown,天然向后兼容) |
| P0-4 | **状态机迁移校验接线**:`updateStepStatus` 强制 `canTransition(from, to)`,非法迁移抛 UsageError/notify error;核对 STEP_TRANSITIONS 表与 orchestrator/dispatch/monitor 全部实际迁移路径一致 | `src/db.ts:updateStepStatus`(接线)+ `src/core/state.ts`(补表缺项,如 conflict→running 重派、needs-fix→dispatched 已列) | 中(风险集中在"表不完整导致合法路径被误拒"——先用现有测试 + 真仓库演练跑一遍全部路径,再接线;测试覆盖 T6/T6b/T7/T10/T13/T15 全路径) | 1d | 无 |
| P0-5 | **空态引导补全**:`/wf plan`/`import` 无参时打印 plan.json 示例模板(含 deps/expectations/waveNote 字段说明);status 空态文案保留 | `src/command.ts`(import/plan 命令的空参分支) | 极低 | 0.25d | 无 |

### P1 — 中价值(1–2d 每项)

| # | 目标 | 实现位置 | 风险 | 工作量 | pi API 依赖 |
| --- | --- | --- | --- | --- | --- |
| P1-1 | **注册 `workflow` 工具**(DESIGN §9.3 落地):主 agent 可直接调用 `wf_plan/dispatch/verify/merge/goal_check` 等;TypeBox schema 与现有 32 命令参数对齐;`renderCall` 前缀字形(`+`/`→`/`✓`/`✗`)+ `renderResult` 状态回显(仿 rpiv-todo view/format.ts);`promptSnippet/promptGuidelines` 引导主 agent 何时 plan/dispatch/verify | 新 `src/tool.ts`(定义 + 渲染,复用 orchestrator.ts 纯函数);`src/index.ts`(registerTool);`src/pi-types.d.ts`(补 registerTool/ToolDefinition 类型);**约束:renderCall/renderResult 无 sessionId,只能渲染前台会话的 DB 状态(前台=编排者,恰好正确);子 pi 会话里调用则回退纯参数渲染** | 中(LLM 参数 schema 与 CLI 解析双入口一致性;工具并发/重入;测试需 mock ExtensionContext) | 2–3d | `registerTool` ✅(renderCall/renderResult 完整支持) |
| P1-2 | **动态状态注入系统提示**:`before_agent_start` 把"当前 workflow 待办摘要"(待 verify / 异常 / 可派发就绪集)拼进主 agent 系统提示,减少盲发通知、引导自主编排 | `src/index.ts`(on before_agent_start)+ `src/ui/status.ts`(复用 statusCountsLine 摘要) | 低(只读 DB + 拼字符串;注意 systemPrompt 注入是字符串替换/追加,要与 pi 原生提示兼容) | 0.5d | `before_agent_start` 事件 + 返回 `{systemPrompt}` ✅ |
| P1-3 | **完成项下轮隐藏**:面板中"上一轮已完成"的步骤下一轮自动隐藏(可折叠计数展示 `+N 已完成`),当轮新完成仍短暂展示 | `src/ui/status.ts`(面板状态类,记录 lastNextId + completed 集合,仿 todo-overlay.ts getSnapshot/hideCompletedTasksFromPreviousTurn);`src/index.ts`(agent_start 钩子) | 中低(面板从纯函数变有状态,需保持 buildPlanLines 纯函数可测,状态外置) | 1d | `agent_start` ✅ |
| P1-4 | **命令结果注入对话流**:pi 模式下重要命令(verify/merge/goal-check/dispatch 失败)的结果经 sendMessage 注入主 agent 上下文(配合 P0-3 renderer),错误带可操作命令 | `src/index.ts` 命令适配器(env.info/fail 旁路:widget 命令仍走 widget,关键事件另发一条)+ `src/ui/notify.ts` | 中低(避免刷屏:只对 verify 结果/失败/异常事件注入;通知去重沿用 markNotified) | 1d | `sendMessage` ✅(display:true 时 renderer 接管渲染) |
| P1-5 | **子侧任务展示增强**:`/wf context` 渲染任务 markdown 时加状态头(期望/约束/输出契约分区视觉化);空态提示指向 `/wf context <stepId>` | `src/command.ts`(context 命令输出段)+ `src/ui/`(taskMd 分段渲染,轻量——不引 markdown 库,按 `## ` 头分节着色) | 低 | 1d | 无(setWidget 字符串面板) |

### P2 — 低价值/高成本(按需)

| # | 目标 | 实现位置 | 风险 | 工作量 | pi API 依赖 |
| --- | --- | --- | --- | --- | --- |
| P2-1 | **i18n 层**:`t(key, fallback)` 桥 + zh/en 两份 locale(状态词/面板/通知/错误),对齐 rpiv-i18n 模式但零外部依赖 | 新 `src/i18n.ts` + `src/locales/*.json`;全局替换硬编码文案 | 低(机械替换,但回归面大——所有文案测试断言要同步) | 2–3d | 无 |
| P2-2 | **多 workflow 面板切换**:>2 个时折叠 + `+N 更多` 提示,或快捷键轮换 | `src/ui/status.ts`(面板布局逻辑)+ config(panelMaxWorkflows) | 低 | 1d | 无 |
| P2-3 | **工具渲染外壳定制**:`renderShell:"self"` 全自绘工具调用外壳(进度/折叠/展开控件) | `src/tool.ts` | 中(与 pi 外壳渲染器耦合,升级风险) | 1–2d | `renderShell:"self"` ✅ |
| P2-4 | **面板间距/细节**:trailing spacer、`+N more` 汇总行格式与 rpiv-todo 对齐(已完成 x / 待处理 y) | `src/ui/status.ts` | 极低 | 0.25d | 无 |
| P2-5 | **/wf 命令历史回溯**:命令结果以 CustomEntry(`appendEntry`)落盘,可 /wf history 查看 | `src/index.ts` + `src/command.ts` | 低 | 1d | `appendEntry`/`registerEntryRenderer` ✅ |

---

## 6. pi API 依赖结论(需要明确告知的)

1. **registerTool 渲染钩子 = 唯一对话流内自定义渲染入口**,能力完整(renderCall/renderResult/参数/guidelines/renderShell),workflow 用工具化路线没有 API 阻碍;
2. **registerCommand 无渲染钩子**——命令结果要进对话流,必须走 `sendMessage` + `registerMessageRenderer`(P0-3/P1-4 已按此设计);这条替代路径 rpiv-todo 没用过(它也不需要),但 pi 类型声明确认 `registerMessageRenderer(customType, renderer)` 存在且 `display:true` 的 custom message 会走 renderer;
3. **渲染钩子拿不到 sessionId**(ToolRenderContext 无 sessionManager)——工具渲染只能绑定前台会话状态;对 workflow 恰好成立(编排者是前台),子 pi 场景需回退参数渲染(P1-1 已标注);
4. `before_agent_start` 返回 `{systemPrompt}` 可做动态状态注入(P1-2);`tool_call` 可 block/改写参数(未来做"禁止子 agent 调 /wf verify"类护栏可用,本期不涉及);
5. 若未来引入 rpiv-i18n 依赖,`t(key, fallback)` 桥与 9 语言 locale 可整体复用;不引入则自建轻量桥(P2-1)。

---

## 7. 落地建议(优先级路线)

```text
wave A(P0,~3d):  sanitize 净化 → 面板折叠+配置 → notify 结构化渲染 → 状态机接线 → 空态引导
wave B(P1,~5d):  workflow 工具注册(renderCall/result) → before_agent_start 状态注入
                 → 命令结果注入对话流 → 完成项隐藏 → 子侧任务展示增强
wave C(P2,按需): i18n 层 / 多 workflow 切换 / 外壳定制 / 历史回溯
```

每项完成后:`/reload` 热加载验证 + `node --experimental-strip-types test/workflow.test.ts`(当前基线 285 通过 0 失败)+ 真仓库小演练。

---

## 8. 附录:rpiv-todo 文件 → workflow 参照映射

| rpiv-todo | workflow 现状 | 差距 |
| --- | --- | --- |
| todo.ts(工具注册壳) | index.ts(/wf 命令注册) | 无工具;无 renderCall/renderResult |
| tool/types.ts | validate.ts(plan schema) | 无 TypeBox 参数 schema(命令用 parseArgs) |
| tool/response-envelope.ts | orchestrator.ts(回报/verify) | 无 content+details 双通道封装 |
| tool/sanitize.ts | —(缺失) | **P0-1** |
| state/store.ts | db.ts(SQLite 即持久) | 架构不同(DB 更稳),无需照搬 |
| state/state-reducer.ts | db.ts updateStepStatus + validate.ts | 校验分散,迁移表未接线(**P0-4**) |
| state/task-graph.ts | validate.ts(环检测) | 导入时已覆盖 ✅;无运行时变更 |
| state/selectors.ts | ui/status.ts(buildPlanLines 内联) | 布局决策内联在渲染函数,可抽 selectors 便于单测(P1-3 顺带) |
| view/format.ts | ui/status.ts(PLAN_ICON/planStepLine) | 字形表已对齐 ✅;缺对话流渲染层(P1-1) |
| todo-overlay.ts | ui/status.ts(workflow-plan widget) | 缺折叠/配置/完成隐藏(**P0-2/P1-3**) |
| config.ts | —(缺失) | **P0-2** |
| i18n-bridge + locales | —(缺失) | **P2-1** |
| index.ts(生命周期) | index.ts(monitor/状态条) | 缺 registerShortcut/registerMessageRenderer/before_agent_start(**P0-2/P0-3/P1-2**) |
