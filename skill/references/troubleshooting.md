# 排查手册与安全须知

> 由 skill/SKILL.md 拆分,按需加载。

# 排查手册

> 由 skill/SKILL.md 拆分,按需加载。

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
| 子 tab 中文乱码 | ~~AppleScript input text 编码~~(已改:pointer 经 pi 位置参数交付,纯 ASCII,不再走 input text) | 中文任务内容走 `/wf context`(DB 自取,不受终端编码影响) |
| 派发报错「绑定窗口 … 已关闭」 | workflow 专属窗口被关闭,按 id 定位失败 | `/wf rebind-window` 后 `/wf retry <id>`;或清 `workflow_metadata.ghostty_window_id` 重建专属窗口 |
| 步骤 running 但 tab 消失/误判 aborted | layout 查询瞬时抖动(已抗抖动:连续 2 次未命中才判) | `wf tabs` 核实存活 → `wf fix-tab <id> <tid>` 对齐;retry 会自动复用存活 tab(不重开) |
| 步骤卡在 dispatched/running 但无 tab | new-tab 失败或 pi 崩溃 | `wf step <id>` 看 error/tab_id;`wf open-tab <id>` 或 `/wf retry <id>` |
| `依赖未完成,先完成: …` | 派发顺序违反依赖 | 按 §3.1 顺序:先依赖,后并行,再后续 |
| `/wf done` 提示步骤不存在 | 子 tab 身份没识别 | 检查 env `PI_WF_WORKFLOW/PI_WF_STEP`;或用完整 id(`/wf done <workflowId>-<dotted>`) |
| 步骤标 aborted「超时(Nmin 未完成)」 | 超过 steps.timeout_min(monitor 检测) | 调大 timeout_min 后 `/wf retry <id>` |
| 派发被拒「预算已用尽」 | 累计 usage_cost_cents ≥ budget_cents | 调整预算或人工处理;`/wf resume` 恢复 |
| 派发被拒「已重试 N/M 次,超过上限」 | retries_done ≥ max_retries | 人工介入;`/wf skip` 或调大 max_retries 后重派 |
| merge 冲突「untracked working tree files would be overwritten: .pi-glla/…」 | 子 pi 运行时状态被跟踪 | 先 `wf cleanup`;已误提交则 `git rm -r --cached .pi-glla` 后各 worktree 提交 |
| merge 报 conflict 但 worktree 已删/分支不存在 | 重复 merge 或评审类步骤无提交(已自动跳过) | 重新 `/wf merge`;或 `/wf resolve-conflict <id>` 后重试 |
| merge 后 gittree 残留 | skipped 步骤/merge --delete 未删干净 | 已自动兜底:wave 合并成功后对所有步骤 worktree 残留清扫(gittree clean --branch --force);仍残留可手动 `gittree clean <name> --branch --force` |
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
wf delete <workflowId>    # 删除一个 workflow(关 tab + 清 gittree + 级联删数据)
wf clean                  # 清理 gittree worktree(仅 gittree- 前缀,占用检测保护)
```

禁止直接操作数据库文件(sqlite3 等);一切清理经 wf 命令。

---

## 6. 安全须知

- 子任务 tab 是**可见交互式会话**,执行前用户可干预;
- 项目级 agent(`.pi/agents/`)默认禁用,`trustProjectAgents` + 确认后才用;
- 合并前必须 worktree 内已 commit;`/wf done` 只写状态,合并权在编排者;
- 预算护栏:`budget_cents` 累计超限自动 pause;`max_steps` 防拆解失控;单步 `timeout_min` 超时标 aborted;`max_retries` 防无限重试;
- 命令级去重:重派前实时查 tab 存活,存活则复用不重开(防双 tab 同 worktree 并发);
- monitor 抗抖动:连续 2 次轮询未命中才判 tab 关闭,避免瞬时误判。
