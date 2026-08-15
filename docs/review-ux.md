# review-ux — 1.1/1.2 UX wave 评审记录(step 2)

> 评审对象:`gittree-wf-wf-ux-1.1`(a1cbc25)与 `gittree-wf-wf-ux-1.2`(4a861eb),基线 e02f6f0。
> 评审范围:① P0/P1 清单逐项核对;② 状态机接线一致性(两分支重叠核心);③ 逐文件合并策略;
> ④ 组合树可行性实测(362 通过 0 失败);⑤ 会话隔离/净化/渲染降级等关键行为确认。
> 结论:**两分支均通过,可合并;合并策略见 §5,已验证组合树全绿**。

---

## 1. P0/P1 清单逐项核对(依据 docs/ux-research.md)

| 项 | 归属 | 落地位置 | 核对结果 |
| --- | --- | --- | --- |
| P0-1 终端净化 | 1.1 | `src/sanitize.ts`(新建,sanitizeTerminalText/Lines)+ 四处接线 | ✅ 完整。orchestrator 落库前(importPlan/appendSteps 的 title·task·expectations·waveNote·description、reportDone 的 summary/issues/filesChanged、reportFail reason)、ui/status.ts planStepLine、command.ts 输出(status/tree/step/context/dry-run 共 17 处调用)、board.ts 看板。task_md 逐行净化(`split("\n").map(sanitizeTerminalText)`),保留多行结构 ✅ |
| P0-2 面板折叠+行数配置 | 1.2 | `src/config.ts`(新建,loadConfig/getMaxWidgetLines/resolveCollapseKey,XDG 优先)+ index.ts registerShortcut + status.ts 折叠分支 | ✅ 完整。默认 ctrl+shift+t、off 禁用、maxWidgetLines 默认 10 floor 3;键位语法校验(isValidCollapseKeySpec,防 `ctr+]` 误捕);折叠态=标题+`└─ <key> 展开` 提示行 |
| P0-3 notify 结构化渲染 | 1.1 | `src/ui/notify.ts`(NOTIFY_GLYPH/progressText/WorkflowNotifyDetails)+ `src/ui/renderers.ts`(新建)+ index.ts registerMessageRenderer | ✅ 完整。内容自带状态字形 ◐✗⚠↻✓ + 每 workflow 进度摘要 `● id done/total ✓d 🔄r ◐v ✗a`;details.items/progress 结构化;渲染器按 kind 着色 + `/wf` 命令 accent 高亮 + ANSI 感知截断(visibleWidth/truncateAnsi)。**降级已实测**:pi 运行时 custom-message.js:49-58 对返回 undefined/抛错 try/catch 落到默认 markdown 盒子渲染,内容自带字形与命令,降级可读 ✅ |
| P0-4 状态机迁移校验接线 | 1.1+1.2(两套实现,详见 §2/§3) | core/state.ts STEP_TRANSITIONS + db.ts updateStepStatus(strict)+ orchestrator/monitor/wave/command 全调用点 | ⚠️ 两分支实现不同但方向一致;合并取「1.2 strict 模式 + 并集迁移表」(详见 §4),组合树全绿 |
| P0-5 空态引导 | 1.1 | command.ts plan/import/plan-init 无参 → PLAN_TEMPLATE_HINT(plan.json 模板 + 字段说明) | ✅ 完整。CLI 退出码 3 契约不变(UsageError 带 detail 仍走 cli.ts exit 3,测试断言 code===3);pi 模式 warn 不中断 |
| P1-3 完成行收起 | 1.2 | status.ts completedPendingHide/hiddenCompleted + index.ts agent_start(hideCompletedFromPreviousTurn)+ resetCompletedDisplayState | ✅ 完整。本 turn 显示、下 turn 收起;计数保留标题;收起行计入「+N 步未显示」;重派(非终态)自动恢复显示(失效跟踪清理);togglePlanCollapsed/isPlanCollapsed 供快捷键与测试 |
| P1-5 会话隔离强化 | 1.2 | index.ts session_start 子会话(stepId 命中)只 setTitle 即 return;agent_start 与快捷键 handler 同样守卫 | ✅ 完整。子会话不再渲染面板/状态条/不启动 monitor;编排者侧 session_start 末尾补 renderWorkflowStatus(此前缺首帧渲染) |
| D3 deps 文案 | 1.2 | validate.ts:自锁/悬空/循环带实际路径(findCyclePath DFS) | ✅ 完整。`deps 自锁:不能依赖自己` / `deps 悬空:依赖不存在的步骤 9(检查 id 拼写或补充该步骤)` / `deps 存在循环依赖(环): 1 → 1.1 → 1`;保留「依赖不存在」兼容子串(任务要求) |

