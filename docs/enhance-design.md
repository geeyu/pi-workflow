> [!NOTE] 历史归档(2026-08-15)
> 本文是早期 workflow(wf-enhance / wf-enhance2)施工过程的产物,描述的能力**已全部实现并可能已演进**。
> 权威文档:DESIGN.md(设计)、skill/SKILL.md(使用手册)。如与现状冲突,以 DESIGN.md / SKILL.md / 代码为准。

# wf-enhance 增强方案(wave 1 step 1 输出)

三部分:① monitor 状态事件通知机制;② wf cleanup/tabs 工具设计;③ skill「派发 workflow」章节大纲。
依据代码:src/monitor.ts、src/index.ts、src/cli.ts、src/db.ts、src/orchestrator.ts、src/dispatch.ts、skill/SKILL.md、pi 扩展 API(extensions.md §sendMessage)。

---

## ① monitor 状态事件通知机制(主控自主编排)

### 1.1 检测方式:monitor tick 内扫描 DB,而非订阅回调

`reportDone` 可能由**子 pi 自己的扩展进程**执行(子 pi 内 `/wf done` 直接写库),编排者进程内拿不到同步回调;SQLite 是唯一事实源。因此**在现有 startMonitor 的 tick 中做状态扫描**(pollOnce 之后),对 DB 全量快照 diff 出"新发生"的关键状态,天然覆盖多进程写入与崩溃恢复,不依赖任何进程内状态。

检测事件集(每 tick 扫描,状态满足即视为发生):

| 事件 | 检测条件(workflow_steps 状态) | 通知文案含的引导命令 |
| --- | --- | --- |
| 步骤已回报 | status = `reported`(非 gate) | `/wf verify <id> approve`、`/wf status` |
| gate 待核对 | status = `waiting-verify` | `/wf verify <id> approve\|reject <原因>` |
| 步骤失败 | status = `failed` | `/wf retry <id>`、`/wf step <id>` 看错误 |
| 步骤中止 | status = `aborted`(超时/tab 关闭) | `/wf retry <id>` |
| 冲突 | status = `conflict` 或事件 merge_conflict | `/wf resolve-conflict <id>` 后 `/wf merge` |
| 待修复 | status = `needs-fix`(verify reject) | `/wf retry <id>` |
| wave 完成 | 当前 wave 全部步骤 ∈ {done, skipped} | `/wf merge [--wave N]`(若含 reported/waiting-verify 先 verify) |
| 全流程完成 | workflow 所有 wave 已 merged | `/wf goal-check` → approve |

实现:新纯函数 `detectStateChanges(db): NotifyItem[]`(可单测),`NotifyItem = { workflowId, stepId?, kind, text }`。

### 1.2 去重机制(每种事件每步骤只通知一次)

- 用 `workflow_step_metadata` KV(已有 setStepMeta/getStepMeta)记录已通知标记:
  - key = `notify:<kind>`,value = `{ attemptId, at }`。
- 通知前 getStepMeta 检查:key 存在且 `attemptId` 与当前最新 attempt 相同 → 跳过。
- **attemptId 变化(重试后再次失败/回报)→ 重新通知**:同一 attempt 内严格一次,重试后仍能提醒,满足"不重复"且不丢重试提醒。
- wave 级事件用 `workflow_metadata`(已有 setWorkflowMeta/getWorkflowMeta):key = `notify:wave:<seq>:done`。
- check-then-set 在同一 tick 内同步完成(monitor 单进程),幂等;即使异常也不影响下一轮。
- 不随 retry 清除旧 key(靠 attemptId 区分,避免竞态)。

### 1.3 通知通道:pi.sendMessage + followUp + triggerTurn

- 主控侧:扩展运行在主 pi session,调用
  `pi.sendMessage({ customType: "workflow-notify", content, display: true }, { deliverAs: "followUp", triggerTurn: true })`。
  - `deliverAs: "followUp"`:等主控当前工具流/对话结束再投递,**不打断**进行中的工作。
  - `triggerTurn: true`:主控空闲时立即唤醒一轮 → 主控读到通知即自行执行对应 `/wf` 命令,实现"自主推进编排(verify/merge/下发)"。
