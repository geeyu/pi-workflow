# ux-research — rpiv-todo 对照调研与 pi-workflow 体验优化方案

> 调研对象:`@juicesharp/rpiv-todo`(14 模块全文)+ pi 扩展 API 类型
> (`pi-coding-agent/dist/core/extensions/types.d.ts` + 本地 `src/pi-types.d.ts`)。
> 产出:8 维 21 项差距清单 + P0×5 / P1×5 / P2×5 分级优化方案(每项含实现位置/风险/工作量/pi API 依赖)。
> 基线:test/workflow.test.ts 285 通过 0 失败(本步实现后全绿含新用例)。

---

## 0. rpiv-todo 模块速读(对照物)

| 模块 | 职责 | 对 workflow 的借鉴点 |
| --- | --- | --- |
| `todo.ts` | 工具/命令注册壳(registerTool + registerCommand) | 注册面与实现分层 |
| `tool/types.ts` | TypeBox 参数 schema,每条 description 即 LLM 提示文案 | schema 文案 = prompt 引导 |
| `tool/response-envelope.ts` | execute → (content, details) 封装,content 为纯文本 | 结果进对话流 + details 供渲染/重放 |
| `tool/sanitize.ts` | 终端控制字符/换行/bidi 净化 | **终端净化**(P0-1) |
| `state/store.ts` | 按 session id 分槽的 Map + commit/replace/evict | 会话隔离的存储层做法 |
| `state/state-reducer.ts` | 纯 reducer:状态迁移 + blockedBy 校验(悬空/删除/自锁/环) | 校验文案(悬空/自锁/环) |
| `state/task-graph.ts` | 依赖图环检测(detectCycle/deriveBlocks) | 环检测算法 |
| `state/selectors.ts` | 纯派生(可见/分组/计数/overlay 布局) | overlay 行预算/完成行优先算法 |
| `state/replay.ts` | 从分支 toolResult.details 重建状态(last-write-wins) | 会话重建 |
| `state/invariants.ts` | VALID_TRANSITIONS 迁移表 + isTransitionValid(同态幂等) | 迁移表幂等语义 |
| `view/format.ts` | 状态字形色表(○◐●⊘/dim-warning-success-muted)+ renderCall/renderResult | 字形/语义色表、对话流渲染钩子 |
| `todo-overlay.ts` | setWidget factory + 折叠(标题+展开提示)+ 行预算 + completedTaskIdsPendingHide | **折叠/行预算/完成行隐藏**(P0-2、P1-3) |
| `config.ts` | ~/.config/rpiv-todo/config.json(maxWidgetLines/collapseKey/guidance) | 配置文件读取 + 键盘语法校验 |
| `state/i18n-bridge.ts` | t(key,fallback) 桥,SDK 缺失降级英文 | i18n 可降级设计 |

## 0.1 pi API 能力确认(调研结论)

- ✅ `pi.registerTool` 支持 `renderCall(args, theme, ctx)` / `renderResult(result, opts, theme, ctx)` 两个对话流渲染钩子 → 工具调用在对话流里有「调用行 + 结果行」两个渲染点。
- ⚠️ `ToolRenderContext` **无 sessionId**:渲染只能绑定前台会话(creator-ownership),子会话调用渲染时安全降级为 `#<id>`(rpiv 注释明确这是有意为之)。
- ❌ `pi.registerCommand` **无渲染钩子**(command 只有 handler)→ 命令结果进对话流只能靠 `ctx.ui.notify`(消息)或 `setWidget`(面板)。
- ✅ 替代方案:自定义消息 `pi.sendMessage({customType, content, display})` + `registerMessageRenderer(customType, renderer)` 可在对话流注入结构化渲染(registerMessageRenderer 已存在于 pi API)。
- ✅ `pi.registerShortcut(keyId, {description, handler})` 存在 → 面板折叠快捷键可注册(handler 无 UI 时 no-op)。
- ✅ `setWidget(key, factory|lines, {placement})` factory 形式每帧拿 theme/width → 语义色 + 截断。
- ✅ 生命周期事件:`session_start / session_compact / session_tree / session_shutdown / tool_execution_end / agent_start`(rpiv 用 agent_start 触发「上轮完成项收起」)。

