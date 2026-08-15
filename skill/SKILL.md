# pi-workflow 手册

> **pi 编排插件**:主 pi 为调度者,把大计划拆成并行/串行批次;每个子任务 = 一个 gittree worktree + 一个 Ghostty tab(可见、可干预);全生命周期事件落 SQLite(`~/.pi/agent/workflows/workflow.db`,唯一事实源)。
>
> 权威文档层级:本文(使用手册)→ `DESIGN.md`(设计与数据模型)→ 代码(src/,以注册表为准)。
> 本文所有命令与 `src/command.ts` 注册表同步;冲突时以代码为准。

**三行速览**:
- 编排者:`/wf plan "目标"` 拆解 → `/wf dispatch 1.1 1.2` 派发(自动开 tab)→ 子 agent 干完 `/wf done` → 你 `/wf verify approve` → `/wf merge` → `/wf goal-check approve`
- 子任务:tab 里 `/wf context` 读任务 → 干完 commit → `/wf done 1.1 '{"summary":"..."}'`
- 无头自动化:全部命令都有 CLI 等价(`wf ...`),可脚本化;状态变化由 monitor 自动通知主控

---

## 1. 快速上手(渐进式)

### 1.1 三步跑通第一个 workflow

**第 1 步:准备计划**(二选一)

```bash
# 方式 A:一句话让 planner agent 自动拆解(推荐)
/wf plan "给 hello 工具加 --name 与 --verbose 参数,并同步 README" --repo ~/myrepo

# 方式 B:手写 plan.json 后导入
wf plan-init hello-cli "给 hello 工具加参数" --repo ~/myrepo --steps 4   # 生成模板
# 编辑 plan.json 后:
/wf import plan.json          # 校验 + 落库(校验规则见 §4.4)
```

**第 2 步:派发并等待回报**

```bash
/wf dispatch 1                # 顶层步骤:建 worktree + 开子 tab + 任务写库
/wf dispatch 1.1 1.2          # 依赖 done 后,并行派发
/wf status                    # 随时看全景;步骤回报时 monitor 会自动通知你
```

**第 3 步:核对、合并、收尾**

```bash
/wf verify 1.1 approve        # 对照期望核对回报(不达标用 reject,子 agent 回炉)
/wf verify 2 approve          # gate 步骤(reviewer)回报后同样核对
wf cleanup && /wf merge       # 关终态 tab + 清 .pi-glla,然后串行合回主分支
/wf goal-check approve        # 对照最初目标把关 → completed
```

### 1.2 核心概念

| 概念 | 说明 |
| --- | --- |
| workflow | 一次大计划(一个 goal + 若干 wave),状态 idle→running→verifying→completed |
| wave | 批次:wave 内步骤并行/串行组合;wave 全部终态 → 串行 merge → 下一 wave |
| step | 最小任务单元,层级点号 id(`1`、`1.1`、`1.2.3`);worktree 命名 `wf-<workflow>-<dotted>` |
| gate | 硬性核对标记:gate 步骤回报后必须 `/wf verify` 才能进合并 |
| expectations | 派发前设定期望(验收标准),回报后对照核对(执行前设定、执行后更新) |
| worktree | 每步一个 gittree worktree(同 base_sha),子 agent 只改自己目录 |
| tab / 身份 | 每步一个可见子 pi tab;身份经 env `PI_WF_WORKFLOW/PI_WF_STEP` 或 worktree 路径解析 |
| 事件 | workflow_events 只增不改,全生命周期可追溯(37 类,见 §4.2) |
| monitor | 主控侧 5s 轮询:tab 存活检测、状态事件检测、自动通知主控 |

### 1.3 两个入口(命令矩阵)

所有命令定义在**同一注册表**(`src/command.ts`),两个入口共享,行为一致:

| 入口 | 形态 | 适用 |
| --- | --- | --- |
| `/wf <cmd>` | pi 插件命令(TUI 内,notify/widget 展示) | 编排者日常、子任务侧(context/done/fail) |
| `wf <cmd>` | CLI(bin/wf,stdout/退出码) | 无头自动化、脚本、排查、子 agent |

| 命令组 | 双入口共享 | 仅 CLI | 仅 /wf |
| --- | --- | --- | --- |
| 计划 | plan / import | plan-init | — |
| 派发执行 | dispatch / retry / context / done / fail / skip | inject / open-tab / fix-tab | steer |
| 核对收尾 | verify / resolve-conflict / merge / goal-check / next / resume | cleanup / clean | — |
| 查询展示 | status / tree / board / step / events | tabs / poll / session / doctor / debug | — |
| 窗口 | rebind-window | — | — |

