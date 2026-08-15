# pi-workflow

pi 编排插件:**主 pi 为调度者**,把大计划迭代式拆成并行/串行批次;每个子任务 = 一个 gittree worktree + 一个 Ghostty tab(可见、可干预),全生命周期事件落 SQLite(`~/.pi/agent/workflows/workflow.db`)。

设计文档:[`DESIGN.md`](./DESIGN.md)(含完整 schema 与决策记录)

## 安装

```bash
# 方式一:克隆到 pi 扩展目录(自动发现)
git clone https://github.com/geeyu/pi-workflow ~/.pi/agent/extensions/workflow
# 方式二:作为 pi 包安装
pi install git:github.com/geeyu/pi-workflow
```

依赖:`node:sqlite`(Node 22 内置)+ gittree + ghostctl(`~/.local/bin/`)。

## 技能与辅助脚本

- **skill**:`skill/SKILL.md`(自动注册,`/skill:workflow` 或按需触发)—— 创建/执行/子任务/核对/**排查手册**(§5 常见问题对照表 + SQL 查询列名速查 + 重置)+ **§4.6 双入口命令矩阵**。
- **CLI**:`bin/wf`(已软链 `~/.local/bin/wf`)—— 不依赖 pi 交互的创建/执行/排查;node 自动兑底(WF_NODE→PATH→fnm→brew),裸 PATH 可用:

```bash
wf doctor               # 环境自检(node/gittree/ghostctl/python3/DB)
wf plan-init <name> "<目标>" [--repo <path>]   # 生成 plan.json 模板
wf import plan.json     # 校验 + 落库
wf plan "<目标>"         # planner agent 自动拆解
wf status [--json]      # 状态全景
wf tree / wf step <id> / wf context <id>   # 任务树 / 单步详情 / 任务正文
wf events [--follow]    # 审计流
wf dispatch <dotted...> [--dry-run]  # 派发(无头)
wf verify <id> approve|reject / wf done <id> '<JSON>' / wf fail <id> <原因>
wf merge / wf retry <id> [--fresh] / wf skip <id> <原因> / wf goal-check --workflow <id> approve
wf inject <target> <text...> / wf poll / wf session / wf open-tab / wf fix-tab
wf tabs / wf cleanup / wf clean / wf debug     # 排查/清理
```

全部 32 条命令清单与双入口差异见 skill/SKILL.md §4.6。

## 文件结构

```text
src/
├── index.ts        # pi 插件入口:命令查注册表 + footer 状态条 + 生命周期
├── cli.ts          # CLI 适配器(bin/wf 入口),与插件共享命令注册表
├── command.ts      # ★ 命令注册表:32 条 CommandDef 双入口共享
├── core/           # db.ts(SQLite repository)+ state.ts(图标/状态机迁移表单一来源)
├── exec/           # dispatch.ts(派发/重试/去重)+ shell.ts(进程)+ window.ts(Ghostty)+ template.ts(任务渲染)
├── observe/        # monitor.ts(存活轮询/事件检测)+ wave.ts(wave 合并)
├── ui/             # status.ts(footer 状态条)+ notify.ts(主控通知)+ board.ts(看板)
├── orchestrator.ts # 核心流程:importPlan / reportDone / verifyStep / goal-check(纯逻辑,可测)
├── planner.ts      # planner agent(headless)自动拆解
├── validate.ts     # 计划 JSON 校验(层级点号 id / agent / deps 无环)
├── agents.ts       # agent 发现(~/.pi/agent/agents/*.md,frontmatter 格式,零依赖)
└── session.ts      # 主控会话 jsonl 解析
skill/SKILL.md      # 使用与排查手册(自动注册)
bin/wf              # CLI 入口(软链 ~/.local/bin/wf)
test/workflow.test.ts # 验收测试(T1-T25b,276 断言)
```

## 使用(编排者侧,仓库根目录)

```text
/wf import plan.json             导入计划(JSON:workflow + steps,见下)
/wf dispatch 1.1 1.2 [--dry-run] 派发步骤:建 worktree + 开 tab + 任务写库
/wf status / /wf tree           全景 / 层级任务树(widget 显示)
/wf step <id> / /wf events      单步详情(含 attempts)/ 审计流
/wf verify <id> [approve|reject <原因>]  期望核对(gate 执行后更新)
```

## 使用(子任务侧,子 pi tab 内)

```text
/wf context                      从 DB 读任务详情(派发时只注入短指引)
/wf done 1.1 '{"summary":"...","filesChanged":[...],"issues":[...],"tests":"passed"}'
/wf fail 1.1 <原因>
```

身份解析:环境变量 `PI_WF_WORKFLOW` / `PI_WF_STEP`(派发时注入),兜底解析 cwd worktree 路径。

## plan.json 格式

```json
{
  "name": "add-redis-cache",
  "title": "加 Redis 缓存",
  "goal": "给 session store 加 Redis 缓存,登录/登出全量覆盖",
  "steps": [
    { "id": "1", "title": "输出方案", "agent": "planner",
      "task": "分析认证模块,输出方案" },
    { "id": "1.1", "title": "认证接入缓存", "agent": "worker", "deps": ["1"],
      "task": "按 {{steps.1.summary}} 实现", "expectations": ["登录后写入缓存"] },
    { "id": "2", "title": "整体评审", "agent": "reviewer",
      "deps": ["1.1", "1.2"], "gate": true }
  ]
}
```

- id 为层级点号(1、1.1、1.2.3),父子由前缀推导;
- agent 必须存在于 `~/.pi/agent/agents/*.md`(planner/worker/reviewer 已内置);
- `gate: true` = 回报后必须 `/wf verify` 才能进合并。

## 测试

```bash
cd ~/.pi/agent/extensions/workflow
npm test
# 或直接:
node --experimental-strip-types test/workflow.test.ts
```

(测试用临时库 + 临时 git 仓库,真建 worktree,fake ghostctl,不碰真实环境。)

## 状态

- P1 派发闭环 ✅(db + import + dispatch + context/done/fail + verify + status/tree/step/events)
- P2 监听与批次 ✅(monitor.ts:tab 存活轮询 5s + 消失→aborted + 崩溃恢复 + 就绪集派发 + wave 串行 merge)
- P3 期望核对 ✅(retry 上下文注入 + max_retries + steer + resolve-conflict + usage 自报 + 预算护栏 + 超时检查)
- P4 智能编排 ✅(/wf plan 自动拆解 + goal-check 目标把关 + /wf next wave 滚动 + /wf resume)
- P5 看板 ✅(/wf board 终端列看板 + --html 单文件导出;思源同步规划中,见设计文档 §8.2)

### P5 新增用法

```text
/wf board [workflowId] [--wave N] [--html out.html]
    # 终端 5 列看板(待办/进行中/待核对/完成/异常,层级缩进 + 摘要)
    # --html:导出单文件静态 HTML(浏览器打开/分享)
wf board [workflowId] [--wave N] [--html out.html]   # CLI 同款
```

### P4 新增用法

```text
/wf plan "<需求目标>" [--repo <path>] [--workflow <id>] [--dry-run]
    # planner agent(headless 子进程)自动拆解:无 --workflow = 新建 workflow;
    # 有 --workflow = 给当前 wave 追加步骤(gap wave)
/wf goal-check [approve|reject <原因>]   # 目标把关:进入 verifying → approve=completed / reject=拆 gap wave
/wf next [--note <说明>]                 # wave 滚动:创建 wave N+1 并更新 current_wave
/wf resume                               # paused → running(预算超限暂停后恢复)
wf plan / wf goal-check / wf next        # CLI 同款
```

### P3 新增用法

```text
/wf retry <id> [--fresh]              # 重派 failed/aborted/needs-fix(自动注入上次失败原因)
/wf steer <dotted> <文本>             # 向子任务 tab 注入指令
/wf resolve-conflict <dotted>         # 冲突解决后确认,继续 /wf merge
wf retry <id> [--fresh]               # CLI 同款
```

- 子 agent 可在 `/wf done` 里带 `usage: {input, output, costCents, turns}` 自报成本 → 预算护栏生效
- 预算超限自动暂停;单步 `timeout_min` 超时自动 aborted;`max_retries` 防无限重试

### P2 新增用法

```text
/wf dispatch                    # 无参数 = 派发当前 wave 全部就绪步骤(依赖全 done)
/wf merge [--wave N]            # wave 全部终态后串行合回主分支(冲突→conflict)
wf merge [--wave N]             # CLI 同款
```

- 子任务 tab 被关闭且未回报 → monitor 自动标 aborted 并通知(5s 内)
- 编排者 pi 重启 → session_start 崩溃恢复:tab 已消失的步骤标 aborted