**未落地项(两分支均未做,符合分工,留后续 wave)**:P1-1 workflow 工具注册、P1-2 动态状态注入、P1-4 命令结果注入对话流、P2-1~P2-5。

## 2. 状态机接线:两套实现对比(评审重点)

| 维度 | 1.1(a1cbc25) | 1.2(4a861eb) |
| --- | --- | --- |
| 校验位置 | updateStepStatus **强制** canTransition(无逃逸口) | updateStepStatus **strict 可选**(opts.strict),生产调用点显式传 |
| 错误类型 | 泛型 Error(含步骤不存在检查) | StepTransitionError(子类,index.ts 命令层专门捕获展示) |
| 错误文案 | `非法状态迁移: <id> <from> → <to>(允许: a / b);如确需变更请人工处理`(斜杠分隔,不含同态自身) | `非法状态迁移: <id> <from> → <to>;允许: a, b`(逗号分隔,legalTargets 含同态自身) |
| 幂等 | 调用点级(from !== status 才校验) | 函数级 canTransition(from===to)=true(与 rpiv isTransitionValid 同构) |
| 接线面 | 强制 = 覆盖所有 updateStepStatus 调用点 | 9 处 strict 调用 + 4 处前置校验:reportDone/reportFail(前置 canTransition → strict)、verifyStep(前置状态检查 → strict ×2)、skip(前置 → strict)、resolve-conflict(strict)、fix-tab(前置)、monitor pollOnce ×2(strict)、wave mergeWave(strict) |
| 迁移表差异 | dispatched→reported/waiting-verify ✅(竞态护栏);failed/aborted/needs-fix **无** reported/waiting-verify | dispatched **无** reported/waiting-verify;failed/aborted/needs-fix→reported/waiting-verify ✅(存活重报);needs-fix 列表**漏 skipped**(注释声称有,表里没有——1.2 自身 bug) |

### 差异判定(以生产代码真实路径核对)

1. **dispatched → reported/waiting-verify(1.1 有 / 1.2 无)**:dispatchStep(dispatch.ts:276)先置 dispatched,openStepTab 成功才置 running(exec/window.ts:136)。子 agent 在 tab 内快速回报时若 monitor 尚未轮询落 running,reportDone 会撞上 dispatched。1.1 的「竞态护栏」是真实护栏 → **1.2 会误拒快速回报,并入集**。
2. **failed/aborted/needs-fix → reported/waiting-verify(1.2 有 / 1.1 无)**:monitor 连续 2 次 tab 未命中误判 aborted 后子 agent 仍存活回报(恢复路径);驳回后同 tab 重做重报(needs-fix→reported,不经重派)。均为真实流程 → **1.1 会卡死这些步骤,并入集**。
3. **needs-fix → skipped(两分支表差异)**:skip 命令文案语义是「人工终态允许任意非终态」(1.2 表头注释也这么说),1.1 表有、1.2 表漏 → **并入集**,已实测 1.2 分支单独跑会拒绝 needs-fix 步骤的 /wf skip(1.2 的 322 测试未覆盖该路径,故未暴露)。
4. **强制 vs strict**:1.1 强制校验覆盖 updateStepStatus 全部调用点,但 dispatch/retry 路径经 buildUpdate 直写状态(dispatch.ts:276)绕开 updateStepStatus——强制模式反而是「看起来全查、实际有洞」。1.2 的显式 strict 调用点接线更诚实,且 StepTransitionError 便于命令层干净展示(已在 index.ts 捕获分支)。**采用 1.2 设计**。

