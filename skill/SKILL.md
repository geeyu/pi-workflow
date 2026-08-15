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

## 2. 执行(顺序语义,按依赖推进)

```
/wf dispatch 1 --workflow <id>            # 先生成顶层任务
/wf dispatch 1.1 1.2 --workflow <id>      # 依赖完成后,并行派发
/wf dispatch 2 --workflow <id>            # 1.1/1.2 全部完成后,发起 2
```

派发动作:冻结 base_sha → `gittree create wf-<wf>-<dotted>` → 渲染 task_md 写库 → 新 tab 开子 pi(固定开进 workflow 绑定窗口,不受焦点影响)→ pointer 注入并自动回车提交。

- **依赖未完成会被拒绝**(提示"依赖未完成,先完成:…")
- `--dry-run` 预览不落库不开窗
- 状态机:pending → ready → dispatched → running → reported → done;gate 步骤 reported → waiting-verify → done;失败 → failed/needs-fix 可重派

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
/wf skip <id> <原因>                      # 人工终态
/wf clean                                 # 清理残留 worktree / 归档
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
| 子任务 tab 开错窗口 | 依赖焦点窗口 | 已改为 workflow 绑定窗口(`workflow_metadata.ghostty_window_id`);查看:`wf debug` |
| 步骤卡在 dispatched/running 但无 tab | new-tab 失败或 pi 崩溃 | `wf step <id>` 看 error/tab_id;`/wf retry <id>` 重派 |
| `依赖未完成,先完成: …` | 派发顺序违反依赖 | 按 §2 顺序:先依赖,后并行,再后续 |
| `/wf done` 提示步骤不存在 | 子 tab 身份没识别 | 检查 env `PI_WF_WORKFLOW/PI_WF_STEP`;或用完整 id(`/wf done <workflowId>-<dotted>`) |
| 状态回退 | new-tab 失败时步骤自动 failed 可重派 | `/wf retry <id>` |
| 步骤标 aborted「超时(Nmin 未完成)」 | 超过 steps.timeout_min(monitor 检测) | 调大 timeout_min 后 `/wf retry <id>` |
| 派发被拒「预算已用尽」 | 累计 usage_cost_cents ≥ budget_cents | 调整预算或人工处理;`/wf resume` 恢复 |
| 派发被拒「已重试 N/M 次,超过上限」 | retries_done ≥ max_retries | 人工介入;`/wf skip` 或调大 max_retries 后重派 |
| 需要向运行中的子任务补充指令 | — | `/wf steer <dotted> <文本>`(进子 pi 输入框并回车) |
| merge 冲突「untracked working tree files would be overwritten: .pi-glla/…」 | 子 pi 在 worktree 里运行生成的运行时状态被跟踪 | 仓库 .gitignore 加 `.pi-glla/`;已误提交则 `git rm -r --cached .pi-glla` 后在各 worktree 提交 |
| merge 报 conflict 但 worktree 已删/分支不存在 | 重复 merge 或评审类步骤无提交(已修复:自动跳过) | 重新 `/wf merge` 即可;或 `/wf resolve-conflict <id>` 后重试 |
| worktree 堆积 | 失败/中止的 worktree 保留现场 | `gittree list` 查看;`/wf clean` 或 `gittree clean <name> --branch --force` |

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
wf done <id> '<JSON>' | wf fail <id> <原因>                # 回报(子任务侧)
wf clean                                                   # 清理 worktree
wf doctor                                                  # 环境自检
wf debug                                                   # 诊断信息
```

## 7. 安全须知

- 子任务 tab 是可见交互会话,执行前用户可干预;
- 项目级 agent(`.pi/agents/`)默认禁用,`trustProjectAgents` + 确认后才用;
- 合并前必须 worktree 内已 commit;`/wf done` 只写状态,合并权在编排者(合并动作见 P2);
- 预算护栏:`budget_cents` 累计超限自动 pause(子 agent 经 `/wf done` 的 usage 字段自报成本);`max_steps` 防拆解失控;单步 `timeout_min` 超时标 aborted;`max_retries` 防无限重试。
