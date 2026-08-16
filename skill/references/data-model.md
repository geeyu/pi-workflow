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
      (master 模式:目标把关通过 → awaiting-merge → /wf master-merge → completed)
                                  │                              └──(reject)──► running(拆 gap wave)
                                  ├──(预算超限)──► paused ──(resume)──► running
                                  └──(不可恢复失败)──► failed
```

### 4.2 事件类型(35 类,只增不改)

| 域 | 事件 |
| --- | --- |
| workflow | created / started / paused / resumed / completed / failed / aborted / goal_check_started / goal_check_passed / goal_check_failed / window_rebound / master_started / master_done / master_merged / master_failed / master_tab_closed |
| wave | started / completed / merged |
| step | created / decomposed / dispatched / tab_opened / tab_reused / tab_closed / tab_fixed / reported / verified / needs_fix / failed / retrying / aborted / skipped / conflict / resolved |
| worktree | created / merged / cleaned;merge_conflict / merge_resolved |

### 4.3 数据模型(抽象)

**⚠️ agent 只经 wf 命令操作;不要直接读写数据库文件,不要臆想 SQL。**

- **workflow**:一次编排(goal/status/repo/base_sha);
- **wave**:批次(串行推进,全部终态才合并);
- **step**:任务(点号层级 id `1 / 1.1 / 1.2`,依赖图 = deps;每步一个 gittree worktree + 一个 Ghostty tab);
- **attempt**:派发记录(每次派发的冻结任务正文与指针,重试可回溯);
- **event**:全生命周期事件流(wave/step/worktree/attempt 各阶段,`wf events` 可查);
- **metadata**:workflow 级键值(如绑定窗口、master tab);step_metadata:步骤级键值。

状态与事件枚举见上表;查看实时状态一律用 `wf status` / `wf board` / `wf events`。

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

