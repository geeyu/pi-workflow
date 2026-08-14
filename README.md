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

## 文件结构

```text
src/
├── index.ts        # /wf 命令族 + widget + 子 pi 身份绑定(标题)
├── db.ts           # node:sqlite 封装:schema 迁移(user_version)、读写、事件双写
├── orchestrator.ts # 核心流程:importPlan / reportDone / reportFail / verifyStep(纯逻辑,可测)
├── dispatch.ts     # 派发:gittree create + task_md 渲染入库 + 短指引 + ghostctl new-tab
├── validate.ts     # 计划 JSON 校验(层级点号 id / agent / deps 无环)+ packDotted
└── agents.ts       # agent 发现(~/.pi/agent/agents/*.md,frontmatter 格式,零依赖)
test/
└── workflow.test.ts # P1 验收测试(71 断言)
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
- P2 监听与批次(monitor.ts:ghostctl 轮询 + wave 推进 + merge) — 待实施
- P3-P5 见设计文档 §11
