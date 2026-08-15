---
name: workflow
description: pi workflow 编排插件(pi-workflow)的使用与排查手册。当用户提到 workflow、子任务派发、worktree 并行开发、/wf 命令、任务看板、任务卡住/失败排查、wf 辅助脚本时触发。提供创建计划、执行编排、子任务回报、期望核对、问题诊断的完整指引。
---

# pi-workflow 插件手册

主 pi 为调度者,把大计划拆成并行/串行批次;每个子任务 = 一个 gittree worktree + 一个 Ghostty tab(子 pi,可见可干预);全生命周期事件落 SQLite(唯一事实源)。

- 设计文档:`~/.pi/agent/extensions/workflow/DESIGN.md`
- 数据库:`~/.pi/agent/workflows/workflow.db`(WAL,可并发读)
- 辅助脚本:`~/.pi/agent/extensions/workflow/bin/wf`(或直接 `wf` 命令,见 §6)
- 子任务身份:环境变量 `PI_WF_WORKFLOW` / `PI_WF_STEP`,兜底解析 cwd 的 worktree 路径

## 1. 创建 workflow(编排者侧)

### 1.0 一句话自动拆解(推荐)

```
/wf plan "<需求目标>" [--repo <path>] [--workflow <id>] [--dry-run]
```

planner agent(headless 子进程)读取仓库上下文后自动拆解成层级计划(JSON 契约)。
- 无 `--workflow`:新建 workflow;有 `--workflow <id>`:给当前 wave 追加步骤(gap wave);
- `--dry-run`:只看拆解结果不落库。

### 1.1 用模板初始化 plan.json

```bash
wf plan-init add-redis-cache "给 session store 加 Redis 缓存" --repo /path/to/repo --steps 4
```

生成 `plan.json` 骨架,编辑 steps(层级点号 id:1、1.1、1.2.3;deps 引用完整点号;gate 标硬性核对)。

### 1.2 导入(校验 + 事务落库)

```
/wf import plan.json
```

校验规则:workflow id kebab-case;step id 点号层级且唯一;agent 必须存在于 `~/.pi/agent/agents/*.md`(内置 planner/worker/reviewer);deps 存在且无环;数量 ≤ max_steps。

### 1.3 plan.json 格式

```json
{
  "name": "add-redis-cache",
  "title": "加 Redis 缓存",
  "goal": "给 session store 加 Redis 缓存,登录/登出全量覆盖",
  "repoPath": "/path/to/repo",
  "steps": [
    { "id": "1", "title": "输出方案", "agent": "planner", "task": "分析模块,输出方案" },
    { "id": "1.1", "title": "实现 A", "agent": "worker", "deps": ["1"],
      "task": "按 {{steps.1.summary}} 实现", "expectations": ["缓存写入生效"] },
    { "id": "2", "title": "整体评审", "agent": "reviewer", "deps": ["1.1", "1.2"], "gate": true }
  ]
}
```

`task` 支持模板注入:`{{steps.<dotted>.summary}}` / `{{steps.<dotted>.files}}` / `{{steps.<dotted>.status}}` / `{{root}}`。

## 2. 派发 workflow(完整操作流程)

### 2.1 前置:计划就绪

```
/wf plan "<目标>" [--repo <path>]            # 推荐:一句话自动拆解(§1.0)
/wf plan-init <name> "<目标>" --steps N     # 或模板手编 plan.json(§1.1)
/wf import plan.json                        # 校验 + 落库
```

校验通过提示「已导入 N 个步骤(wave M)」;校验失败对照 §1.2 规则排查。

### 2.2 首次派发(顶层步骤)

```
/wf dispatch 1 [--workflow <id>]
```

预期行为:冻结 base_sha → `gittree create wf-<wf>-<dotted>` → 渲染 task_md 写库 → 绑定窗口新 tab 开子 pi(按窗口 id 定位,不受焦点/窗口开合影响)→ pointer 注入并自动回车提交。
验证:`/wf status` 出现 running + tab;失败对照 §5(如「绑定窗口已关闭」→ `/wf rebind-window` 后 `/wf retry <id>`)。`--dry-run` 预览不落库不开窗。