## 3. 两分支文件重叠与冲突实测

两分支共同触及 8 个文件:status.ts / core/state.ts / db.ts / orchestrator.ts / command.ts / index.ts / pi-types.d.ts / test/workflow.test.ts(与任务描述一致)。
实际合并(基线 e02f6f0 先合 1.1 再合 1.2):**5 个文件冲突**(core/state.ts、db.ts、orchestrator.ts、ui/status.ts、test/workflow.test.ts),3 个自动合并干净(command.ts、index.ts、pi-types.d.ts)。

## 4. 逐文件合并策略(合并执行者按此操作)

| 文件 | 策略 | 说明 |
| --- | --- | --- |
| src/sanitize.ts | 取 1.1(唯一新增) | 无冲突 |
| src/ui/renderers.ts | 取 1.1(唯一新增) | 无冲突 |
| src/config.ts | 取 1.2(唯一新增) | 无冲突 |
| docs/ux-research.md | 取 1.2(唯一新增) | 无冲突 |
| src/pi-types.d.ts | 合并两分支块 | 1.1:Component/CustomMessage/MessageRenderer/registerMessageRenderer;1.2:KeyId/registerShortcut;已自动合并无冲突 |
| src/ui/notify.ts | 取 1.1 | 1.2 未动 |
| src/board.ts | 取 1.1 | 1.2 未动 |
| src/command.ts | 自动合并即可 | 1.1:sanitize×17 + 空态模板;1.2:fix-tab/skip/resolve-conflict strict;无重叠区 |
| src/index.ts | 自动合并即可 | 1.1:registerMessageRenderer;1.2:shortcut + 会话隔离 + agent_start + StepTransitionError 捕获;无重叠区 |
| src/orchestrator.ts | 合并(1.1 净化 + 1.2 校验) | reportDone 自动合并成功(净化 clean 载荷 + canTransition 前置 + strict 各就各位);reportFail 冲突手解=两段都留(sanitize reason + canTransition 前置 + strict) |
| src/ui/status.ts | 合并(1.1 净化 + 1.2 折叠/收起) | 冲突仅在 import 行;planStepLine 的 sanitize 与 buildPlanLines 的 collapsed/hide 无重叠 |
| src/core/state.ts | 取**并集迁移表** + 1.2 的 canTransition(同态幂等)/legalTargets | 见下表;表头注释合并两分支审计说明 |
| src/db.ts | 取 1.2 设计 + 保留 1.1 的步骤存在性检查 | StepTransitionError + opts.strict;strict 分支对不存在步骤抛「步骤不存在」(1.1 防呆保留,1.1 的 T26d 断言依赖) |
| src/monitor.ts / src/observe/wave.ts | 取 1.2 | 1.1 未动 |
| src/validate.ts | 取 1.2 | 1.1 未动 |
| test/workflow.test.ts | 合并两套测试(ours=1.1 T26/T26b/T26c/T26d, theirs=1.2 T26/T27/T28/T29/T30)+ 3 处适配 | 见 §5 |

### 并集迁移表(合并后最终形态)

```
pending/ready:          基集 + reported/waiting-verify(两分支同)
dispatched:             + reported/waiting-verify(1.1 竞态护栏)
running:                不变(两分支同)
reported/waiting-verify:不变(两分支同)
done:                   + conflict(两分支同)
skipped:                终态
failed/aborted/needs-fix: + skipped(1.1)+ reported/waiting-verify(1.2)
conflict:               + skipped(两分支同)
```

## 5. 组合树实测验证(已实际执行,非纸面推演)

在 `/private/tmp/wf-merge-check`(分支 ux-merge-check,提交 04261c9)按 §4 策略完成真实合并:

