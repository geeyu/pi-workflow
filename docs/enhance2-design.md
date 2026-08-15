# wf-enhance2 增强方案(wave 1 step 1 输出)

五个 wf CLI 子命令(inject / poll / session / open-tab / fix-tab)+ skill「AI 编排操作速查」章节。
目标:把编排者(AI/人)反复手动执行的终端操作固化为无头脚本友好的命令(统一退出码约定),并在 skill 给出完整组合模板。

依据代码:src/cli.ts(main switch / resolveWorkflowId / cmdTabs 等)、src/dispatch.ts(piInvocation / worktreePath / findTerminalId / resolveWorkflowWindow / buildPointer / run / resolveBin)、src/monitor.ts(fetchLiveTabIds)、src/index.ts(cmdSteer 注入序列)、src/db.ts(EVT / getStep / buildUpdate / setWorkflowMeta)、skill/SKILL.md 现有结构、ghostctl skill(命令面)。

---

## 0. 公共约定(所有新命令)

- **workflow 解析**:复用 cli.ts 现有 `resolveWorkflowId(explicit?)`(显式 id → 身份 env → cwd 仓库推断),所有带 `[workflowId]` 参数的命令行为一致。
- **步骤解析**:新增共享帮助函数 `resolveStepId(db, token): StepRow | null`(cli.ts 内部,与 index.ts 的 findStep 同规则):
  1. `getStep(db, token)` 直接命中(完整 id,如 `wf-enhance2-1.1`);
  2. 否则 `getStep(db, \`${resolveWorkflowId()}-${token}\`)`(点号 id,如 `1.1`);
  3. 都不中 → null。
- **terminal id 语义**:DB 中 `workflow_steps.tab_id` 存的就是 **terminal id**(dispatch 经 findTerminalId 反查落库,cmdTabs/monitor 同口径),不是 tab id(`tab-xxxx`)。所有 --to 目标一律用 terminal id。
- **注入序列**(inject 与 open-tab 的 pointer 回车共用,与 cmdSteer 一致):
  1. `ghostctl input <文本> --to <terminalId>`
  2. `ghostctl key enter --to <terminalId>`
- **退出码约定**(脚本可依赖):0 = 成功/达成;1 = 运行失败(目标不可解析、超时等);2 = 状态不可达(仅 poll);3 = 用法/参数错误(workflow 不存在、非法参数)。
- **输出约定**:进度/诊断信息打 stderr,结论/数据打 stdout;`--json` 输出纯 JSON 供脚本解析。

---

## ① wf inject <target> <text...> — 向指定步骤 tab/终端注入指令(自动回车)

### 参数

```
wf inject <target> <text...>
# <target>  注入目标(解析规则见下)
# <text...> 注入文本,剩余参数 join(" ")(与 /wf steer 相同,可含空格/中文)
```

### target 解析规则(按序,第一个命中即生效)

| 形式 | 示例 | 解析 |
| --- | --- | --- |
| 完整 step id | `wf-enhance2-1.1` | `getStep(db, token)` 命中 → 用 `step.tab_id` |
| 点号 step id | `1.1` | `resolveStepId` 兜底 → `getStep(db, wfId-1.1)` → 用 `step.tab_id` |
| terminal id 前缀 | `1CA675C0` | 上两式都不命中 → 视为 terminal id 前缀,直接 `ghostctl input ... --to <token>`(前缀匹配由 ghostctl 保证唯一,不唯一时报错并列出候选) |

判定顺序是**先步骤后终端**:step id 特征明显(含 `.` 或 `wf-` 前缀),terminal id 是十六进制 UUID,实际不会冲突;规则唯一且可解释。

### 行为

1. 解析 target(上述规则)。
2. 命中步骤但 `tab_id` 为空 → stderr 提示 `wf open-tab <id>` 或 `wf fix-tab <id> auto`,退出 1。
3. 未命中任何步骤 → 按 terminal 前缀直接注入(不查 DB)。
4. 注入序列:input + key enter(见 §0)。ghostctl 任一步非 0 → stderr 透出,退出 1。

### 退出码

0 = 注入成功;1 = 目标不可解析 / 步骤无 tab / ghostctl 失败;3 = 缺参数(`wf inject` 无 target 或无文本)。

### 与 /wf steer 的关系

行为完全一致(steer = 交互命令族带 notify 反馈;inject = CLI 无头版)。实现上抽共享函数 `sendTextToTerminal(ghostctlBin, terminalId, text, cwd)`(放 dispatch.ts,index.ts 的 cmdSteer 改为调用它),保证两处注入序列永远同步。

---