> `/wf steer` 与 `wf inject` 等价(向子 tab 注入指令+回车);CLI 无 context 身份时显式传 stepId。

---

## 2. 命令参考(32 条,按用途分组)

> 退出码契约(CLI):`0` 成功 / `1` 业务错误 / `2` 不可达(poll)/ `3` 用法错误。
> 用法错误统一格式:`用法: <usage>`(stderr)。

### 2.1 计划与创建

**`wf plan "<需求目标>" [--repo <path>] [--workflow <id>] [--dry-run]`**(both)
planner agent(headless 子进程)自动拆解成层级计划并落库。
- 无 `--workflow`:新建 workflow;有 `--workflow <id>`:给当前 wave 追加步骤(gap wave)
- `--dry-run`:只看拆解结果不落库
```bash
/wf plan "给 session store 加 Redis 缓存,登录/登出全量覆盖" --repo ~/server
/wf plan "补上遗漏的测试" --workflow add-redis-cache     # gap wave 追加
```

**`wf plan-init <name> "<目标>" [--repo <path>] [--steps N]`**(cli)
生成 plan.json 模板,手编后 `wf import`。
```bash
wf plan-init add-redis-cache "给 session store 加 Redis 缓存" --repo ~/server --steps 4
```

**`wf import <plan.json>`**(both)
校验(§4.4)+ 事务落库。通过提示「已导入 N 个步骤(wave M)」。
```bash
/wf import plan.json
```

### 2.2 派发与子任务

**`wf dispatch <dotted...> [--workflow <id>] [--dry-run]`**(both)
派发:冻结 base_sha → gittree create worktree → 渲染 task_md 入库 → 绑定窗口开子 tab → 注入短指引。
- 无参数 = 派发当前 wave 全部就绪步骤(依赖全 done)
- 依赖未完成会被拒绝(「依赖未完成,先完成: …」),按依赖顺序推进
```bash
/wf dispatch 1                # 顶层
/wf dispatch 1.1 1.2          # 依赖 done 后并行
/wf dispatch --dry-run 1.1    # 预览不落库不开窗
```

**`wf retry <id> [--fresh]`**(both)
重派 failed/aborted/needs-fix 步骤;自动注入上次失败原因到新任务正文。
- 默认复用 worktree;`--fresh` 重建(worktree_cleaned)
- **实时去重**:重派前查一次 tab 存活,若原 tab 仍活着(如 monitor 误判)→ 恢复 running,不重开新 tab
```bash
/wf retry wf-demo-1.2
/wf retry wf-demo-1.2 --fresh   # 重建 worktree 重来
```

**`wf context [stepId]`**(both)
读任务详情(markdown):优先最新 attempt 的冻结版。无参 = 按身份解析(子 pi tab 内);CLI 显式传 stepId。
```bash
/wf context                     # 子 tab 内读自己的任务
wf context wf-arch-1.1          # CLI 读任意步骤任务
```

**`/wf steer <dotted> <文本>`**(pi)/ **`wf inject <target> <text...>`**(cli)
向子任务 tab 注入指令并自动回车(与 /wf steer 同构)。
- inject 的 target 三级解析:完整 step id → 点号 id → terminal id 前缀
- 注入文本建议纯 ASCII(AppleScript 中文会乱码;中文内容走 `/wf context`)
```bash
/wf steer 1.2 "Read docs/design.md first, then implement. Report with /wf done 1.2"
wf inject 1.2 "run /wf context then start"      # CLI 同款
wf inject C2DE1FBA "continue"                    # 按 terminal 前缀
```

**`wf done <id> '<JSON>'` / `wf fail <id> <原因>`**(both,子任务侧)
回报完成/失败。done 的 JSON 契约:`summary`(必填)/ `filesChanged` / `issues` / `tests`(passed|failed|none),可带 `usage:{input,output,costCents,turns}` 自报成本(预算护栏用)。
```bash
/wf done 1.1 '{"summary":"缓存写入已实现","filesChanged":["src/cache.ts"],"issues":[],"tests":"passed"}'
/wf fail 1.2 "接口文档缺失,无法继续"
```
> 子任务侧流程完整见 §3.2。回报前**必须在 worktree 内 git commit**(合并前置)。