- **测试:362 通过 0 失败** = 基线 285 + 1.1 新增 40(T26/T26b/T26c/T26d)+ 1.2 新增 37(T26-T30),两分支新增断言零重叠,恰为并集。
- **tsc:无新增错误**。合并树与基线/两分支同为 5 个既有错误(command.ts StepRow|null、status.ts ThemeColor、test monitorMod 命名空间 ×3——基线 e02f6f0 即存在,非本 wave 引入)。
- **测试适配 3 处**(合并测试的必要改动):
  1. T26d 三处 updateStepStatus 非法迁移断言改为传 `{strict: true}`(合并采用 strict 模式,非 strict 直写不再抛);文案断言同步为 legalTargets 逗号格式(含同态自身,如 `允许: conflict, done, failed, aborted, needs-fix, skipped`);
  2. T26d 补上 git 冲突把 assert 结尾 `);` 吞掉的语法修复;
  3. T27 mockPi 增加 `registerMessageRenderer`(合并后 index.ts 注册渲染器,1.2 的 mock 未含)。
- 合并过程中修掉 1 个真实缺陷:**并集表 failed/aborted/needs-fix 初版沿用 1.2 列表漏 `skipped`**,测试捕获(T26d needs-fix→skipped CLI 链路失败)后补入,362 全绿。

## 6. 关键行为确认(超出单测的运行时核对)

- **registerMessageRenderer**:pi 类型 types.d.ts:850/919 与 loader.js:242 存在;`MessageRenderer = (message, options, theme) => Component|undefined` 与 1.1 的 pi-types.d.ts 声明一致;custom-message.js 渲染器 try/catch + undefined 降级默认 markdown 盒子 — 1.1 的「自动降级」断言属实。
- **registerShortcut**:types.d.ts:906 签名与 1.2 声明一致(handler ctx 为 ExtensionContext,1.2 用 ctx.cwd/ctx.ui 兼容)。
- **会话隔离无回退**:子会话 session_start 提前 return(T27 断言 setTitle 有、setWidget/setStatus/notify 无);agent_start/快捷键 handler 同守卫;编排者侧 session_start 末尾补首帧面板渲染(1.2 顺带修复)。
- **面板配置现读**:getMaxWidgetLines 每次渲染现读(改配置下一帧生效);collapseKey 注册期解析(改配置需 /reload,与 rpiv 一致,提示行按渲染现读可能有短暂不一致——设计如此)。
- **状态机回归冒烟**(合并树实测):dispatch/retry 经 buildUpdate 直写不受影响;reportDone/reportFail/verifyStep/skip/resolve-conflict/fix-tab/monitor/wave 全链路合法迁移不破坏;终态与 conflict 被拒并给出合法目标列表。

## 7. 遗留问题与建议

1. **1.2 表注释与实现不一致**(failed/aborted/needs-fix 注释称可 skipped,表漏)已随并集修复,但建议后续把迁移表做成「注释生成测试」防止再漂移。
2. 强制(strict)与非强制(buildUpdate 直写)并存是设计使然,但 dispatch/retry 的状态写入仍绕开迁移表;后续 wave(P2-3 纯 reducer 层)可收敛为单提交点。
3. P1-1 workflow 工具注册(P0-3 渲染器基础设施已就绪)建议下 wave 优先。
4. 5 个既有 tsc 错误建议顺手修掉(command.ts:2370 StepRow|undefined → |null 等,一行级)。

## 8. 结论

- 1.1 与 1.2 均**通过评审**:P0×5 全部落地(1.1:净化/渲染/空态;1.2:折叠配置/完成行收起;状态机两分支共建),P1-3/P1-5/D3 落地,测试断言各自属实(325/322)。
- 两分支状态机接线**方向一致、机制不同**:强制 vs strict;迁移表差异经生产路径核对均为「互补」而非「互斥」,并集即正确口径。
- 合并策略(§4)已按此执行验证:组合树 **362 通过 0 失败、tsc 无新增错误**,可安全合入 main。