## ② wf poll [workflowId] [--until <status>] [--timeout <sec>] [--interval <sec>] — 轮询直到达成或超时

### 参数

```
wf poll [workflowId] [--until <status>] [--timeout <sec>] [--interval <sec>]
# --until    目标状态,默认 done
# --timeout  总超时秒数,默认 600(10 分钟);<=0 → 用法错误退出 3
# --interval 轮询间隔秒数,默认 5(与 monitor 同频);<=0 → 用法错误退出 3
```

### 轮询语义(核心定义)

- **达成集**:`{<until>} ∪ {skipped}`(skipped 是人工终态,任何目标都视为已达成)。默认 `--until done` → 达成集 = `{done, skipped}`(与 cleanup/merge 的 TERMINAL_OK 同口径)。
- **参与达成判定的步骤**:status ∈ {pending, ready} 的步骤视为「未启动」,**不参与达成判定**,但每个 tick 在进度行提示「未派发 N 步」——这样「先 dispatch 部分步骤、poll 等这批完成」与「等整个 workflow 跑完」两种场景都正确:全部步骤派发后,未派发提示自然消失,达成 = 全部步骤终态。
- **不可达提前退出**(不等超时):任一参与判定的步骤 status ∈ {failed, aborted, conflict, needs-fix} 且 ∉ 达成集 → 立即退出码 **2**,stderr 逐条列出这些步骤并附引导命令(`/wf step <id> 看原因 → /wf retry <id>`),stdout 输出当前状态摘要。until=failed 时 failed ∈ 达成集,正常达成,不触发此分支。
- **超时**:总耗时 ≥ timeout → 退出码 **1**,stdout 输出「超时」+ 当前各状态计数(未达成步骤列表)。
- **达成**:全部参与判定的步骤 ∈ 达成集 → 退出码 **0**,stdout 输出「达成」+ 步骤状态统计。
- 每个 tick 打一行进度到 **stderr**:`t=<累计秒> 状态=done 2/reported 1/… 未派发 0`,不污染 stdout。

### 退出码

0 = 达成;1 = 超时未达成;2 = 出现失败/中止/冲突/待修复(需人工介入);3 = workflow 不存在 / 参数非法(--until 未知状态也归此类,列出合法取值)。

### 实现要点

- 纯函数 `pollTargetReached(steps: StepRow[], until: string): { reached: boolean; unreachable: string[]; notStarted: number }` 放 cli.ts(或 monitor.ts 导出),可单测。
- 循环用 `setInterval` + 累计截止时间戳(不用 setTimeout 链,避免漂移);SIGINT → 打印当前摘要后退出 130。
- 每 tick 重新 `getStepsByWorkflow(db, wfId)` 全量读库(SQLite WAL 可并发读,与 monitor 同源)。

---

## ③ wf session [workflowId|--last] [-n <N>] [--json] — 打印主控 pi 会话最近文本

### 参数

```
wf session [workflowId|--last] [-n <N>] [--json]
# workflowId  按该 workflow 的 repo_path 定位会话目录(主控会话在仓库根运行)
# --last      强制按当前 cwd 定位(不解析 workflow;等价默认行为,显式化供脚本用)
# 无参数      先按 cwd 推断 workflow → repo_path;推断不出则用 cwd 本身
# -n <N>      最近 N 条消息,默认 20
# --json      输出 [{ts, role, text}] 数组(供脚本)
```

### 会话目录定位

- 目录:`~/.pi/agent/sessions/<cwd 编码>/`;编码规则(实测):去掉前导 `/`、`/` 替换为 `-`、整体包 `--` 前后缀。
  例:`/Users/geeyu/.pi/agent/extensions/workflow` → `--Users-geeyu-.pi-agent-extensions-workflow--`。
- 目录不存在或为空 → stderr 提示「无会话文件」,退出 1。
- 取该目录下 **mtime 最新**的 `*.jsonl`(排序按文件名时间戳亦可,二者一致)。

### 内容提取(按行 JSON 解析)

| jsonl type | 输出 |
| --- | --- |
| `session` / `model_change` / `thinking_level_change` | 跳过 |
| `message` | `role`(user/assistant)+ content 中所有 `{type:"text"}` 拼接;`thinking`/`toolCall` 跳过 |
| `custom_message`(如 workflow-notify) | 以 `[notify]` 前缀输出 content 文本 |

- 每行格式:`[HH:MM:SS] user: <文本>`;单条内容超 500 字符截断 + `…(截断)`。
- 默认只取最新文件;**不跨文件聚合**(多文件 = 多次会话,聚合语义含糊,保持简单)。

### 退出码

