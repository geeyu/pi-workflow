## 命令入口

- CLI 本体随 skill 分发:`<skill目录>/bin/wf <cmd> [args]`(node 自动兜底,裸 PATH 可用);已安装环境可全局软链 `~/.local/bin/wf`(可选)
- `/wf <cmd>`(pi 插件内)与 `wf <cmd>`(CLI)共享同一注册表,行为一致
- 退出码契约:`0` 成功 / `1` 业务错误 / `2` 不可达(poll)/ `3` 用法错误

# 命令参考(35 条)

> 由 skill/SKILL.md 拆分,按需加载。

## 2. 命令参考(35 条,按用途分组)

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

**`wf import <plan.json> [--workflow <id>]`**(both)
校验(§4.4)+ 事务落库。通过提示「已导入 N 个步骤(wave M)」。

- 无 `--workflow`:新建 workflow(已存在则拒绝);
- 有 `--workflow <id>`:追加到已有 workflow 的当前 wave(空 workflow 自动建 wave 1;
  主控 agent 在 worktree 内自研拆解后走此路径);终态 workflow 拒绝追加。

```bash
/wf import plan.json
/wf import plan.json --workflow add-redis-cache   # master-agent 模式主控导入
```

**`wf create "<需求目标>" [--repo <path>] [--id <id>] [--title <title>] [--dry-run]`**(both)
创建 **master-agent 模式** workflow(发起方一步创建,立即返回,不阻塞):

1. workflow 落库(running + owner_cwd=发起方)+ mode=master 元数据
2. 基于当前分支创建主控 gittree(`gittree-wf-master-<id>`,--fresh 防残留)
3. 专属窗口(后台创建不抢焦点)开主控 pi tab(`PI_WF_MASTER=<id>` 身份,标题 `wf-master <id>`)
4. 主控会话自主完成:分析→拆解(`/wf plan --workflow <id>` / `wf import --workflow`)→
   派发子任务(子 gittree 基于主控分支)→核对/重试→wave 合并进主控分支→目标把关
5. 全部完成 → awaiting-merge + 通知发起方;发起方 `/wf master-merge <id>` 合并回主分支

```bash
/wf create "给 session store 加 Redis 缓存,登录/登出全量覆盖" --repo ~/server
/wf create "补接口文档" --repo ~/server --id docs-wave2   # 多个 workflow 可同时跑
```

**`wf master-merge <id>`**(both)
发起方决策点:把主控 gittree 分支合并回**当前分支**并清理(gittree merge --delete),
workflow → completed。前置:workflow 状态 = awaiting-merge(主控已完成目标把关)。

```bash
/wf master-merge add-redis-cache
```

**`wf master-fail <id> <原因...>`**(both)
主控无法继续时标记 workflow failed(事件 master_failed),发起方收到通知后人工介入
(接管核对/合并,或确认结束)。主控会话内使用。

```bash
/wf master-fail add-redis-cache "依赖的 SDK 未发布,无法继续"
```

### 2.2 派发与子任务

**`wf dispatch <dotted...> [--workflow <id>] [--dry-run]`**(both)
派发:冻结 base_sha → gittree create worktree → 渲染 task_md 入库 → 开专属窗口/子 tab → pointer 位置参数交付。

- 无参数 = 派发当前 wave 全部就绪步骤(依赖全 done)
- 依赖未完成会被拒绝(「依赖未完成,先完成: …」),按依赖顺序推进
- **专属窗口**:首次派发 ghostctl new-window --no-focus 创建 workflow 专属窗口并绑定 id
  (绝不借用用户焦点窗口;绑定窗口关闭报错,`/wf rebind-window` 重建)
- **顺序开 tab**:每次 new-tab --at-end(先切窗口末尾再建,子任务 tab 按派发顺序排尾)
- **不抢焦点**:new-window/new-tab 均 --no-focus(创建后恢复原终端焦点)
- **pointer 交付**:pi 位置参数 `pi '<pointer>'`(pi 启动后自动发送为首条消息,零注入/盲等/回车)

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
workflow 专属窗口已关闭时,把当前焦点窗口设为绑定窗口(解除「绑定窗口已关闭」死锁)。

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