**`wf skip <stepId> <原因>`**(both)
人工终态:任意非终态步骤 → skipped(后续步骤视其为 done)。
```bash
/wf skip 1.3 "该方案不再需要,整体由 1.1 覆盖"
```

### 2.3 核对与收尾

**`wf verify <id> approve|reject <原因>`**(both)
期望核对(gate 步骤回报后进入 waiting-verify,必须 verify 才能 merge)。
- approve → done;reject → needs-fix(重派时自动注入驳回原因)
```bash
/wf verify wf-arch-2 approve
/wf verify 1.1 reject "summary 没有说明测试结果"
```

**`wf resolve-conflict <stepId>`**(both)
merge 冲突解决后确认:conflict → done,继续 merge。完整序列见 §3.3。
```bash
wf resolve-conflict wf-arch-1.2
```

**`wf merge [--wave N]`**(both)
wave 全部终态后串行 gittree merge --delete(按层级序);冲突 → 步骤 conflict(保留现场)。
```bash
wf cleanup && wf merge        # 合并前置:关终态 tab + 清 .pi-glla
/wf merge --wave 2            # 显式指定 wave
```

**`wf goal-check [--workflow <id>] [approve|reject <原因>]`**(both)
全部合并后目标把关:无参数进入 verifying 并展示核对依据(各步骤 summary/issues/tests)。
- approve → completed;reject → 回 running,拆 gap wave 补齐
- 多 workflow 同仓库时务必 `--workflow <id>`(CLI 解析顺序:显式 id → PI_WF_WORKFLOW+PI_WF_STEP → cwd 唯一活动仓库)
```bash
/wf goal-check                      # 先看核对依据
/wf goal-check approve              # 达成
wf goal-check --workflow wf-arch approve    # CLI 显式指定
```

**`wf next [--note <说明>]`**(both)
滚动到下一 wave(先 next 再 `wf plan --workflow <id>` 补步骤)。
```bash
/wf next --note "合并后验证批次"
```

**`wf resume [--workflow <id>]`**(both)
预算超限自动暂停后恢复:paused → running。
```bash
/wf resume --workflow add-redis-cache
```

### 2.4 查询与展示

**`wf status [--json] [wfId]`**(both)
状态全景:进度/运行中/成本/最近事件;`--all` 含已完成。footer 状态条(`setStatus`)实时展示活动 workflow。
```bash
/wf status          # TUI widget
wf status --json    # 脚本消费
```

**`wf tree [wfId]`**(both)/ **`wf step <id>`**(both)/ **`wf events [wfId] [N] [--follow]`**(both)
层级任务树 / 单步详情(含 attempts 历史、错误、任务正文)/ 审计流(只增不改)。
```bash
/wf step wf-arch-1.1     # 看回报、错误、attempts
wf events --follow       # 实时跟随事件流
```

**`wf board [wfId] [--wave N] [--html out.html]`**(both)
终端 5 列看板(待办/进行中/待核对/完成/异常,层级缩进 + 摘要);`--html` 导出单文件。
```bash
/wf board --wave 1
wf board wf-arch --html board.html
```

**`wf session [wfId|--last] [-n N] [--json]`**(cli)
读主控 pi 会话最近 N 条消息文本(按 cwd 编码目录定位,跳 thinking/toolCall)。
```bash
wf session --last -n 5
```

**`wf poll [wfId] [--until S] [--timeout T] [--interval I]`**(cli)
轮询直到达成或超时,适合脚本。达成集 = {until} ∪ {skipped};pending/ready 不计入达成;失败态提前退出。
- 退出码:`0` 达成 / `1` 超时 / `2` 不可达(failed/aborted/conflict/needs-fix)/ `3` 用法错
```bash
wf poll wf-arch --until done --timeout 1800 --interval 10   # 等全部 done
wf poll --until reported --timeout 300                      # 等本轮回报(然后 verify)
```

### 2.5 维护与排查

**`wf tabs [workflowId] [--json]`**(cli)
各步骤 tab + 存活状态(按 terminal id 匹配 layout)。
```bash
wf tabs wf-arch        # 看哪些 tab 还活着
```

**`wf open-tab <stepId>`**(cli)
手动补开子任务 tab(绑 worktree/锁定窗口,恢复 running);已绑定且存活 → 拒绝。
```bash
wf open-tab wf-arch-1.2
```