0 = 成功(即使 0 条消息也退出 0,stdout 输出 `(无消息)`);1 = 会话目录不存在/无 jsonl。

---

## ④ wf open-tab <stepId> — 手动为步骤开子任务 tab 并绑定状态

### 参数

```
wf open-tab <stepId>   # 完整 id 或点号 id(resolveStepId 规则)
```

### 用途

派发时 new-tab 失败 / tab 被误关后,步骤停留在 failed/dispatched 且无有效 tab 时,手动补开 tab 并恢复 running。

### 前置校验(任一不满足 → 退出 1,提示对应命令)

| 前置 | 不满足时提示 |
| --- | --- |
| 步骤存在(resolveStepId) | `wf step <id>` 核对 id |
| 步骤已有 worktree 且目录存在(worktreePath) | 先 `/wf dispatch <id>` 或 `/wf retry <id>`(open-tab 只补 tab 层,不重建 worktree) |
| 步骤当前无 tab_id 或 tab 已死(layout 中不存在) | 已绑定 → `wf fix-tab <id> <terminalId>` 直接修;tab 还活着 → 无需重开 |
| 绑定窗口可用(resolveWorkflowWindow) | `/wf rebind-window` 后重试 |

### 行为(与 dispatchStep §4 完全同构)

1. 复用 dispatch.ts 的 `buildPointer(workflowId, dotted, waveSeq)` 生成短指引。
2. 构造命令 `env PI_WF_WORKFLOW=<wf> PI_WF_STEP=<dotted> <piInvocation()>`(piInvocation 已是 node+pi 绝对路径,无需额外解析)。
3. `ghostctl new-tab --window-id <绑定窗口> --cwd <worktreePath> --command <cmd> --input <pointer>` → 反查 terminal id(findTerminalId)→ 等 4s → `key enter` 提交 pointer。
4. 写库:新 attempt(running,冻结当前 step.task_md);step → `running` + `tab_id`;事件 `step_tab_opened` payload `{ manual: true }`(区分自动派发)。
5. stdout 输出 `✓ <stepId> tab=<id前8位> manual`。

### 实现要点

把 dispatchStep §4 的「new-tab → 反查 → 等就绪 → 回车 → 落库」抽成共享导出函数 `openStepTab(db, workflow, step, opts): Promise<{ok, tabId?, error?}>`(dispatch.ts),dispatchStep 与 cmdOpenTab 共用,保证行为/事件永远一致。dry-run 不需要(open-tab 是人工兜底操作)。

### 退出码

0 = 成功;1 = 前置不满足 / 窗口不可用 / new-tab 失败(透出 detail,步骤状态不动,可重试);3 = 缺参数。

---

## ⑤ wf fix-tab <stepId> <terminalId|auto> — 修复步骤 tab 状态(排查用)

### 参数

```
wf fix-tab <stepId> <terminalId|auto>
# <terminalId> 显式 terminal id(完整或前缀)
# auto         按该步骤 worktree 路径/名称在 layout 中反查(findTerminalId 逻辑)
```

### 用途

DB 里 tab_id 与真实终端不一致 / 状态卡在无 tab 的 running / 人工核对后需要对齐状态。**只修 DB 状态,不验证子 pi 进程是否真的在跑**——输出必须明确提示这一点。

### 行为

1. 步骤存在(resolveStepId),否则退出 1。
2. 解析目标 terminal id:
   - `auto`:复用 `findTerminalId(ghostctlBin, repo, null, worktreePath)` 按 cwd/名称反查;查不到 → 退出 1,提示「layout 中无该 worktree 对应终端,请用 wf open-tab 重开」。
   - 显式 id:**先做存活校验**——`ghostctl layout --json` 中必须存在该 terminal(前缀匹配,复用 fetchLiveTabIds 的解析,含前缀展开);不存在/不唯一 → 拒绝写入,退出 1,提示用 `auto` 或 `wf open-tab`。
3. 写库:step → `running` + `tab_id = <解析出的完整 id>`;事件新增 `EVT.stepTabFixed = "step_tab_fixed"`(db.ts EVT 加一项),payload `{ from: 旧tab_id, to: 新tab_id, mode: auto|explicit }`;不改 attempt 历史(修复不产生新 attempt)。
4. stdout 输出对照:`修复前 <status>/<tab_id 前8位|-|> → 修复后 running/<完整 id>`,并附一行提示:「fix-tab 仅对齐 DB 状态,请人工确认该终端里子 pi 实际在运行;若终端已关闭请 wf open-tab 重开」。

### 退出码

0 = 修复成功;1 = 步骤不存在 / 目标 terminal 校验不过(不存在或不唯一);3 = 缺参数。

---