---

## 1. 八维差距清单(共 21 项)

### 维度 A:工具/命令对话流渲染反馈
| # | 差距 | rpiv 做法 | workflow 现状 |
| --- | --- | --- | --- |
| A1 | 工具级 renderCall/renderResult | todo 工具调用行 `todo + subject`、结果行 `● completed` | 无 workflow 工具(仅 /wf 命令) |
| A2 | 命令结果结构化渲染 | —(命令走 notify) | /wf 命令只 notify 纯文本,无字形/分段 |
| A3 | 自定义消息渲染器 | — | notify 聚合消息无 registerMessageRenderer 定制 |

### 维度 B:任务创建与进度引导
| # | 差距 | rpiv 做法 | workflow 现状 |
| --- | --- | --- | --- |
| B1 | promptSnippet/promptGuidelines 引导 | 工具描述 + 8 条准则直接注入模型 | 无 workflow 工具,引导靠 skill 文档 |
| B2 | 空态引导 | `/todos` 空列表 → "No todos yet. Ask the agent to add some!" | 空面板直接隐藏,无引导 |
| B3 | plan.json 模板/校验错误可读性 | TypeBox description 即提示 | validatePlan 错误已较好(本步再强化 deps 文案) |

### 维度 C:面板(overlay)折叠/配置/会话隔离
| # | 差距 | rpiv 做法 | workflow 现状 |
| --- | --- | --- | --- |
| C1 | 面板折叠 | collapseKey(默认 ctrl+shift+t),折叠 = 标题+展开提示行 | 无折叠(本步实现) |
| C2 | 行数配置 | maxWidgetLines(默认 12,读配置,floor 3) | 硬编码 PLAN_MAX_ROWS=10(本步配置化) |
| C3 | 完成行隐藏策略 | completedTaskIdsPendingHide:本 turn 显示,agent_start 后收起 | 无(本步实现) |
| C4 | 会话隔离 | store 按 sessionId 分槽;渲染绑前台会话 | repo 隔离已实现(谁发起谁看);子 tab 会话渲染待强化(本步检查) |

### 维度 D:状态机与依赖校验
| # | 差距 | rpiv 做法 | workflow 现状 |
| --- | --- | --- | --- |
| D1 | 状态迁移校验接线 | reducer 内 isTransitionValid + 明确报错 | STEP_TRANSITIONS 建表未接线(本步接线) |
| D2 | 迁移错误含合法目标 | `illegal transition ${from} → ${to}` | 部分入口有文案,无合法目标列表(本步统一) |
| D3 | blockedBy 校验文案(悬空/删除/自锁/环) | `blockedBy: #5 not found` / `cannot block #N on itself` / `would create a cycle` | deps 校验有基础文案,悬空/环可更明确(本步强化) |

### 维度 E:状态字形/语义色
| # | 差距 | rpiv 做法 | workflow 现状 |
| --- | --- | --- | --- |
| E1 | 状态字形表单一来源 | STATUS_GLYPH/STATUS_COLOR | STATUS_ICON 已单一来源(core/state.ts) |
| E2 | 语义色渲染 | theme.fg 语义色(dim/warning/success/…) | 面板已用主题语义色(factory setWidget) |

### 维度 F:数据层(store/reducer/selectors/replay)
| # | 差距 | rpiv 做法 | workflow 现状 |
| --- | --- | --- | --- |
| F1 | 纯 reducer + 状态提交分离 | applyTaskMutation 纯函数 + commitState | 直接 SQL 写,无纯 reducer 层(DB 即状态) |
| F2 | 会话级状态槽 + 分支重放 | store Map<sid> + replayFromBranch | DB 全局 + repo 隔离;子任务身份经 env/cwd 解析 |
| F3 | 派生 selectors 封装布局决策 | selectOverlayLayout(完成行优先/溢出摘要) | buildPlanLines 内联(已含完成置顶/隐藏计数) |