### 2.3 依赖推进(并行)

```
/wf dispatch 1.1 1.2 --workflow <id>      # 依赖 done 后,同 wave 并行派发
/wf dispatch 2 --workflow <id>            # 1.1/1.2 全部完成后,发起 2
```

依赖未完成会被拒绝(提示「依赖未完成,先完成:…」),按依赖顺序推进即可。
状态机:pending → ready → dispatched → running → reported → done;gate 步骤 reported → waiting-verify → done;失败 → failed/needs-fix 可重派。

### 2.4 子任务回报(子 pi 侧)

```
/wf context                       # 读任务详情(目标/任务/期望/输出契约)
/wf done 1.1 '{"summary":"...","filesChanged":["a.ts"],"issues":[],"tests":"passed"}'
/wf fail 1.1 <原因>
```

完成后**必须在 worktree 内 git commit**(合并前强制);输出契约 JSON:`summary`(必填)/ `filesChanged` / `issues` / `tests`(passed|failed|none)。

### 2.5 核对(gate 步骤)

主控收到 monitor 自动通知(§2.9)或 `/wf status` 发现 `waiting-verify` 后:

```
/wf verify <id> approve|reject <原因>      # 期望 vs 回报对照
```

approve → done;reject → needs-fix → `/wf retry <id>` 回炉(重派上下文自动注入上次失败原因)。

### 2.6 合并 wave

前置:先 `wf cleanup`(关终态 tab + 清 .pi-glla + 修 .gitignore)+ `wf tabs` 确认(命令见 §6),再:

```
/wf merge [--wave N]                  # wave 全部终态后串行 gittree merge --delete
```

冲突 → 步骤 conflict(worktree 保留现场)→ `wf step <id>` 看现场,人工解决 → `/wf resolve-conflict <id>` → 重新 `/wf merge`。

### 2.7 目标把关与下一 wave

```
/wf goal-check [approve|reject <原因>]   # 全部合并后:approve=completed / reject=回 running 拆 gap wave
/wf next [--note <说明>]                 # 滚动到下一 wave
/wf plan "<目标>" --workflow <id>        # 追加 gap wave 步骤 → 回到 §2.2
```

### 2.8 端到端示例(4 步:1 planner → 1.1/1.2 并行 workers → 2 reviewer gate)

```
$ /wf plan "给 session store 加 Redis 缓存"
✓ 已导入 4 个步骤(wave 1)
$ /wf dispatch 1
✓ wf-add-redis-cache-1 dispatched(tab=…)
$ /wf dispatch 1.1 1.2            # 1 done 后并行
✓ 依赖完成,已派发 1.1 / 1.2
$ /wf verify 2 approve           # 1.1/1.2 回报后核对 gate
✓ 2 → done
$ wf cleanup --dry-run            # 合并前置检查(§6)
[dry-run] 关闭 tab 1 | 清理 .pi-glla 2 | .gitignore 追加(否) | 警告 0
$ wf merge
✓ wave 1 merged
$ /wf goal-check approve
✓ wf-add-redis-cache completed
```

### 2.9 主控自主编排(monitor 自动通知)

monitor 每 5s 检测关键状态(步骤回报/gate 待核对/失败/中止/冲突/待修复/wave 完成/全流程完成),经 `pi.sendMessage`(followUp 不打断当前工作)推给主控,主控空闲时自动执行对应 `/wf verify|retry|merge|goal-check`,实现自主推进。

去重:每种事件每步骤每 attempt 只通知一次(重试后 attempt 变化会重新通知,不丢提醒);手动 `/wf status` 不受影响。

无头脚本/定时编排路径:`wf dispatch → wf poll --until done → wf verify → wf cleanup && wf merge → wf goal-check`,组合模板与退出码约定见 §5.5.3 / §5.5.1。

## 3. 子任务侧(子 pi tab 内)