## ⑥ skill「AI 编排操作速查」章节大纲(SKILL.md)

新增章节(置于 §6 辅助脚本之前,编号顺延),面向**主控 AI 自主编排**,核心是「命令 + 退出码 + 组合模板」,不做命令手册的重复罗列:

```
## 6.5 AI 编排操作速查(无头脚本)
### 6.5.1 定位与约定
    wf CLI 全部可无头执行(不依赖交互);退出码统一:0 成功 / 1 失败 / 2 不可达(poll)/ 3 用法错
    进度走 stderr、结论走 stdout、--json 供脚本
### 6.5.2 命令速查表(每行:命令 | 参数 | 行为 | 退出码)
    wf inject <target> <text...>      # 注入指令+自动回车;target=完整id/点号id/terminal前缀
    wf poll [wf] [--until S] [--timeout T] [--interval I]  # 0达成/1超时/2不可达/3用法
    wf session [wf|--last] [-n N]     # 读主控会话最近文本
    wf open-tab <stepId>              # 手动补开子 tab(绑 worktree/窗口,恢复 running)
    wf fix-tab <stepId> <tid|auto>    # 修复 DB tab 状态(排查用,只改状态)
### 6.5.3 组合模板(完整操作组合)
    模板 A 下发并等待:
      wf dispatch 1 1.1 1.2 → wf poll --until done --timeout 1800
      # 退出码 0 → 收尾;1 → 看 stderr 未达成步骤;2 → wf step <id> 查原因 → wf retry
    模板 B 轮询中注入补充指令:
      wf inject 1.1 "补充要求:…" → 继续 wf poll(不打断轮询)
    模板 C 失败自愈循环(伪代码):
      until wf poll --until done --timeout 600; do wf step <failed> 看原因; wf retry <failed>; done
    模板 D 完整收尾链:
      wf cleanup → wf merge → wf goal-check approve
      # 中间任一步失败对照 §5 排查表(冲突→resolve-conflict 后重 merge)
### 6.5.4 常见陷阱
    tab_id 是 terminal id 不是 tab id;fix-tab 只改状态不验证进程;
    poll 不自动派发(未派发步骤不计入达成);inject 文本含空格须整体引号
```

同步更新:
- **§6 CLI 列表**:追加 5 行(inject/poll/session/open-tab/fix-tab,含参数与退出码)。
- **§5 排查表**新增行:
  - 「步骤无 tab / new-tab 失败但想补开」→ `wf open-tab <id>`
  - 「DB 里 tab 状态与终端不一致」→ `wf fix-tab <id> auto`
  - 「想让编排脚本等待步骤完成」→ `wf poll`(退出码 0/1/2)
- **§2.9 / §3 相关段落**:主控自主编排路径中引用「下发→poll→收尾」模板(一行链接到 6.5.3)。

---

## ⑦ 实现落点汇总(worker 1.1 用)

| 改动 | 文件 | 内容 |
| --- | --- | --- |
| 共享注入函数 | src/dispatch.ts | `sendTextToTerminal(ghostctlBin, terminalId, text, cwd)`(input+key enter 序列,index.ts cmdSteer 改为调用) |
| 共享开 tab | src/dispatch.ts | `openStepTab(db, workflow, step, opts)`(从 dispatchStep §4 抽取,返回 {ok, tabId?, error?}) |
| 事件 | src/db.ts | EVT 增 `stepTabFixed: "step_tab_fixed"` |
| 新命令 | src/cli.ts | `cmdInject` / `cmdPoll` / `cmdSession` / `cmdOpenTab` / `cmdFixTab` + `resolveStepId` + `pollTargetReached` 纯函数;main switch 与 help 文本同步 |
| 编排命令族 | src/index.ts | (可选,不阻塞)如 /wf 侧也要,复用同一实现;本期只做 CLI |
| 测试 | test/workflow.test.ts | `pollTargetReached`(达成集/不可达/未启动)、`resolveStepId`(完整/点号/未命中)、session 行解析(跳过 thinking/toolCall);跑 `node --experimental-strip-types test/workflow.test.ts` 全绿 |

### 安全与边界(与现有模型一致)

- inject/fix-tab 均**不越权**:注入只发文本与回车;fix-tab 拒绝写入 layout 中不存在的 terminal id(防把死 id 写死进 DB)。
- open-tab 复用绑定窗口(绝不裸开新窗口)、复用 worktreePath 守卫(只动该步骤的 worktree)。
- 所有 ghostctl 调用经 resolveBin + run()(PATH 兜底 ~/.local/bin,timeout 120s),失败不静默。
- poll 对 DB 只读;SIGINT 优雅退出并给摘要。