### 维度 G:i18n
| # | 差距 | rpiv 做法 | workflow 现状 |
| --- | --- | --- | --- |
| G1 | 文案 i18n 化 | locales/ 9 语言 + t(key,fallback) | 全中文硬编码(单用户场景可接受) |

### 维度 H:终端净化/安全
| # | 差距 | rpiv 做法 | workflow 现状 |
| --- | --- | --- | --- |
| H1 | 任务文本终端净化 | sanitizeTerminalText(CSI/OSC/控制符/换行/bidi) | task_md/report 直接渲染,子 agent 可注入转义序列 |

---

## 2. 优化项分级(P0/P1/P2)

> 标注 ✅ 表示本 step(1.2)已落地;其余为后续 wave 备案。

### P0 高价值低风险

**P0-1 终端净化**(H1)⏳ 后续
- 目标:子 agent 任务文本/report 中的 CSI/OSC/控制字符不能影响编排者终端渲染。
- 实现位置:新建 `src/ui/sanitize.ts`(移植 rpiv sanitizeTerminalText),面板渲染行(ui/status.ts planStepLine)与 notify 文案入口调用。
- 风险:低(纯字符串净化)。工作量:S。
- pi API 依赖:无。
- 本步状态:未落地(不在本步聚焦范围;与 1.1 notify 改造合并做更稳,列入后续 wave)。

**P0-2 面板折叠 + 行数配置**(C1/C2)✅
- 目标:计划概览面板支持折叠(快捷键,默认 ctrl+shift+t,`off` 禁用);折叠后仅标题 + 展开提示行;行数预算走配置文件(默认 10)。
- 实现位置:新建 `src/config.ts`(loadConfig/getMaxWidgetLines/resolveCollapseKey,读 `~/.config/pi-workflow/config.json`,XDG 优先);`src/index.ts` registerShortcut + agent_start;`src/ui/status.ts` buildPlanLines 折叠分支 + 行预算。
- 风险:低;快捷键与 pi 既有键位冲突时用户可改配/off。工作量:M。
- pi API 依赖:registerShortcut(已确认存在)。

**P0-3 notify 结构化渲染**(A3)
- 目标:聚合通知(customType workflow-notify)注册 registerMessageRenderer,对话流内结构化展示(字形 + 分段),替代纯文本 followUp。
- 实现位置:`src/index.ts`(registerMessageRenderer)+ `src/ui/notify.ts`(内容结构化为 {kind, text} 数组)。
- 风险:中(pi 渲染器 API 版本差异)。工作量:M。
- pi API 依赖:registerMessageRenderer(存在,需实测)。

**P0-4 状态机迁移校验接线**(D1/D2)✅
- 目标:STEP_TRANSITIONS 在 reportDone/reportFail/verifyStep/skip/resolve-conflict/fix-tab 等关键入口校验 canTransition;非法迁移明确报错并给合法目标列表;迁移表覆盖 orchestrator/dispatch/monitor 全部真实路径(T6/T7/T10/T13/T15 作路径清单核对)。
- 实现位置:`src/core/state.ts`(表修订 + legalTargets + 幂等)、`src/core/db.ts`(updateStepStatus strict 模式 + StepTransitionError)、`src/orchestrator.ts`/`src/command.ts`/`src/observe/monitor.ts`/`src/observe/wave.ts`(生产调用点 strict)。
- 风险:中(表遗漏真实路径会打断既有流程;已按 T6/T7/T10/T13/T15 + 源码全调用点核对:补 done→conflict、conflict→skipped,幂等同态)。工作量:M。
- pi API 依赖:无。

**P0-5 空态引导**(B2)
- 目标:面板/`/wf status` 无活动 workflow 时给出引导文案(如 `/wf plan "<目标>" --repo <路径> 创建编排`)。
- 实现位置:`src/ui/status.ts` renderWorkflowStatus 空分支、`src/command.ts` status 命令。
- 风险:低。工作量:S。
- pi API 依赖:无。

### P1 中价值