```
/wf context                       # 从 DB 读任务详情(目标/任务/期望/输出契约)
/wf done 1.1 '{"summary":"...","filesChanged":["a.ts"],"issues":[],"tests":"passed"}'
/wf fail 1.1 <原因>
```

- 完成后**必须在 worktree 内 git commit**(合并前强制)
- 输出契约 JSON:`summary`(必填)/ `filesChanged` / `issues` / `tests`(passed|failed|none)

## 3.5 目标把关与 wave 滚动

```
/wf goal-check [approve|reject <原因>]   # 进入 verifying 展示核对依据 → approve=completed / reject=回 running 拆 gap wave
/wf next [--note <说明>]                 # 滚动到下一 wave(先 /wf next 再 /wf plan --workflow <id> 补步骤)
/wf resume                               # 预算超限暂停后恢复
```

## 4. 核对与状态

```
/wf verify <id> [approve|reject <原因>]   # gate 前后对照:期望 vs 回报
/wf status [--all]                        # 全景:进度/运行中/成本/最近事件
/wf tree [workflowId]                     # 层级任务树
/wf step <id>                             # 单步详情(attempts 历史/错误/任务正文)
/wf events [workflowId] [N]               # 审计流(只增不改,全生命周期)
/wf retry <id> [--fresh]                  # 重派(默认复用 worktree,--fresh 重建)
/wf rebind-window [wfId]                  # 重新绑定窗口(绑定窗口已关闭时,把当前焦点窗口设为绑定窗口)
/wf skip <id> <原因>                      # 人工终态
wf clean                                 # 清理残留 worktree(CLI,§6;残留 tab 用 wf cleanup)
```

## 4.5 看板

```
/wf board [workflowId] [--wave N]            # 终端 5 列看板(待办/进行中/待核对/完成/异常)
/wf board <wf> --html out.html               # 导出单文件 HTML(浏览器打开/分享)
wf board [workflowId] [--wave N] [--html out.html]
```

## 5. 排查手册(重要)

### 5.1 先跑环境自检

```bash
wf doctor        # 环境体检:node/gittree/ghostctl/python3/DB
wf debug         # 诊断信息:库版本/表规模/运行中任务/事件数/绑定窗口
```