**`wf fix-tab <stepId> <tid|auto>`**(cli)
修复 DB 中步骤 tab 状态(排查用,只改状态不验证进程);显式 id 必须通过 layout 存活校验。
```bash
wf fix-tab wf-arch-1.2 771C3FFF    # 对齐到已知存活 terminal
wf fix-tab wf-arch-1.2 auto        # 按 worktree cwd 反查
```

**`wf cleanup [workflowId] [--dry-run] [--no-fix]`**(cli)
合并前置:关终态 tab + 清 .pi-glla + 修 .gitignore(运行中/待核对步骤跳过)。
```bash
wf cleanup --dry-run    # 先看会做什么
wf cleanup
```

**`wf rebind-window [wfId]`**(both)
绑定窗口已关闭时,把当前焦点窗口设为绑定窗口(解除「绑定窗口已关闭」死锁)。
```bash
/wf rebind-window wf-arch
```

**`wf clean`**(cli)/ **`wf doctor`**(cli)/ **`wf debug`**(cli)
清理残留 worktree(占用检测保护)/ 环境自检(node/gittree/ghostctl/python3/DB)/ 诊断信息(库版本/表规模/运行中任务/绑定窗口)。

```bash
wf doctor     # 排查第一步
wf debug
```

---

## 3. 编排流程(端到端)

### 3.1 标准编排(编排者视角)

```text
① 计划     /wf plan "目标"                    → workflow + wave 1 步骤
② 派发     /wf dispatch 1                    → 顶层步骤(planner)开 tab
③ 推进     /wf dispatch 1.1 1.2              → 依赖 done 后并行(worker)
④ 引导     /wf steer 1.1 "run /wf context, implement, test, commit, then /wf done 1.1"
⑤ 核对     /wf verify 1.1 approve|reject     → done / needs-fix(回炉)
⑥ 收尾     wf cleanup && /wf merge           → wave 合回主分支
⑦ 把关     /wf goal-check approve            → completed
```

**并行/串行规则**:无依赖边且为 worker 类 → 并行;有依赖或涉及共享文件 → 串行。依赖未完成时 dispatch 会被拒绝。

### 3.2 子任务侧流程(子 pi tab 内)

```text
/wf context          → 读任务详情(markdown:目标/本步任务/期望/约束/输出契约)
(在 worktree 内实现;完成后 git commit)
/wf done 1.1 '<JSON>' → 回报(契约见 §2.2);gate 步骤 → waiting-verify
/wf fail 1.1 <原因>   → 主动报失败(比 tab 消失兜底更优雅)
```

> 子 pi 身份:env `PI_WF_WORKFLOW/PI_WF_STEP`(派发注入),兜底解析 cwd worktree 路径。

### 3.3 冲突处理(merge conflict)

```bash
wf step <wf>-<id>                # 看冲突步骤与错误
# 人工解决 git 冲突(编辑冲突文件,或保留一侧:git checkout --ours/--theirs <file>)
git add -A && git commit -m "merge: 解决 <wf>-<id> 冲突"   # 完成 git 合并
git worktree remove --force .worktrees/gittree-wf-<wf>-<id>  # 先移 worktree(顺序!否则 branch -D 报占用)
git branch -D gittree-wf-<wf>-<id>
wf resolve-conflict <wf>-<id>    # DB:conflict → done
wf merge --wave N                # 重新合并
```

### 3.4 主控自主编排(monitor 自动通知)

monitor 每 5s 检测关键状态,经 `pi.sendMessage(followUp, triggerTurn)` 推给主控:

| 事件 | 主控应执行 |
| --- | --- |
| 步骤回报 / gate 待核对 | `/wf verify <id> approve\|reject` |
| 失败 / 中止 | `/wf step <id>` 查原因 → `/wf retry <id>`(先 `wf tabs` 核实 tab 是否真死) |
| 冲突 / 待修复 | 解决后 `/wf resolve-conflict <id>` |
| wave 完成 | `wf cleanup && /wf merge` |
| 全流程完成 | `/wf goal-check approve` |

> 去重:每种事件每步骤每 attempt 只通知一次;手动 `/wf status` 不受影响。
> 通知可能延迟投递(如执行中):收到后先核实状态再动作,不盲信单条通知。

---

## 4. 概念与数据模型

### 4.1 状态机

**步骤**(workflow_steps.status):

```text
pending ──(依赖全 done)──► ready ──(dispatch)──► dispatched ──(tab 就绪)──► running
running ──(/wf done)──► reported ──(verify approve)──► done
                        └──────────────(reject)──► needs-fix ──(retry)──► running
running ──(tab 消失/超时)──► aborted ──(retry / skip)──► …
reported ──(gate=1)──► waiting-verify ──(verify)──► done | needs-fix
任意非终态 ──(/wf skip)──► skipped(依赖视为 done)
merge 冲突 ──► conflict ──(resolve-conflict)──► done
```