**P1-1 workflow 工具注册**(A1/B1)
- 目标:注册 `workflow` 工具(registerTool:plan/dispatch/verify/goal-check 等动作),带 renderCall/renderResult 对话流反馈与 promptSnippet 引导,替代/补充 /wf 命令。
- 实现位置:新建 `src/tool.ts` + `src/tool/types.ts`(TypeBox schema)。
- 风险:中(工具动作与命令双入口的一致性、权限模板)。工作量:L。
- pi API 依赖:registerTool renderCall/renderResult(存在)。

**P1-2 动态状态注入**(B1 延伸)
- 目标:工具 promptGuidelines/description 动态反映当前 workflow 状态(如「有 N 步待核对」),引导模型自主推进。
- 实现位置:`src/tool.ts` 注册时读 DB 拼装。
- 风险:低。工作量:S。
- pi API 依赖:registerTool 文案字段。

**P1-3 完成行隐藏策略**(C3)✅
- 目标:面板完成行本 turn 显示、下 turn(agent_start)收起(参考 completedTaskIdsPendingHide);收起后计数仍在标题,超预算行并入「+N 步未显示」。
- 实现位置:`src/ui/status.ts`(completedPendingHide/hiddenCompleted + hideCompletedFromPreviousTurn/resetCompletedDisplayState)+ `src/index.ts` agent_start 钩子。
- 风险:低。工作量:S。
- pi API 依赖:agent_start 事件(存在)。

**P1-4 命令结果注入对话流**(A2)
- 目标:/wf done/fail/verify 等命令结果以结构化消息(字形 + 摘要)注入对话流,替代裸 notify。
- 实现位置:`src/command.ts`(env.notifyPi 通道)+ `src/ui/notify.ts`。
- 风险:中(对话流噪音控制)。工作量:M。
- pi API 依赖:sendMessage(customType)+ registerMessageRenderer。

**P1-5 子侧任务展示**(C4 延伸)
- 目标:子 tab 会话正确隔离(不渲染编排者面板/状态条),子任务身份清晰(title + /wf context);✅ 本步完成隔离强化;面板在子 tab 的「只读计划速览」列为后续。
- 实现位置:`src/index.ts` session_start 分支。
- 风险:低。工作量:S。
- pi API 依赖:session_start/ctx.cwd。

### P2 低价值/远期

**P2-1 i18n 文案**(G1):t(key,fallback) 桥 + locales/,9 语言同 rpiv。位置:新建 src/i18n.ts;工作量 L。
**P2-2 会话级状态槽**(F2):store Map<sid> 化 + 分支重放(replayFromBranch 从 toolResult.details 重建)。位置:src/core/store.ts;工作量 L。
**P2-3 纯 reducer 层**(F1):状态迁移收敛为纯函数 + 单提交点。位置:src/core/reducer.ts;工作量 M。
**P2-4 面板更多配置**(C2 延伸):maxWorkflows 数、完成行收起开关(showCompletedRows)、标题格式。位置:src/config.ts;工作量 S。
**P2-5 依赖图增强**(D3 延伸):get 动作展示 blocks 反向边(参考 deriveBlocks)、面板依赖行显示被阻塞项。位置:src/ui/status.ts + src/validate.ts;工作量 S。

---

## 3. 本步(1.2)落地范围

- ✅ P0-2 面板折叠 + 行数配置(src/config.ts 新建、index.ts 快捷键、status.ts 折叠分支)
- ✅ P1-3 完成行隐藏策略(本 turn 显示 / agent_start 收起)
- ✅ P0-4 状态机迁移校验接线(表修订 + 关键入口 strict 校验 + 明确错误/合法目标)
- ✅ D3 deps 校验文案强化(悬空/自锁/循环带路径)
- ✅ P1-5 会话隔离强化检查(子 tab 会话不渲染编排者面板)
- 未做:终端净化全量移植(P0-1,与 1.1 notify 改造合并)、notify 渲染器(P0-3)、工具注册(P1-1/2)、命令结果注入(P1-4)——列入后续 wave 备案。