### 5.2 常见问题对照

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `gittree create 失败: invalid reference: HEAD` | 仓库无提交(空 HEAD) | 仓库先做初始提交 |
| `gittree: command not found` | 非交互 shell PATH 缺 `~/.local/bin` | 已内置兜底绝对路径;手动则 `export PATH="$HOME/.local/bin:$PATH"` |
| ghostctl 报 `TypeError: ... | 'type' and 'NoneType'` | python3 < 3.10(系统 3.9 不支持 `str \| None`) | PATH 优先 brew python3;`wf doctor` 可查 |
| 子 tab 中文乱码 | AppleScript input text 编码 | pointer 已改纯 ASCII;任务详情(中文)走 `/wf context` |
| 子任务 tab 开错窗口 | 依赖焦点窗口 | 已改为 workflow 绑定窗口(首次派发锁定焦点窗口 id 存 `workflow_metadata.ghostty_window_id`,之后按 id 定位);查看:`wf debug` |
| 派发报错「绑定窗口 … 已关闭」 | 绑定窗口被关闭,按 id 定位失败(绝不回退焦点窗口) | `/wf rebind-window`(把当前焦点窗口设为绑定窗口)后 `/wf retry <id>`;或清除 `workflow_metadata.ghostty_window_id` |
| 步骤卡在 dispatched/running 但无 tab | new-tab 失败或 pi 崩溃 | `wf step <id>` 看 error/tab_id;`/wf retry <id>` 重派 |
| `依赖未完成,先完成: …` | 派发顺序违反依赖 | 按 §2 顺序:先依赖,后并行,再后续 |
| `/wf done` 提示步骤不存在 | 子 tab 身份没识别 | 检查 env `PI_WF_WORKFLOW/PI_WF_STEP`;或用完整 id(`/wf done <workflowId>-<dotted>`) |
| 状态回退 | new-tab 失败时步骤自动 failed 可重派 | `/wf retry <id>` |
| 步骤标 aborted「超时(Nmin 未完成)」 | 超过 steps.timeout_min(monitor 检测) | 调大 timeout_min 后 `/wf retry <id>` |
| 派发被拒「预算已用尽」 | 累计 usage_cost_cents ≥ budget_cents | 调整预算或人工处理;`/wf resume` 恢复 |
| 派发被拒「已重试 N/M 次,超过上限」 | retries_done ≥ max_retries | 人工介入;`/wf skip` 或调大 max_retries 后重派 |
| 需要向运行中的子任务补充指令 | — | `/wf steer <dotted> <文本>`(进子 pi 输入框并回车);脚本侧用 `wf inject <dotted> <text>`(CLI 无头版,自动回车) |
| merge 冲突「untracked working tree files would be overwritten: .pi-glla/…」 | 子 pi 在 worktree 里运行生成的运行时状态被跟踪 | 先 `wf cleanup`(自动清 .pi-glla + 补 .gitignore);已误提交则 `git rm -r --cached .pi-glla` 后在各 worktree 提交 |
| 终态步骤 tab 未关 | 子 pi 完成后未自行关闭 tab | `wf cleanup`(自动 close-terminal 并清 tab_id;运行中的步骤不会被动) |
| 子任务 tab 开了一堆 / 想查 tab 是否还活着 | 多轮派发累积 | `wf tabs [workflowId]`(每步 tab + 存活状态,`--json` 供脚本);对已终态 tab 用 `wf cleanup` |
| merge 报 conflict 但 worktree 已删/分支不存在 | 重复 merge 或评审类步骤无提交(已修复:自动跳过) | 重新 `/wf merge` 即可;或 `/wf resolve-conflict <id>` 后重试 |
| worktree 堆积 | 失败/中止的 worktree 保留现场 | `gittree list` 查看;`/wf clean` 或 `gittree clean <name> --branch --force` |
| 步骤无 tab / new-tab 失败但想补开 | 派发时开 tab 失败或 tab 被误关 | `wf open-tab <id>` 手动补开并恢复 running(§5.5.3 模板 E) |
| DB 里 tab 状态与终端不一致 | 步骤卡在无 tab 的 running / tab_id 过期 | `wf fix-tab <id> auto` 对齐状态(显式 id 须过存活校验;只改 DB,人工确认进程) |
| 想让编排脚本等待步骤完成 | — | `wf poll --until done`(退出码 0 达成 / 1 超时 / 2 不可达,§5.5.1) |

> 快捷修复序列与组合模板见 **§5.5 AI 编排操作速查**(模板 A–E);仍无法解决时按 §5.1 跑 `wf doctor` 自检环境。

### 5.3 直接查库(SQLite,只读安全)

```bash
sqlite3 ~/.pi/agent/workflows/workflow.db "SELECT id,status FROM workflow_steps WHERE workflow_id='<wf>' ORDER BY sort_order"
sqlite3 ~/.pi/agent/workflows/workflow.db "SELECT type,created_at,step_id FROM workflow_events WHERE workflow_id='<wf>' ORDER BY id"
sqlite3 ~/.pi/agent/workflows/workflow.db "SELECT * FROM v_workflow_kanban WHERE workflow_id='<wf>'"
```

表清单:workflow / workflow_goal_items / workflow_waves / workflow_steps / workflow_step_deps / workflow_attempts / workflow_events / workflow_agents / workflow_metadata / workflow_step_metadata;视图:v_workflow_kanban / v_workflow_cost。

### 5.4 重置/清理

```bash
wf clean                                        # 清理 gittree worktree(仅 gittree- 前缀,占用检测保护)
sqlite3 ~/.pi/agent/workflows/workflow.db "DELETE FROM workflow"   # 清空全部测试数据(级联)
```

## 5.5 AI 编排操作速查(无头脚本)

