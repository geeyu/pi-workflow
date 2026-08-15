# 概念与数据模型

> 由 skill/SKILL.md 拆分,按需加载。

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