- 子 pi 会话不启动 monitor(session_start 已按 resolveIdentity 分流,子任务侧只设标题),天然不打扰子任务。
- **聚合防洪泛**:同一 tick 多条通知合并为一条消息(每行一条引导命令);单次最多 5 行,超出留到下一轮。文案格式:`[wf] 步骤 wf-x-1.1 已回报 → 请执行 /wf verify wf-x-1.1 approve`,每条必含具体可执行命令。
- **降级**:sendMessage 抛错时 try/catch 回退 `ctx.ui.notify`(仅 TUI 提示),并继续下一轮。

### 1.4 实现落点

- `src/monitor.ts`:`detectStateChanges`(纯 DB,导出可测);startMonitor 的 tick 中 pollOnce 之后调用,经新 `onState` 回调暴露。
- `src/index.ts`:session_start 启动 monitor 处传 `onState`,内部完成去重标记 + 聚合 + `pi.sendMessage`(抽 `sendWorkflowNotifications(db)` 便于测试)。
- `src/pi-types.d.ts`:补充 `ExtensionAPI.sendMessage(message, options)` / `sendUserMessage` 声明(当前本地类型面没有,需补)。
- 通知与已有 onClosed(aborted 提示)合并:onClosed 场景由状态扫描统一覆盖,保留原 notify 兜底。

---

## ② wf cleanup / wf tabs 工具设计(cli.ts)

两者都是 CLI 子命令(与 /wf 命令族共用 core 逻辑),workflowId 解析复用现有 resolveWorkflowId(显式 id → cwd/仓库推断)。

### 2.1 `wf tabs [workflowId] [--json]` — 查看子任务 tab 状态

行为:
- 列出该 workflow 全部步骤,每行:`<id> [status] tab=<tab_id 前8位|-> 存活=<yes|no> worktree=<name>`。
- 存活判定:复用 `monitor.fetchLiveTabIds`(按 repo 一次 `ghostctl layout --json`,取 terminal id 集合),每仓库一次调用。
- 汇总行:`共 N 步 | 有 tab M | 存活 K | 已关 L`。
- `--json`:输出 `{ steps: [{id,status,tabId,alive,worktree}], summary }` 供脚本/主控读取。
- 退出码 0;无 workflow 时报错退出 1。

### 2.2 `wf cleanup [workflowId] [--dry-run]` — 合并前置自动处理

按序执行(每步先 --dry-run 预览):

1. **关终态 tab**:对 status ∈ {done, skipped} 且 tab_id 存活(布局中存在)的步骤,执行 `ghostctl close-terminal <tab_id>`(用 close-terminal 不用 close-tab,避免切换用户焦点);成功后写事件 `step_tab_closed`(payload 含 `reason: "cleanup"`)、清空该步骤 tab_id。非终态(running/failed/conflict/…)一律不动。
2. **清 .pi-glla**:对每个有 worktree 的步骤,若 `<worktreePath>/.pi-glla` 存在:
   - 路径守卫:仅处理 `<repo>/.worktrees/gittree-*` 下的目录,且只删 `.pi-glla` 单目录(防误删);
   - 跟踪检查:该 worktree 内 `git ls-files .pi-glla` 非空(被误提交)→ 跳过并警告(提示 `git rm -r --cached .pi-glla` 后提交),**不自动改 git 索引**;
   - 未跟踪 → `fs.rmSync(recursive, force)` 删除,计入摘要。
3. **.gitignore 自动修复(合并前置)**:仓库根 .gitignore 缺 `.pi-glla/` → 自动追加一行 + 注释(根治 merge 报错 "untracked working tree files would be overwritten: .pi-glla/");`--no-fix` 可禁用自动修改,仅提示。
4. **未提交改动检查**:对终态步骤的 worktree 跑 `git status --porcelain`(排除 .pi-glla):有改动 → 警告列出文件(不自动 commit,合并权在编排者)。
5. **摘要输出**:`关闭 tab N | 清理 .pi-glla M | .gitignore 追加(是/否) | 警告 K` + 提示"现在可 /wf merge"。