面向**主控 AI 自主编排 / 定时脚本**:所有 wf 命令均可无头执行(不依赖交互 tab),配合统一退出码可直接写进脚本流程。本节是高频操作与组合模板,完整命令清单见 §6。

### 5.5.1 定位与约定

- **退出码统一**:`0` 成功/达成;`1` 运行失败(目标不可解析、超时等);`2` 状态不可达(仅 poll,需人工介入);`3` 用法/参数错误。
- **输出约定**:进度/诊断打 stderr,结论/数据打 stdout;`--json` 输出纯 JSON 供脚本解析。
- **target 解析**(inject):完整 step id(`wf-x-1.1`)→ 点号 id(`1.1`)→ terminal id 前缀(十六进制,如 `1CA675C0`),先步骤后终端。

### 5.5.2 高频操作一览表

| 命令 | 用途 |
| --- | --- |
| `wf inject <target> <text...>` | 向步骤 tab/终端注入指令并自动回车(无头版 `/wf steer`);target 解析见 5.5.1 |
| `wf poll [workflowId] [--until S] [--timeout T] [--interval I]` | 轮询直到达成或超时;退出码 0 达成 / 1 超时 / 2 不可达 / 3 用法错 |
| `wf-wait <stepId...> [--workflow <id>] [--timeout N] [--interval N] [--until s1,s2] [--log <file>]` | 后台守望(不阻塞 agent):监听步骤状态迁移写日志;0 达成 / 1 超时 / 2 失败态 / 3 用法错。agent 每轮开头 `tail` 日志即可,唤醒由 monitor 通知负责 |
| `wf session [workflowId\|--last] [-n N] [--json]` | 读主控 pi 会话最近 N 条消息文本(自动跳 thinking/toolCall) |
| `wf open-tab <stepId>` | 手动为步骤补开子任务 tab 并恢复 running(复用绑定窗口与 worktree) |
| `wf fix-tab <stepId> <tid\|auto>` | 修复 DB 中步骤 tab 状态(排查用;只改状态不验证进程) |
| `wf cleanup [workflowId] [--dry-run]` | 关终态 tab + 清 .pi-glla + 修 .gitignore(merge 前置) |
| `wf tabs [workflowId] [--json]` | 查各步骤 tab 及存活状态 |
| `wf status [--json]` | 状态全景(进度/运行中/成本/最近事件) |
| `wf tree [workflowId]` | 层级任务树 |
| `wf events [workflowId] [N]` | 审计流(只增不改) |

派发/核对/重试等其余命令见 §6 CLI 列表。

### 5.5.3 组合模板

**模板 A:下发并等待**(最常用)

```bash
wf dispatch 1 1.1 1.2 && wf poll --until done --timeout 1800
# 退出码 0 → 全部达成,进入收尾链;1 → 看 stderr 未达成步骤;2 → wf step <id> 查原因 → wf retry <id>
```

**模板 B:完整编排链**(下发 → 引导 → 轮询 → 核对 → 合并 → 把关)

```bash
wf dispatch 1 1.1 1.2                # ① 下发任务(依赖就绪后并行)
wf inject 1.1 "补充要求:…"            # ② 引导子 agent:向子 tab 注入英文指令,自动回车
wf poll --until done --timeout 1800  # ③ 轮询完成;退出码 2 时先按模板 D 自愈
wf verify 2 approve                  # ④ gate 步骤核对(期望 vs 回报)
wf cleanup && wf merge               # ⑤ 收尾:关终态 tab + 合并 wave
wf goal-check approve                # ⑥ 目标把关 → workflow completed
```

**模板 C:轮询中注入补充指令**

poll 是只读轮询,与 inject 互不干扰;子 agent 卡住或需补充要求时,另起一条命令注入即可,轮询无需中断:

```bash
wf poll --until done --timeout 1800   # 终端 1:持续轮询
wf inject 1.1 "补充要求:请先完成 X"    # 终端 2:随时注入,自动回车
```

**模板 D:失败自愈循环**(脚本内自动重试)

