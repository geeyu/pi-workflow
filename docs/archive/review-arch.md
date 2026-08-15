> [!NOTE] 实施状态(2026-08-15)
> 本文为架构重构(wf-arch)的施工契约/记录,**已全部实施并合并回主分支**(合并树 276 测试全绿)。
> 当前代码结构以本文为准;如后续再重构,请更新 DESIGN.md 后再改本文。

# wf-arch step2 整体评审记录(架构整理:命令注册表 + 模块拆分 + 常量收敛)

评审对象:step 1.1(commit `611124b`,worktree `gittree-wf-wf-arch-1.1`,命令注册表化)+ step 1.2(commit `31eafe6`,worktree `gittree-wf-wf-arch-1.2`,模块拆分与常量收敛)。
依据:docs/arch-refactor.md(step 1 输出,commit `09c575c`);基线 = main HEAD `8cbc769`。

## 结论:**通过(approve)**。4 条期望全部达成,两分支可合并;合并存在 **1 处预期内冲突**(core/state.ts add/add,代码一致、仅注释不同,任取一侧即可),已在模拟合并中验证可干净解决且合并后测试全绿。

---

## 期望 1:注册表双入口共用且契约一致 ✅

**双入口共用**:`src/command.ts` 单实例 `registry`(Map),31 条命令全部经 `register()` 注册(`register` 对重名抛错防覆盖);`src/cli.ts` 的 `main()` 与 `src/index.ts` 的 handler **都只查 `getCommand()` 派发**,无任何第二份命令定义。清单核对:
- 总数 31(设计 §2.5 逐条对上):CLI 可用 27(`listCommands("cli")` 实测)、pi 可用 20(12 旧 + 8 新增补齐,实测)、共享 16;
- `entry: "cli"` 的 4 条 pi 独有命令在 CLI 侧按未知命令处理(exitCode=1)、pi 侧同理,两适配器均有 `def.entry` 防线;
- **help 与补全列表等价**:`wf help` 运行输出与基线 `8cbc769` **逐字一致**(diff 验证);补全列表 = `listCommands("pi")` 20 词(设计 §2.4 验收 #5)。

**parseArgs/UsageError/退出码契约**(设计 §6.2,实测):
- `parseArgs` 按设计 §2.2 实现:boolean / value / greedy 三种 FlagSpec,未声明 `-` 前缀 token 丢弃(等价旧 positionalArgs),带值 flag 直取下一 token(等价旧 flagValue),`--note` greedy 复刻 `slice(noteIdx+1).join(" ")`;
- 退出码实测:成功 `status/tree/help` = **0**;未知命令 `bogus` = **1**;用法错误 `step`(缺参)/`poll --until bogus` = **3**;业务错误 env.fail = **1**(测试覆盖);poll 特殊码 0/1/2 与 SIGINT 130、events follow SIGINT 0 走 `setExitCode` + 自然退出,定时器在 finish/SIGINT 中 clearInterval,无滞留句柄;
- **cli.ts 无裸 process.exit 残留**:`grep -rn "process\.exit(" src/cli.ts src/command.ts` 为空;`process.exit` 全 src 仅剩 6 处 `process.exitCode =` 赋值(cli 适配器 5 + poll 1);test 内的 `process.exit(1)` 属测试框架自身,合法豁免;
- 唯一文档化行为变化(设计 §7):旧 9 条命令的用法错误退出码 1→3,已与 SKILL §5.5.1 契约统一。

**1.1 对 1.2 的衔接承诺**:index.ts 中 `WorkflowNotifySender` interface + `NOTIFY_MAX_LINES` + `sendWorkflowNotifications` 函数体与基线**字节一致**(分别 diff 验证)——这是 1.2 能干净替换的前提,成立。

## 期望 2:模块边界符合设计,迁移无遗漏 ✅

**文件集边界**(设计 §4.1,用 `git diff --stat` 核对两个 diff 集合):
- 1.1 触碰:command.ts(新)/core/state.ts(新)/ui/status.ts(新)/cli.ts/index.ts/test —— **0 行**触碰 dispatch/monitor/board/orchestrator/db/planner/validate/agents/session/pi-types;
- 1.2 触碰:core/state.ts(新)/exec/{shell,window,template}.ts(新)/observe/wave.ts(新)/ui/notify.ts(新)/dispatch.ts/monitor.ts/board.ts/index.ts —— **0 行**触碰 cli.ts/command.ts/ui/status.ts/orchestrator/db/planner/validate/agents/session/pi-types/test;**cli.ts 与 test/ 相对基线字节一致**(shim 策略生效)。

**迁移完整性**(对照 arch-refactor.md §3.1-3.7 逐条):
- 18 个被迁移函数(含私有 `parseLayout`/`resolveWorkflowWindow`/`truncate`/`resolveOnPath`)在源文件与目标文件的函数体**逐字等价**(注释/空白归一化后 diff,18/18 通过);
- 8 个被迁移 interface/const(`RunResult`/`OpenStepTabResult`/`OpenStepTabOptions`/`WF_WINDOW_META_KEY`/`DepSummary`/`MergeResult`/`WorkflowNotifySender`/`NOTIFY_MAX_LINES`)+ 私有 `TAB_ID_RE`/`WfWindowInfo`/`MAX_INJECT` 全部就位;
- §3.8「留在原地」清单全部保留:dispatch.ts 的 dispatchStep/DispatchResult/DispatchOptions/depsDone/ensureBaseSha/abortDispatch/DISPATCHABLE/isTerminalAlive、monitor.ts 的 13 个符号;
- 兼容再导出壳齐备:dispatch.ts 3 组(window/shell/template)+ monitor.ts 1 组(wave);
- 新文件职责单一:shell=进程执行+路径计算(仅 node 内置依赖)、window=终端窗口、template=任务模板、wave=合并、notify=通知、status=状态条、state=状态常量 —— 与 §3.10 import 图逐边吻合。

**无循环依赖**:对 18 个 src 文件做完整 import 图 DFS(含 `../` 相对导入):**无环**;exec/*、observe/* 不 import dispatch/monitor/index/cli/command(唯一例外 `ui/notify.ts → monitor.ts` 是设计 §3.10/§4.4 明示允许的「ui→observe」方向,非违规)。

## 期望 3:STATUS_ICON 单一来源 ✅

- 两分支各自提交后:1.1 树中 `STATUS_ICON` 仅定义于 `src/core/state.ts`(index/cli 已删本地定义,board.ts 的 `STATUS_ICON_BOARD` 为 1.2 范围、保持旧定义);1.2 树中 board.ts 已改为 `STATUS_ICON_BOARD = STATUS_ICON` 别名(cli/index 的本地副本属 1.1 删除范围,设计 §4.1 明确 1.2 不碰);
- **模拟合并后**:全 src 仅 `core/state.ts:8` 一处定义,board.ts:57 为别名,index/cli/ui/status/command 全部引用之;图标值 12 项与基线逐项相同;ui/status.ts 中 `▶/◐/✗` 字面量已改 `STATUS_ICON.running/reported/failed`(渲染值不变);
- `stepIcon` 签名按设计微调为 `status: string`(行为不变,调用点已同步)。

## 期望 4:行为零变化 + 测试全绿 ✅

- 测试:1.1 树 **270 通过 0 失败**(基线 239 + 新增 T25 注册表用例:31 条注册/查表/parseArgs 边界/UsageError 退出码);1.2 树 **239 通过 0 失败**(与基线完全一致,纯移动零漂移);
- 输出对比:基线 vs 合并树运行 `wf help` / `wf status` / `wf tree`,输出**逐字节一致**;
- tsc:两分支均无**新增**错误(基线自身带 `index.ts WorkflowRow`、`test monitorMod` 两处存量噪音,1.1/1.2 均未恶化);
- 退出码 0/1/3 在合并树上实测正常。

---

## 合并风险评估(两分支均触碰 src/index.ts 与 src/core/state.ts)

在临时克隆模拟完整合并(main `8cbc769` ← 1.1 `611124b` ← 1.2 `31eafe6`):

| 项 | 结果 |
| --- | --- |
| 合并 1.1 | **干净**,无冲突(6 文件,2902+/2747-) |
| 合并 1.2 | **1 处冲突**:`src/core/state.ts` add/add(两分支各自新建同名文件) |
| `src/index.ts` | **自动合并干净**(设计 §4.2 成立:1.1 保留 notify 块字节不变 → 1.2 的「删块+再导出」diff 三路合并直接落位;合并后无重复 STATUS_ICON/parseJsonArg 定义) |
| 其余文件 | 无交集(cli.ts/command.ts/ui/status.ts/test 仅 1.1 动,exec/observe/ui/notify/board/dispatch/monitor 仅 1.2 动) |

**冲突性质**:两版 core/state.ts **代码完全一致**,仅文件头注释不同(1.1 注释更详、1.2 注释更简)→ 冲突解决 = 任取一侧(建议保留注释更全的 1.1 版)。**注意:1.2 回报中「与 1.1 应字节一致、合并干净」的表述不准确——两文件并非字节一致(注释不同),git 会报 add/add 冲突,合并步骤需人工选择一侧**,但这是最轻的一类冲突,无任何取舍风险。

合并后全量验证:测试 **270 通过 0 失败**;`STATUS_ICON` 单一定义;`process.exit(` 全 src 为空;help/status/tree 输出与基线一致。

---

## 遗留问题(不阻塞,供后续 wave)

1. **core/state.ts 双份注释风格**:合并后建议统一文件头注释(本次按任取一侧处理,注释内容差异无功能影响)。
2. **tsc 存量噪音**:`index.ts` 的 `WorkflowRow`(应为 import type)与 test 的 `monitorMod` 命名空间两处错误在基线上就存在,本次重构未引入也未清理;建议后续 wave 顺手修掉,让 `tsc --noEmit` 恢复全绿。
3. **架构债务(设计 §9 已备案,非本次范围)**:exec/dispatch.ts、observe/monitor.ts、core/db.ts、ui/board.ts、plan/* 目录内迁;状态机迁移表接线(canTransition 替换散落 if);cli goal-check 直写库改走 orchestrator;输出文案统一消除 kind 分支;去 shim。
4. **parseArgs 未声明 flag 的静默丢弃**:`wf status --bogus` 之类的未声明 flag 不报错也不进 positionals(与旧行为等价,设计 §2.2 明示),后续如需严格模式可加未知 flag 报错选项。

## 核对依据

- 1.1 diff(`8cbc769..611124b`):src/command.ts(+2407)、src/cli.ts(1626→适配器 100 行)、src/index.ts(1343→197)、src/core/state.ts(+66)、src/ui/status.ts(+109)、test(+209);
- 1.2 diff(`8cbc769..31eafe6`):src/exec/{shell,template,window}.ts、src/observe/wave.ts、src/ui/notify.ts、src/core/state.ts(+70)、src/dispatch.ts(-571 净)、src/monitor.ts(-181 净)、src/board.ts(17 行别名化)、src/index.ts(仅 notify 块);
- 合并模拟:`/tmp/merge-sim`(main+1.1+1.2,冲突已按取 1.2 侧解决,合并树 270/0);
- 两 worktree git 状态干净,提交已落(611124b / 31eafe6)。