合法迁移表(权威):`src/core/state.ts` 的 `STEP_TRANSITIONS`(已建表,接线中)。

**workflow**:

```text
idle ──(import/plan 后首派发)──► running ──(全部 wave 合并)──► verifying ──(goal-check approve)──► completed
                                  │                              └──(reject)──► running(拆 gap wave)
                                  ├──(预算超限)──► paused ──(resume)──► running
                                  └──(不可恢复失败)──► failed
```

### 4.2 事件类型(35 类,只增不改)

| 域 | 事件 |
| --- | --- |
| workflow | created / started / paused / resumed / completed / failed / aborted / goal_check_started / goal_check_passed / goal_check_failed / window_rebound |
| wave | started / completed / merged |
| step | created / decomposed / dispatched / tab_opened / tab_reused / tab_closed / tab_fixed / reported / verified / needs_fix / failed / retrying / aborted / skipped / conflict / resolved |
| worktree | created / merged / cleaned;merge_conflict / merge_resolved |

### 4.3 数据库(10 表 + 2 视图)

表:`workflow` / `workflow_goal_items` / `workflow_waves` / `workflow_steps` / `workflow_step_deps` / `workflow_attempts` / `workflow_events` / `workflow_agents` / `workflow_metadata` / `workflow_step_metadata`;视图:`v_workflow_kanban` / `v_workflow_cost`。

**workflow_steps 列名速查**(查库前先看这里,别猜列名):

| 用途 | 列名 |
| --- | --- |
| 步骤 id | `id`(完整 id,如 `wf-demo-1.2`;不是 step_id) |
| 任务正文 | `task_md`(不是 task;读任务用 `wf context <id>` 更省事) |
| 期望/验收 | `expectations`(JSON 数组字符串) |
| 回报 | `report` / `summary` / `files_changed` / `issues` / `tests`(无 output_contract 列) |
| 护栏 | `timeout_min` / `max_retries` / `retries_done` |
| 派发信息 | `worktree` / `tab_id` / `gate` / `wave_id` / `sort_order` |
| 成本 | `usage_input` / `usage_output` / `usage_cost_cents` / `usage_turns` |
| 时间 | `created_at` / `updated_at` / `started_at` / `finished_at` |

尝试史:`workflow_attempts(step_id, attempt_no, status, error, task_md, pointer, usage_*)`——每次派发的冻结副本与错误。

常用查询:

```bash
sqlite3 ~/.pi/agent/workflows/workflow.db "SELECT id,status FROM workflow_steps WHERE workflow_id='<wf>' ORDER BY sort_order"
sqlite3 ~/.pi/agent/workflows/workflow.db "SELECT type,created_at,step_id FROM workflow_events WHERE workflow_id='<wf>' ORDER BY id"
sqlite3 ~/.pi/agent/workflows/workflow.db "SELECT * FROM v_workflow_kanban WHERE workflow_id='<wf>'"
```

### 4.4 plan.json 格式

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

- 校验规则:workflow id kebab-case;step id 点号层级且唯一;agent 必须存在于 `~/.pi/agent/agents/*.md`(planner/worker/reviewer 内置);deps 存在且无环;数量 ≤ max_steps
- `task` 支持模板注入:`{{steps.<dotted>.summary|files|status}}` / `{{root}}`;引用未完成依赖 → 占位提示
- `gate: true` = 回报后必须 `/wf verify` 才能进合并

---

## 5. 排查手册

### 5.1 先跑环境自检

```bash
wf doctor        # node/gittree/ghostctl/python3/DB
wf debug         # 库版本/表规模/运行中任务/事件数/绑定窗口
```