```bash
until wf poll --until done --timeout 600; do
  wf step <failed>        # 看失败原因(stderr 会列出不可达步骤)
  wf retry <failed>       # 重派(默认复用 worktree)
done
```

**模板 E:故障快捷修复序列**

```bash
wf tabs              # ① 查各步骤 tab 存活(哪些步骤无有效 tab)
wf fix-tab <id> auto # ② DB tab 状态与终端不一致 → 对齐状态(只改 DB,人工确认进程在跑)
wf open-tab <id>     # ③ new-tab 失败/tab 被关 → 手动补开并恢复 running
wf cleanup           # ④ 收尾清理:关终态 tab + 清 .pi-glla
```

### 5.5.4 常见陷阱

- DB 里 `tab_id` 是 **terminal id**(`1CA675C0` 形式),不是 tab id(`tab-xxxx`);
- `fix-tab` 只改 DB 状态、**不验证子 pi 进程**是否真在跑,修完须人工确认;
- `poll` **不会自动派发**:pending/ready 步骤不计入达成,需先 `wf dispatch`;
- `inject` 文本含空格须整体引号;给子 tab 注入建议用英文(中文经 AppleScript 可能乱码,任务详情走 `/wf context`);
- `poll` 退出码 2(出现 failed/aborted/conflict/needs-fix)表示需人工介入,不是超时。

## 6. 辅助脚本(wf CLI)

`bin/wf`(node --experimental-strip-types 直跑 src/cli.ts,与插件共享核心逻辑):

```bash
wf plan-init <name> "<目标>" [--repo <path>] [--steps N]   # 生成 plan.json 模板
wf import <plan.json>                                      # 校验 + 落库
wf status [--json]                                         # 状态全景
wf tree [workflowId]                                       # 任务树
wf step <id>                                               # 单步详情
wf events [workflowId] [N] [--follow]                      # 审计流(可跟随)
wf dispatch <dotted...> [--workflow <id>] [--dry-run]      # 派发(自动化/无头)
wf verify <id> approve|reject [原因]                       # 核对
wf merge [--wave N]                                         # 合并 wave 回主分支
wf retry <id> [--fresh]                                     # 重派失败/中止/待修步骤
wf rebind-window [wfId]                                    # 重新绑定窗口(绑定窗口已关闭时)
wf done <id> '<JSON>' | wf fail <id> <原因>                # 回报(子任务侧)
wf tabs [workflowId] [--json]                               # 子任务 tab 状态(存活判定)
wf cleanup [workflowId] [--dry-run] [--no-fix]              # 关终态 tab + 清 .pi-glla + 修 .gitignore(合并前置)
wf clean                                                   # 清理残留 worktree
wf doctor                                                  # 环境自检
wf debug                                                   # 诊断信息
wf inject <target> <text...>                               # 向步骤 tab/终端注入指令+自动回车(无头 steer;target=完整id/点号id/terminal前缀)
wf poll [workflowId] [--until S] [--timeout T] [--interval I]  # 轮询直到达成/超时/不可达(0 达成/1 超时/2 不可达/3 用法)
wf session [workflowId|--last] [-n N] [--json]             # 读主控会话最近 N 条消息(跳 thinking/toolCall)
wf open-tab <stepId>                                       # 手动补开子任务 tab 并恢复 running
wf fix-tab <stepId> <tid|auto>                             # 修复 DB 步骤 tab 状态(排查用,只改状态)
```

## 7. 安全须知

- 子任务 tab 是可见交互会话,执行前用户可干预;
- 项目级 agent(`.pi/agents/`)默认禁用,`trustProjectAgents` + 确认后才用;
- 合并前必须 worktree 内已 commit;`/wf done` 只写状态,合并权在编排者(合并动作见 P2);
- 预算护栏:`budget_cents` 累计超限自动 pause(子 agent 经 `/wf done` 的 usage 字段自报成本);`max_steps` 防拆解失控;单步 `timeout_min` 超时标 aborted;`max_retries` 防无限重试。
