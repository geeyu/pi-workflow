> [!NOTE] 历史归档(2026-08-15)
> 本文是早期 workflow(wf-enhance / wf-enhance2)施工过程的产物,描述的能力**已全部实现并可能已演进**。
> 权威文档:DESIGN.md(设计)、skill/SKILL.md(使用手册)。如与现状冲突,以 DESIGN.md / SKILL.md / 代码为准。

# wf-enhance2 step2 整体评审记录

评审对象:step 1.1(commit 895501c,worktree gittree-wf-wf-enhance2-1.1)+ step 1.2(commit d413717,worktree gittree-wf-wf-enhance2-1.2),依据 docs/enhance2-design.md(step 1 输出,commit 108210e)。

## 结论:通过(期望逐条核对)

### 期望 1:命令行为与方案一致且安全 ✅

| 命令 | 与方案核对 | 安全 |
| --- | --- | --- |
| inject | target 三级解析(完整 id→点号 id→terminal 前缀,先步骤后终端)与方案 §① 一致;注入序列 input+key enter 经共享 `sendTextToTerminal`(dispatch.ts),index.ts cmdSteer 已改为调用同一函数,两处永不漂移;命中步骤无 tab → stderr 提示 open-tab/fix-tab 退出 1;退出码 0/1/3 与方案一致 | 只发文本与回车,无越权;step id(含 `.` 或 `wf-` 前缀)与十六进制 terminal id 无碰撞面,解析顺序确定性;未命中步骤且非合法 terminal 时 ghostctl 失败退出 1,不静默 |
| poll | 达成集={until}∪{skipped};pending/ready 计 notStarted 不参与达成,每 tick stderr 提示未派发数;failed/aborted/conflict/needs-fix 提前退出 2 并逐条引导 `wf step → wf retry`;超时退出 1;workflow 不存在/--until 非法/timeout≤0 退出 3;`pollTargetReached` 纯函数放 monitor.ts 可单测;SIGINT 摘要退出 130 | 对 DB 只读;setInterval+截止时间戳无漂移 |
| session | cwd 编码 `--Users-...--` 与实测一致;取 mtime 最新 jsonl;跳 session/model_change/thinking_level_change;message 只拼 text 部分(跳 thinking/toolCall);custom_message → `[notify]` 前缀;500 字符截断;无会话退出 1、0 条消息退出 0、workflow 不存在退出 3 | 只读会话文件,不写任何东西 |
| open-tab | 前置校验齐全(步骤存在/worktree 存在/无存活 tab/绑定窗口可用);`openStepTab` 从 dispatchStep §4 抽取共享(dispatch 与 open-tab 共用),绑定窗口定位绝不裸开;新 attempt + step→running + 事件 step_tab_opened{manual:true};失败 abort attempt、步骤状态不动;退出码 0/1/3 | worktreePath 守卫只动本步骤 worktree;layout 查询失败时保守重开并明确警告 |
| fix-tab | 只改 DB 状态;显式 id 必须过 layout 存活校验(前缀匹配+唯一性,拒绝写入死 id);auto 复用 findTerminalId(与派发同口径);事件 step_tab_fixed{from,to,mode};不改 attempt;stdout 输出修复前后对照 + 「不验证进程」提示;退出码 0/1/3 | 显式 id 存活校验防把死 id 写进 DB;auto 查不到拒绝并引导 open-tab |

### 期望 2:速查章节完整 ✅

skill/SKILL.md §5.5「AI 编排操作速查(无头脚本)」:
- 5.5.1 定位与约定:统一退出码 0/1/2/3、stdout/stderr 与 --json 约定、inject target 三级解析;
- 5.5.2 高频操作一览表:inject/poll/session/open-tab/fix-tab + cleanup/tabs/status/tree/events 共 10 命令;
- 5.5.3 组合模板 A-E:下发并等待 / 完整编排链(dispatch→inject 引导→poll→verify→cleanup+merge→goal-check)/ 轮询中注入 / 失败自愈循环 / 故障快捷修复序列(tabs→fix-tab→open-tab→cleanup);
- 5.5.4 常见陷阱:tab_id 是 terminal id、fix-tab 不验证进程、poll 不自动派发、inject 引号与中文、退出码 2 语义。

同步齐全:§2.9 加无头编排路径行;§5.2 排查表 +3 行(open-tab/fix-tab/poll)并扩展 steer 行指向 wf inject,表后交叉引用;§6 CLI 列表 +5 条命令。完整流程覆盖(下发→引导→轮询→核对→合并→把关→修复)。

### 期望 3:测试全绿 ✅

`node --experimental-strip-types test/workflow.test.ts`(1.1 worktree):**225 通过,0 失败**。
- T21 pollTargetReached 纯函数(达成集/未派发/不可达/until=failed)+ 子进程真实退出码 0/1/2/3;
- T22 session 编码/最新文件/行解析(跳 thinking/toolCall、notify)+ CLI 0/1/3;
- T23 inject 三种 target(完整 id/点号 id/terminal 前缀)+ 无 tab 退出 1 + 缺参 3 + ghostctl 失败 1;
- T24 openStepTab 共享序列(new-tab→反查→落库、manual 事件、绑定窗口)+ open-tab 前置校验各分支 + fix-tab explicit/auto/非法前缀/缺参。

注意:首次无 `~/.local/bin` 的 PATH 运行会因 gittree 找不到导致 T12 假失败,需 `export PATH="$HOME/.local/bin:$PATH"`。

## 次要问题(不阻塞,供后续优化)

1. **事件 attempt 关联丢失(轻微回归)**:抽取 `openStepTab` 后,`step_tab_opened` 事件不再带 `attemptId`(旧 dispatchStep 代码有 `attemptId: attempt.id`)。当前无消费者依赖该字段(monitor 按 step.tab_id 判断,不查事件),但审计流里自动派发的 tab 事件与 attempt 断链。建议 `openStepTab` 增加 `attemptId` 透传到事件。
2. **fix-tab 会把非 running 终态拉回 running**:fix-tab 无条件写 status=running,若对 done/skipped 步骤误用会回退状态。与方案 §⑤「step → running + tab_id」一致,且工具定位为排查用、输出带人工确认提示,属设计内行为,但可考虑加「步骤已是终态时拒绝」保护。
3. **inject 点号 id 在非 workflow 上下文会落入 terminal 分支**:`wf inject 1.1 x` 在无法推断 workflow 的目录运行 → resolveStepId 未命中 → 按 terminal 前缀处理 → ghostctl 报错退出 1,错误文案对用户略困惑(非目标不可解析的明确提示)。属方案「先步骤后终端」的既定兜底,仅提示可优化。
4. **skill 章节编号为 §5.5 而非方案大纲的 §6.5**:实际放置位置在 §5 排查手册与 §6 辅助脚本之间、语义归属「操作速查」合理,文档内部交叉引用全部自洽,无功能影响。

## 核对依据

- 1.1 实现 diff:src/cli.ts(+451,cmdInject/cmdPoll/cmdSession/cmdOpenTab/cmdFixTab/resolveStepId)、src/dispatch.ts(sendTextToTerminal/openStepTab/findTerminalId 导出)、src/monitor.ts(pollTargetReached)、src/session.ts(新文件)、src/db.ts(EVT.stepTabFixed)、src/index.ts(steer 改共享注入)、test/workflow.test.ts(+497)。
- 1.2 实现 diff:skill/SKILL.md(+95:§5.5 全章 + §5.2 三行 + §6 五条 + §2.9 一行)。
- 两个 worktree git status 干净,提交已落(895501c / d413717)。