### 2.3 cli.ts 接入

- 新增 `cmdTabs` / `cmdCleanup`;main switch 加 `tabs`、`cleanup`;help 文本同步补两行。
- 复用:fetchLiveTabIds(monitor.ts 已 export)、worktreePath/worktreeName(dispatch.ts)、getStepsByWorkflow/getWorkflow/resolveWorkflowId(已有)、EVT.stepTabClosed、buildUpdate(清 tab_id)。
- 安全:close-terminal 必须显式传 tab_id(ghostctl 安全规则,绝不无目标关闭);所有删除动作 --dry-run 可预览;清 tab_id 用 buildUpdate 单字段更新。
- 可选增强(不阻塞):/wf 命令族同步挂 cleanup/tabs 子命令,复用同一实现。

---

## ③ skill「派发 workflow」章节大纲(SKILL.md)

新增完整流程大章节(置于现有 §2 位置,替换原"执行"小节为以下结构),并同步 §5 排查表 / §6 CLI 列表:

```
## 2. 派发 workflow(完整操作流程)
### 2.1 前置:计划就绪
    /wf plan "<目标>"(推荐,一句话拆解)| plan-init + 手编 plan.json → /wf import
    校验通过提示"已导入 N 个步骤(wave M)";校验失败对照规则排查
### 2.2 首次派发(顶层步骤)
    /wf dispatch 1 [--workflow <id>]
    预期行为:冻结 base_sha → gittree create worktree → 绑定窗口新 tab 开子 pi → pointer 注入
    验证:/wf status 出现 running + tab;错误对照 §5
### 2.3 依赖推进(并行)
    依赖 done 后:/wf dispatch 1.1 1.2(同 wave 并行派发)
    依赖未完成被拒("依赖未完成,先完成:…")的处理
### 2.4 子任务回报(子 pi 侧)
    /wf context / wf done 1.1 '<JSON>' / wf fail 1.1 <原因>;输出契约 JSON 字段
### 2.5 核对(gate 步骤)
    主控收到 monitor 自动通知(§2.9)或 /wf status 发现 waiting-verify
    /wf verify <id> approve|reject <原因>;reject → needs-fix → /wf retry
### 2.6 合并 wave
    前置:先 wf cleanup(关终态 tab + 清 .pi-glla + 修 .gitignore)+ wf tabs 确认
    /wf merge [--wave N];冲突 → wf step 看现场 → 解决 → /wf resolve-conflict → /wf merge
### 2.7 目标把关与下一 wave
    全部合并后 /wf goal-check → approve(completed)| reject(拆 gap wave)
    /wf next → /wf plan --workflow <id> 补步骤 → 回到 2.2
### 2.8 端到端示例(带输出)
    4 步示例(1 planner → 1.1/1.2 并行 workers → 2 reviewer gate):
    完整命令序列 + 每步预期输出一行
### 2.9 主控自主编排(新功能说明)
    monitor 每 5s 检测关键状态 → sendMessage(followUp,不打断)→ 主控自动执行 verify/merge/下发
    去重:每种事件每步骤每 attempt 只通知一次;手动 /wf status 不受影响
```

§5 排查表新增行:
- 「子任务 tab 开了一堆 / 想查 tab 是否还活着」→ `wf tabs`
- 「merge 报 .pi-glla untracked 冲突」→ 先 `wf cleanup`(自动清 .pi-glla + 补 .gitignore);已误提交则 `git rm -r --cached`
- 「终态步骤 tab 未关」→ `wf cleanup`(自动 close-terminal)

§6 CLI 列表补充:
```
wf tabs [workflowId] [--json]    # 子任务 tab 状态(存活判定)
wf cleanup [workflowId] [--dry-run]   # 关终态 tab + 清 .pi-glla + 合并前置修复
```