### 5.2 常见问题对照表

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `gittree create 失败: invalid reference: HEAD` | 仓库无提交(空 HEAD) | 仓库先做初始提交 |
| `gittree: command not found` | 非交互 shell PATH 缺 `~/.local/bin` | 已内置兜底绝对路径;手动 `export PATH="$HOME/.local/bin:$PATH"` |
| `bin/wf: exec: node: not found` | PATH 缺 node | 已修复:bin/wf 自动兜底 WF_NODE → PATH → fnm → brew;仍失败 `WF_NODE=<绝对路径> wf ...` |
| ghostctl 报 `TypeError: ... 'type' and 'NoneType'` | python3 < 3.10(不支持 `str \| None`) | PATH 优先 brew python3;`wf doctor` 可查 |
| 子 tab 中文乱码 | AppleScript input text 编码 | 注入用纯 ASCII;中文任务内容走 `/wf context` |
| 派发报错「绑定窗口 … 已关闭」 | 绑定窗口被关闭,按 id 定位失败 | `/wf rebind-window` 后 `/wf retry <id>`;或清 `workflow_metadata.ghostty_window_id` |
| 步骤 running 但 tab 消失/误判 aborted | layout 查询瞬时抖动(已抗抖动:连续 2 次未命中才判) | `wf tabs` 核实存活 → `wf fix-tab <id> <tid>` 对齐;retry 会自动复用存活 tab(不重开) |
| 步骤卡在 dispatched/running 但无 tab | new-tab 失败或 pi 崩溃 | `wf step <id>` 看 error/tab_id;`wf open-tab <id>` 或 `/wf retry <id>` |
| `依赖未完成,先完成: …` | 派发顺序违反依赖 | 按 §3.1 顺序:先依赖,后并行,再后续 |
| `/wf done` 提示步骤不存在 | 子 tab 身份没识别 | 检查 env `PI_WF_WORKFLOW/PI_WF_STEP`;或用完整 id(`/wf done <workflowId>-<dotted>`) |
| 步骤标 aborted「超时(Nmin 未完成)」 | 超过 steps.timeout_min(monitor 检测) | 调大 timeout_min 后 `/wf retry <id>` |
| 派发被拒「预算已用尽」 | 累计 usage_cost_cents ≥ budget_cents | 调整预算或人工处理;`/wf resume` 恢复 |
| 派发被拒「已重试 N/M 次,超过上限」 | retries_done ≥ max_retries | 人工介入;`/wf skip` 或调大 max_retries 后重派 |
| merge 冲突「untracked working tree files would be overwritten: .pi-glla/…」 | 子 pi 运行时状态被跟踪 | 先 `wf cleanup`;已误提交则 `git rm -r --cached .pi-glla` 后各 worktree 提交 |
| merge 报 conflict 但 worktree 已删/分支不存在 | 重复 merge 或评审类步骤无提交(已自动跳过) | 重新 `/wf merge`;或 `/wf resolve-conflict <id>` 后重试 |
| `cannot delete branch ... used by worktree` | 先删分支后移 worktree | 顺序:先 `git worktree remove --force <path>` 再 `git branch -D <name>` |
| 终态步骤 tab 未关 | 子 pi 完成后未自行关闭 | `wf cleanup`(自动关终态 tab;运行中步骤不动) |
| 子任务 tab 开了一堆 | 多轮派发累积 | `wf tabs [wf]` 查存活;`wf cleanup` 关终态 |
| worktree 堆积 | 失败/中止的 worktree 保留现场 | `gittree list` 查看;`wf clean` 或 `gittree clean <name> --branch --force` |

### 5.3 快捷修复序列

```text
tab 异常:  wf tabs 查存活 → wf fix-tab <id> <tid|auto> 对齐状态 → 仍不行 wf open-tab <id> 重开
状态异常:  wf step <id> 看错误 → 可重试 /wf retry <id> → 人工终态 /wf skip <id> <原因>
合并异常:  wf cleanup(前置)→ /wf merge → 冲突按 §3.3 序列
```

### 5.4 重置/清理

```bash
wf clean                                        # 清理 gittree worktree(仅 gittree- 前缀,占用检测保护)
sqlite3 ~/.pi/agent/workflows/workflow.db "DELETE FROM workflow"   # 清空全部测试数据(级联)
```

---

## 6. 安全须知

- 子任务 tab 是**可见交互式会话**,执行前用户可干预;
- 项目级 agent(`.pi/agents/`)默认禁用,`trustProjectAgents` + 确认后才用;
- 合并前必须 worktree 内已 commit;`/wf done` 只写状态,合并权在编排者;
- 预算护栏:`budget_cents` 累计超限自动 pause;`max_steps` 防拆解失控;单步 `timeout_min` 超时标 aborted;`max_retries` 防无限重试;
- 命令级去重:重派前实时查 tab 存活,存活则复用不重开(防双 tab 同 worktree 并发);
- monitor 抗抖动:连续 2 次轮询未命中才判 tab 关闭,避免瞬时误判。
