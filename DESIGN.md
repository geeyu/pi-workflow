# pi workflow 插件 — 设计文档 v5(编排者 + 可见子任务 tab + 层级化任务 id)

> 状态:设计稿 v5;待确认后进入 P1 实施
> 目标:一套 pi 扩展,以**主 pi 为调度者**,把大计划迭代式拆成并行/串行批次;每个子任务 = 一个 gittree worktree + 一个 Ghostty tab(可见、可干预、任务存库自主发挥),全生命周期事件落 SQLite,可查询、可追溯、可做看板;**工作流结束前必须核对最初目标已全部完成**。

---

## 1. 背景与目标

### 1.1 核心流程(用户定义)

```text
主任务(编排者,主 pi 窗口):
  1. 输入本次需求目标
  2. 了解仓库上下文
  3. 生成 workflow 计划
  4. 调度创建子任务(任务写库 → 子 agent 自主发挥)
  5. 核对子任务回报(执行前设定期望,执行后更新)
  6. 根据情况拆分并行/串行任务;合并冲突完之后,再继续拆分新任务(迭代式批次)
  7. 全部合并完成后,核对最初目标已全部完成,才允许 workflow 结束
```

### 1.2 关键机制(已确认)

| 机制 | 方案 |
| --- | --- |
| 存储 | SQLite 唯一事实源,全局单库 `~/.pi/agent/workflows/workflow.db`,`node:sqlite` 零依赖 |
| 任务 id | **层级化点号 id**(`1`、`1.1`、`1.2.3`),层级即 id 前缀,worktree 命名 `wf-<workflow>-<dotted>` |
| gate | **执行前设定(期望/验收标准),执行后更新(子任务回报 → 编排者核对)** |
| worktree | 每步一个,`gittree create wf-<workflow>-<step>`,并行任务同 base_sha |
| 子任务形态 | 可见交互式子 pi,`ghostctl new-tab --window-id <绑定窗口> --cwd <worktree> --command "pi" --input <短指引>`,一个任务一个 tab |
| 任务传递 | **任务 markdown 写入数据库**(workflow_steps.task_md,派发时冻结副本入 workflow_attempts.task_md),`--input` 只注入短指引(身份 + 指向 `/wf context`),杜绝长文本粘贴错乱 |
| 上下文 | **不复用父会话**:新会话,子 agent 在 worktree 内自主探索、自己发挥 |
| 完成回报 | 子 pi 内 `/wf done <stepId> <JSON>` 写库;监听端轮询 `ghostctl layout --json` 按 tab 标题感知存活 |
| 迭代批次 | wave 内并行/串行组合;wave 全部终态 → 串行 merge → 冲突解决 → 继续拆下一 wave |
| 目标把关 | 最后 wave 合并后,编排者核对最初 goal 全部达成才置 completed,否则拆 gap wave 补齐 |

### 1.3 与现有积木的关系

| 积木 | 用途 | 本插件怎么用 |
| --- | --- | --- |
| `gittree` 插件 | worktree 创建/合并/清理/占用检测 | `gittree create/merge/clean` 照用 |
| `ghostctl` | Ghostty 布局查询/建 tab/关 tab/输入 | 派发开 tab(`new-tab --window-id --cwd --command --input`)、监听轮询、steer 注入文本 |
| `ghostty-fork` 扩展(`/fork-split`) | 分屏开子 pi 复用当前会话 | 可作为手动替代路径(用户想复用上下文时手动用) |
| 官方 `subagent` 示例 | 无头子进程方案 | 保留为可选的 headless 模式(§5 决策 8,未实现),不阻塞主路线 |
| `ctx.ui.setTitle` / 环境变量(PI_WF_*) | 设置终端标题 / 传递身份 | 子 pi 身份绑定:标题供监听匹配,env 供 /wf context 定位任务 |
| `~/.pi/agent/agents/*.md` | agent 定义(model/tools/system prompt) | 原样复用 |
| 内置 `/goal` `/list` `/loop` | 单线编排 | 并行批次之外可用 |

---

## 2. 总体架构

```text
workflow/(本仓库,pi 扩展自动发现 src/index.ts)
├── src/
│   ├── index.ts        # 入口:/wf 命令查注册表 + footer 状态条 + 生命周期(monitor 启停)
│   ├── cli.ts          # CLI 适配器:main 查注册表,统一退出码(0/1/2/3);bin/wf 入口
│   ├── command.ts      # ★ 命令注册表:32 条 CommandDef 双入口共享(见 §9.1)
│   ├── core/
│   │   ├── db.ts           # node:sqlite 封装:schema 迁移、读写、事件写入
│   │   └── state.ts        # ★ STATUS_ICON 单一来源 + 状态机迁移表(STEP/WORKFLOW_TRANSITIONS)
│   ├── exec/
│   │   ├── dispatch.ts     # 派发流程(dispatchStep/重试/去重复用/tab 存活检测)
│   │   ├── shell.ts        # run/resolveBin/piInvocation(进程与二进制解析)
│   │   ├── window.ts       # Ghostty:绑定窗口/开 tab/terminal 反查/注入
│   │   └── template.ts     # 任务 markdown 渲染 + 依赖结果模板注入
│   ├── observe/
│   │   ├── monitor.ts      # 存活轮询(5s)+ 状态事件检测 + 崩溃恢复
│   │   └── wave.ts         # wave 串行合并(mergeWave)
│   ├── ui/
│   │   ├── status.ts       # footer 状态条渲染(setStatus,powerline 兼容)
│   │   ├── notify.ts       # 主控自主编排通知(sendMessage followUp)
│   │   └── board.ts        # 看板构建/文本/HTML 渲染
│   ├── orchestrator.ts # 编排流程:import→report→verify→goal-check→next(纯逻辑,可测)
│   ├── planner.ts      # headless planner agent 自动拆解
│   ├── validate.ts     # 计划 JSON 校验(层级 id、agent 存在、deps 无环、期望格式)
│   ├── agents.ts       # agent 发现(零依赖,frontmatter 解析)
│   └── session.ts      # 主控 pi 会话 jsonl 解析(供 wf session)
├── skill/
│   └── SKILL.md        # 使用与排查手册(经 resources_discover 自动注册)
├── bin/
│   └── wf              # CLI 入口(node 自动兜底:WF_NODE→PATH→fnm→brew)
├── test/
│   └── workflow.test.ts # 验收测试(T1-T25b,276 断言)
├── docs/               # 设计/评审记录(arch-review/arch-refactor/review-arch 等)
├── DESIGN.md           # 本设计文档
├── README.md           # 使用说明
└── package.json        # pi.extensions 入口声明 + npm test
```

运行时形态:

```text
┌─ 主 pi(编排者)─────────────────────────────────────────────┐
│  1. /wf import plan.json / /wf plan "<需求目标>"            │
│  2. 了解仓库上下文(主 agent 探索,摘要入库)                    │
│  3. /wf plan → planner 生成计划 JSON(层级 id)→ 校验 → 落库   │
│  4. /wf dispatch 1.1 1.2 ──┐                                 │
│                           ▼                                 │
│  ┌─ Ghostty: 主 tab ──┬─ tab: wf A/1.1 ────┬─ tab: wf A/1.2 ─┐
│  │  编排者(widget 实时) │  子 pi:worktree 1.1│  子 pi:worktree 1.2│
│  │  监听 ghostctl 轮询  │  任务存库自主发挥   │  任务存库自主发挥  │
│  │                     │  完成→ /wf done 写库│  完成→ /wf done 写库│
│  └─────────────────────┴────────────────────┴──────────────────┘
│  5. tab 消失未回报 → aborted;回报 → reported → 核对期望 → done/needs-fix
│  6. wave 全部终态 → /wf merge(串行)→ 冲突解决 → /wf next 拆下一批
│  7. 全部 wave 完成 → /wf goal-check:核对最初目标达成 → completed
└──────────────────────────────────────────────────────────────┘
        ▲ 全部状态/事件写 ▼
  SQLite: ~/.pi/agent/workflows/workflow.db
```

---

## 3. 数据模型(SQLite schema)

### 3.1 命名约定(统一规范)

| 类型 | 规则 | 示例 |
| --- | --- | --- |
| 实体表 | 域前缀 `workflow_` + 复数名词;主表用单数 `workflow`(避免 workflow_workflows 冗余) | workflow / workflow_waves / workflow_steps / workflow_attempts / workflow_events / workflow_agents / workflow_goal_items |
| 关系表 | 域前缀 + 双方实体 `_` 连接 | workflow_step_deps |
| 附属表 | 域前缀 + 宿主实体 + `_metadata` | workflow_metadata(workflow 表的附属)/ workflow_step_metadata |
| 视图 | `v_` 前缀 | v_workflow_kanban / v_workflow_cost |
| 索引 | `idx_<表>_<列>_<列>`,全称 | idx_workflow_steps_workflow_status |

- metadata 保持两张而非合并成一张带 scope 的多态表:保留对 workflow / workflow_steps 的**真实外键与 ON DELETE CASCADE**(多态外键会失去级联删除);未来若需 wave 级扩展,直接加 workflow_wave_metadata(零迁移);
- 列名同样全称 snake_case(允许 md/seq/id 等通用缩写,如 task_md / wave_id / tab_id)。

### 3.2 连接与迁移

- 全局单库 `~/.pi/agent/workflows/workflow.db`;`DatabaseSync` 单连接,`PRAGMA journal_mode=WAL` + `busy_timeout=5000` + `foreign_keys=ON`;
- `PRAGMA user_version` 管理迁移,顺序执行、只追加,禁止修改已发布的表结构。

### 3.3 层级化任务 id(用户决策 1)

- `workflow_steps.id` = `<workflowId>-<dotted>`,`dotted` 形如 `1`、`1.1`、`1.2.3`(`^[0-9]+(\.[0-9]+)*$`);
- **父子关系由 id 前缀推导**:`1.1` 的父 = `1`,`1.2.3` 的父 = `1.2`;`parent_id` 列由校验层自动推导写入,`/wf tree` 按前缀天然成树;
- 排序:`sort_order` 按点号路径数值编码(1 < 1.1 < 1.2 < 2),`ORDER BY sort_order` 即层级序;
- worktree/分支名含点号合法(git 允许,只要不以点结尾),tab 标题 `wf <workflow>/<step>` 直接展示层级;
- deps 引用用完整 id(如 `1.1` 依赖 `1` 或 `2.3`),跨层级依赖允许。

### 3.4 DDL(10 表 + 2 视图)

```sql
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
PRAGMA foreign_keys=ON;

-- ─────────────────────────────────────────────────────
-- 1. workflow:一次大计划的执行单元(主表单数,避免 workflow_workflows 冗余)
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workflow (
  id            TEXT PRIMARY KEY,             -- kebab-case,如 add-redis-cache
  title         TEXT NOT NULL,
  goal          TEXT NOT NULL,                -- 需求目标 markdown(结束前必须核对达成)
  context       TEXT,                         -- 仓库上下文摘要(编排者 recon 产出,planner 用)
  description   TEXT NOT NULL DEFAULT '',
  repo_path     TEXT NOT NULL,                -- 仓库根
  base_sha      TEXT,                         -- 首次派发时冻结的 HEAD
  status        TEXT NOT NULL DEFAULT 'idle',
      -- idle|running|paused|verifying|completed|failed|aborted
  current_wave  INTEGER NOT NULL DEFAULT 0,   -- 冗余:widget/看板快速取当前批次
  concurrency   INTEGER NOT NULL DEFAULT 4,
  budget_cents  INTEGER,                      -- 成本上限(美分),NULL=不限
  max_steps     INTEGER NOT NULL DEFAULT 50,
  goal_check    TEXT,                         -- JSON {result, reason, checkedAt}
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  started_at    INTEGER,
  completed_at  INTEGER
);

-- ─────────────────────────────────────────────────────
-- 2. workflow_goal_items:最初目标拆成可逐条勾验的条目(决策 3 抓手)
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workflow_goal_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id  TEXT NOT NULL REFERENCES workflow(id) ON DELETE CASCADE,
  text         TEXT NOT NULL,                 -- 目标条目
  status       TEXT NOT NULL DEFAULT 'pending', -- pending|done|failed
  evidence     TEXT,                          -- 达成证据:步骤 id / commit / 测试结果
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  checked_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_workflow_goal_items_workflow_status ON workflow_goal_items(workflow_id, status);

-- ─────────────────────────────────────────────────────
-- 3. workflow_waves:批次实体化(迭代拆分,有自己的状态/备注/合并结果)
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workflow_waves (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id  TEXT NOT NULL REFERENCES workflow(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,              -- 批次号 1,2,3...
  status       TEXT NOT NULL DEFAULT 'planned',
      -- planned|dispatching|running|merging|merged|verified
  note         TEXT,                          -- 编排者备注:为什么拆这批
  merge_result TEXT,                          -- JSON {merged:[], conflicts:[], at}
  created_at   INTEGER NOT NULL,
  started_at   INTEGER,
  merged_at    INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_waves_workflow_seq ON workflow_waves(workflow_id, seq);

-- ─────────────────────────────────────────────────────
-- 4. workflow_steps:任务/子任务(层级点号 id)
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workflow_steps (
  id             TEXT PRIMARY KEY,            -- <workflowId>-<dotted>:add-redis-cache-1.1
  workflow_id    TEXT NOT NULL REFERENCES workflow(id) ON DELETE CASCADE,
  parent_id      TEXT REFERENCES workflow_steps(id),   -- 由 id 前缀自动推导(1.1 → 1)
  wave_id        INTEGER REFERENCES workflow_waves(id),
  title          TEXT NOT NULL,
  agent          TEXT NOT NULL,               -- 引用 workflow_agents.name
  status         TEXT NOT NULL DEFAULT 'pending',
      -- pending|ready|dispatched|running|reported|waiting-verify|done|failed|aborted|conflict|skipped|needs-fix
  gate           INTEGER NOT NULL DEFAULT 0,  -- 核对为硬性 gate 时为 1(reported 后必须经 /wf verify)
  expectations   TEXT,                        -- JSON 数组:执行前设定的期望/验收标准
  task_md        TEXT NOT NULL,               -- 任务 markdown(存库,子 agent 经 /wf context 读取)
  report         TEXT,                        -- JSON:执行后回报(子 agent 经 /wf done 写入)
  summary        TEXT,                        -- 回报 JSON 的 summary(冗余,便于 SELECT)
  files_changed  TEXT,                        -- JSON 数组
  issues         TEXT,                        -- JSON 数组:遗留问题
  tests          TEXT,                        -- passed|failed|none
  error          TEXT,
  worktree       TEXT,                        -- wf-<workflowId>-<dotted>
  tab_id         TEXT,                        -- 最近派发的 Ghostty tab id(监听匹配)
  retries_done   INTEGER NOT NULL DEFAULT 0,
  max_retries    INTEGER NOT NULL DEFAULT 1,
  timeout_min    INTEGER NOT NULL DEFAULT 60,
  usage_input    INTEGER, usage_output INTEGER,   -- 汇总(明细在 workflow_attempts)
  usage_cost_cents INTEGER, usage_turns INTEGER,
  sort_order     INTEGER NOT NULL DEFAULT 0,  -- 点号路径数值编码 → 层级序
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  started_at     INTEGER,
  finished_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_workflow_steps_workflow_status ON workflow_steps(workflow_id, status);
CREATE INDEX IF NOT EXISTS idx_workflow_steps_wave_id          ON workflow_steps(wave_id);
CREATE INDEX IF NOT EXISTS idx_workflow_steps_parent_id        ON workflow_steps(parent_id);
CREATE INDEX IF NOT EXISTS idx_workflow_steps_workflow_sort    ON workflow_steps(workflow_id, sort_order);

-- ─────────────────────────────────────────────────────
-- 5. workflow_step_deps:DAG 依赖边(同 wave 内调度并行/串行)
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workflow_step_deps (
  step_id    TEXT NOT NULL REFERENCES workflow_steps(id) ON DELETE CASCADE,
  dep_id     TEXT NOT NULL REFERENCES workflow_steps(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (step_id, dep_id)
);

-- ─────────────────────────────────────────────────────
-- 6. workflow_attempts:每次派发一行,冻结任务版本(重试全程可追溯)
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workflow_attempts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  step_id     TEXT NOT NULL REFERENCES workflow_steps(id) ON DELETE CASCADE,
  attempt_no  INTEGER NOT NULL,               -- 1,2,3...
  status      TEXT NOT NULL,                  -- running|reported|done|failed|aborted
  task_md     TEXT,                           -- 派发时冻结的任务 markdown(版本可追溯)
  pointer     TEXT,                           -- 注入子 pi 的短指引消息
  report      TEXT,
  stderr      TEXT,
  model       TEXT,
  tab_id      TEXT,
  usage_input INTEGER, usage_output INTEGER,
  usage_cost_cents INTEGER, usage_turns INTEGER,
  error       TEXT,
  started_at  INTEGER,
  finished_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_attempts_step_attempt ON workflow_attempts(step_id, attempt_no);

-- ─────────────────────────────────────────────────────
-- 7. workflow_events:审计流(只增不改),挂 wave/step/attempt 三维
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workflow_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id TEXT NOT NULL REFERENCES workflow(id) ON DELETE CASCADE,
  wave_id     INTEGER REFERENCES workflow_waves(id),
  step_id     TEXT REFERENCES workflow_steps(id),
  attempt_id  INTEGER REFERENCES workflow_attempts(id),
  type        TEXT NOT NULL,
  -- workflow_created|workflow_started|workflow_paused|workflow_resumed|workflow_completed|workflow_failed|workflow_aborted
  -- workflow_goal_check_started|workflow_goal_check_passed|workflow_goal_check_failed
  -- wave_started|wave_completed|wave_merged
  -- step_created|step_decomposed|step_dispatched|step_tab_opened|step_tab_closed|step_reported|step_verified|step_needs_fix
  -- step_failed|step_retrying|step_aborted|step_skipped|step_conflict|step_resolved
  -- worktree_created|worktree_merged|worktree_cleaned|merge_conflict|merge_resolved
  payload     TEXT,                           -- JSON:{tabId, exitCode, report, ...}
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workflow_events_workflow_created ON workflow_events(workflow_id, created_at);
CREATE INDEX IF NOT EXISTS idx_workflow_events_step_created     ON workflow_events(step_id, created_at);
CREATE INDEX IF NOT EXISTS idx_workflow_events_type_created     ON workflow_events(type, created_at);
CREATE INDEX IF NOT EXISTS idx_workflow_events_wave_created     ON workflow_events(wave_id);

-- ─────────────────────────────────────────────────────
-- 8. workflow_agents:agent 注册表(目录 + 快照,历史可解释)
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workflow_agents (
  name          TEXT PRIMARY KEY,
  description   TEXT,
  model         TEXT,
  tools         TEXT,                         -- JSON 数组
  system_prompt TEXT,
  prompt_hash   TEXT,                         -- 内容哈希:agent 文件变更后历史仍可解释
  source        TEXT NOT NULL DEFAULT 'user', -- user|project
  file_path     TEXT,
  updated_at    INTEGER NOT NULL
);

-- ─────────────────────────────────────────────────────
-- 9/10. workflow_metadata / workflow_step_metadata:通用扩展点 KV
--       (标签/优先级/看板分组/外部同步位点)
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workflow_metadata (
  workflow_id TEXT NOT NULL REFERENCES workflow(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  value       TEXT,                           -- JSON
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (workflow_id, key)
);
CREATE TABLE IF NOT EXISTS workflow_step_metadata (
  step_id     TEXT NOT NULL REFERENCES workflow_steps(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  value       TEXT,                           -- JSON
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (step_id, key)
);

-- ─────────────────────────────────────────────────────
-- 预置视图(可用性):看板 / 成本
-- ─────────────────────────────────────────────────────
CREATE VIEW IF NOT EXISTS v_workflow_kanban AS
SELECT s.workflow_id, s.id, s.parent_id, s.wave_id, s.title, s.status,
       s.agent, s.gate, s.sort_order, s.started_at, s.finished_at,
       w.title AS workflow_title, w.status AS workflow_status
FROM workflow_steps s JOIN workflow w ON w.id = s.workflow_id;

CREATE VIEW IF NOT EXISTS v_workflow_cost AS
SELECT a.step_id, s.workflow_id,
       SUM(a.usage_cost_cents) AS cost_cents,
       SUM(a.usage_turns)      AS turns,
       COUNT(*)                AS attempts
FROM workflow_attempts a JOIN workflow_steps s ON s.id = a.step_id
GROUP BY a.step_id;
```

### 3.5 设计要点

- **任务/子任务层级** = 点号 id 前缀(用户决策 1);**迭代批次** = `workflow_waves` 表;**DAG 依赖** = `workflow_step_deps`(三者各管一维:归属展示 / 批次 / 调度顺序);
- **gate 前后对照落在字段上**:`expectations`(执行前设定)→ `report`(执行后回报)→ 核对 → `done` / `needs-fix`(事件 `step_verified` / `step_needs_fix`);
- **任务 markdown 存库**(用户决策 11):`workflow_steps.task_md` 为当前版本,`workflow_attempts.task_md` 为每次派发的冻结副本;
- **目标把关落在两张表**:`workflow.status=verifying` + `goal_check` 总结果 + `workflow_goal_items` 逐条勾验,未达成则回到 running 拆 gap wave;
- **一次派发一行 workflow_attempts**:每次开 tab 都记一行,换 tab 重试不覆盖历史;usage 明细在 workflow_attempts,汇总在 workflow_steps;
- **workflow_events 只增不改**:tab 打开/关闭、回报、核对、目标检查、合并冲突全部留痕;子 pi 与编排者共享同一扩展与同一库,`/wf done` 直接写。

### 3.6 扩展性设计原则

1. **状态与事件类型是 TEXT 约定值,不是 CHECK 约束** → 未来新增状态/事件类型零迁移;
2. **开放字段一律 JSON 列**(expectations/report/files_changed/issues/payload/merge_result/evidence)→ 结构演进零迁移,`json_each()` 可查询;
3. **workflow_metadata / workflow_step_metadata 通用 KV 表**兜底任意自定义字段(标签、优先级、看板分组、外部同步位点)→ 加字段不改表;
4. **workflow_agents 表 = 目录 + 快照**:`prompt_hash` 让历史步骤的 agent 语义可还原;planner 直接查目录选 agent;
5. **workflow_attempts 冻结 task_md / pointer** → 任务文本版本可追溯,重试可对比;
6. **workflow_events 挂 wave_id / step_id / attempt_id 三维** → 任意维度审计与追溯(未来推思源可按事件流增量同步);
7. **workflow_waves 独立表** → 批次级状态/合并结果/备注,迭代拆分实体化;
8. **workflow_goal_items 独立表** → 目标逐条勾验 + 证据(决策 3 可执行);
9. **迁移只追加**:`PRAGMA user_version` 顺序执行,禁止修改已发布表;
10. **外键 ON DELETE CASCADE + WAL** → 清理安全、编排者/子 pi/外部工具并发读写安全。

### 3.7 可用性设计原则

1. **全部核心查询走索引**:状态分布、wave 分布、running 列表、事件时间线、层级序各一条索引;
2. **预置视图**:`v_workflow_kanban`(看板)、`v_workflow_cost`(按步成本,含全部重试)→ 看板/报表直接 SELECT,不写 JOIN;
3. **时间字段齐全**(created/updated/started/finished/merged/checked)→ 时间线、看板排序、成本统计不缺素材;
4. **sort_order 层级数值编码** → `/wf tree` 一条 ORDER BY 出树,无需递归 CTE;
5. **单库单连接 + WAL + busy_timeout** → 编排者、子 pi、sqlite3 CLI、data-fetcher 并发读写安全;
6. **双写一致性**:workflow_steps.status 变更必配一条 workflow_events → 任何时刻可重建完整时间线,恢复/看板/审计同一套数据。

---

## 4. 状态机

### 4.1 步骤状态(存 `workflow_steps.status`)

```text
pending ──(依赖全 done)──► ready ──(/wf dispatch)──► dispatched ──(tab 已开,子 pi 就绪)──► running
running ──(子 pi 调 /wf done)──► reported ──(编排者核对期望)──► done
                                              └──(不达标)──► needs-fix ──(/wf dispatch 重派)──► running
running ──(tab 消失未回报)──► aborted ──(/wf retry 重派 / 人工确认 done)
running ──(超时)──► aborted
reported ──(gate=1 需人工)──► waiting-verify ──(/wf verify approve|reject)──► done | needs-fix
人工:任意非终态 ──(/wf skip [reason])──► skipped(后续步骤视其为 done)
merge 冲突 ──► conflict ──(人工解决)──► /wf resolve-conflict ──► (wave 合并继续)
```

### 4.2 工作流状态(存 `workflow.status`)

```text
idle ──(import/plan 后首派发)──► running ──(全部 wave 合并完成)──► verifying ──(目标核对通过)──► completed
                     │                                └──(未达成)──► running(拆 gap wave 补齐)
                     │  ├──(/wf pause / 预算超)──► paused ──(/wf resume)──► running
                     │  ├──(不可恢复失败)──► failed(修复后 /wf retry 或重跑)
                     │  ├──(/wf abort)──► aborted
                     │  └──(wave 合并冲突待人工)──► paused(停在 merge 步骤)
```

### 4.3 批次(wave)推进(迭代拆分,用户需求第 6 条)

```text
wave N 拆解(并行/串行组合,视依赖而定)
  → 全部 dispatch → 监听直至 wave 内步骤全部终态
  → /wf merge:按 sort_order(层级序)串行 gittree merge,冲突 → conflict → resolve
  → wave N 合并完成(事件 wave_merged)
  → 编排者评估:继续 /wf next 拆 wave N+1(可含"合并后验证/重构"类新任务)
```

并行/串行判定:无依赖边(workflow_step_deps 为空)且 agent 为 worker 类 → 并行;有依赖或涉及共享文件(编排者评估)→ 串行。

### 4.4 目标完成度把关(用户决策 3)

```text
最后 wave 合并完成后,workflow 进入 verifying:
  编排者核对最初 goal 是否全部达成,依据:
    - workflow_goal_items 逐条勾验(evidence 关联步骤 id / commit / 测试结果)
    - 全部步骤的 summary / files_changed / issues / tests(DB)
    - 合并后的仓库实际状态(git log / diff / 测试,主 agent 亲验)
    - 必要时派 reviewer agent 或请用户确认(/wf goal-check)
  达成 → 事件 workflow_goal_check_passed → completed
  未达成 → 事件 workflow_goal_check_failed → 回到 running,把缺口拆成 gap wave 继续
```

### 4.5 崩溃恢复

- 编排者重启:`session_start` 时读 DB,对 `running`/`dispatched` 步骤**按 tab_id 向 ghostctl 查存活**:tab 还在 → 恢复 running;tab 没了 → aborted(可重派);
- 子 pi 崩溃:tab 关闭 → 监听发现 → aborted;
- 一切可恢复性来自 DB,扩展进程不存关键状态(可 `/reload`)。

---

## 5. 关键设计决策

**1. 编排者是主 pi 的主 agent,不是无头守护进程**:编排流程(1 目标 → 2 recon → 3 plan → 4 dispatch → 5 核对 → 6 迭代 → 7 目标把关)由主 agent 借助 `workflow` 工具与 `/wf` 命令推进;插件只提供原语(落库、派发、监听、核对、合并),不抢主 agent 的决策权 —— 这保证"根据情况拆分并行/串行"的灵活性。
**2. 子任务可见、可干预**:每个子任务是交互式子 pi 的 Ghostty tab(非无头进程),用户肉眼可见处理情况、可随时切过去 steer;标题统一 `wf <workflow>/<dotted>`(子 pi 扩展在 `session_start` 调 `ctx.ui.setTitle`),供监听匹配。
**3. 任务 markdown 存库,子 agent 自主发挥(用户决策 2/11)**:子 pi 是**全新会话**;编排者把渲染好的任务 markdown 写入 `workflow_steps.task_md`(模板注入依赖结果),`--input` 只注入**短指引**(长文本经终端粘贴易错乱,故存库自取);子 agent 在 worktree 内自主探索、自己发挥。

```text
派发一个子任务(dispatch.ts):
  1. gittree create wf-<workflow>-<dotted>(基于 base_sha,事件 worktree_created)
  2. 渲染 task_md(目标 + 本步任务 + 期望 + 输出契约 + worktree 约束,模板注入依赖结果)
     → 写入 workflow_steps.task_md;事件 step_dispatched
  3. 组装短指引 pointer(身份 + 指向 /wf context + 回报方式)→ 写入 workflow_attempts.pointer
  4. ghostctl new-tab --window-id <绑定窗口> --cwd <worktree> \
        --command "env PI_WF_WORKFLOW=<workflowId> PI_WF_STEP=<dotted> pi" \
        --input "<短指引>"
     (事件 step_tab_opened,记录 tab_id)
  5. 子 pi 扩展读环境变量绑定身份,session_start 时 setTitle = "wf <workflow>/<dotted>"
  6. 子 agent 运行 /wf context → 读 DB(workflow_steps.task_md / 本次派发 workflow_attempts.task_md 冻结版)
```

**4. gate = 执行前设定、执行后更新(用户决策 1)**:派发时把 `expectations`(验收标准)写进任务 markdown;子任务回报 `/wf done <JSON>`;编排者(或人工 `/wf verify`)对照期望核对 → `done` / `needs-fix`;`gate=1` 的步骤 reported 后必须人工 `/wf verify` 才能进入 merge。
**5. 监听 = 轮询 ghostctl,DB 是事实源**:

```text
monitor.ts 后台任务(编排者扩展内):
  每 5s:ghostctl layout --json → 按标题 "wf <workflow>/<dotted>" 匹配
  - 匹配到且步骤 running → 无事
  - 匹配不到且步骤 running/dispatched → 事件 step_tab_closed → aborted + 通知
  - 步骤 reported 且 tab 仍在 → 提示可关 tab(不自动关,留给人看)
```

   子任务"发送信息/更正状态"的正式通道是 `/wf done`(写库 + 事件);tab 消失是兜底信号。
**6. 计划可迭代改**:wave 结束后主 agent 可 `/wf plan` 追加/修改后续 wave 的步骤(非终态步骤允许改任务 markdown/期望),按 wave 记录版本。
**7. 目标把关是 workflow 的完成条件(用户决策 3)**:见 §4.4,`verifying` 状态 + `goal_check` 留痕 + gap wave 补齐闭环。
**8. headless 模式(可选保留)**:官方 subagent 式无头执行作为备用路径(`workflow` 工具加 `mode: headless` 参数),与 tab 模式共用 DB/状态机,不阻塞主路线。

---

## 6. 子任务契约

### 6.1 任务存库,子 pi 自取(用户决策 11)

- 编排者派发时把渲染好的任务 markdown 写入 `workflow_steps.task_md`(模板注入依赖结果),每次派发在 `workflow_attempts.task_md` 留冻结副本(版本可追溯);
- 子 pi 首条消息(`--input`)只注入**短指引**,不做长文本传输:

```text
[wf] 任务已就绪
workflow: add-redis-cache | step: 1.1 | wave: 2
→ 运行 /wf context 查看任务详情(markdown 已存数据库)
→ 完成后运行 /wf done 1.1 <JSON> 回报
→ 失败运行 /wf fail 1.1 <原因>
```

任务 markdown 模板(存 workflow_steps.task_md):

```text
# 任务 <dotted>(workflow: <workflowId>, wave <N>)
## 需求目标
<workflow.goal>
## 本步任务
<渲染后的 task_prompt(依赖步骤结果经模板注入)>
## 期望/验收标准(执行前设定)
- <expectations[0]>
- <expectations[1]>
## 约束
- 你工作在 worktree <worktree> 内,只改动该目录下的文件
- 不要使用 git stash / 不要动 .worktrees/ 与主工作区
- 完成后在 worktree 内提交 git commit
## 输出契约
完成任务后,执行 /wf done <dotted>,参数为 JSON:
{"summary": "...", "filesChanged": [...], "issues": [...], "tests": "passed|failed|none"}
完成后可自行关闭本 tab。
```

### 6.2 回报(`/wf done`,子 pi 内命令)

- 写 workflow_attempts 行 + 更新 workflow_steps(report/summary/files_changed/issues/tests/status=reported)+ workflow_events(step_reported);
- `gate=1` 的步骤同时进入 waiting-verify;否则编排者自动核对(或 notify 主 agent 人工核对);
- 子 agent 中途失败用 `/wf fail <stepId> <原因>` 主动报失败(比 tab 消失兜底更优雅)。

---

## 7. gittree / Ghostty 集成

### 7.1 生命周期

```text
dispatch:gittree create wf-<workflow>-<dotted>(基于 base_sha,事件 worktree_created)
        task_md 渲染入库 + 短指引注入 + ghostctl new-tab 到绑定窗口(事件 step_dispatched / step_tab_opened)
成功:子 pi 内 git commit → 编排者侧 /wf merge(事件 worktree_merged)
失败/重派:gittree clean <name> --branch --force 重建(事件 worktree_cleaned)
清理:/wf clean → gittree clean all --yes(仅 gittree- 前缀,占用中自动跳过)
```

### 7.2 合并(串行,层级序)

wave 全部终态后,按 `sort_order`(点号层级序)串行 `gittree merge --delete`;并行分支同 base_sha 冲突概率最小。冲突 → `conflict`(事件 merge_conflict),worktree 保留,人工解决后 `/wf resolve-conflict`。

### 7.3 与 gittree 占用检测的配合

子 pi 进程 cwd 在 worktree 内,lsof 占用检测天然拦住运行中误删;clean 前先确认该步 tab 已关。

---

## 8. 查询与看板(DB 视角)

### 8.1 看板即查询

已实现:`/wf board [--wave N]`(终端 5 列)+ `--html` 单文件导出;数据全部来自下述查询:

- 列分布:`SELECT status, count(*) FROM workflow_steps WHERE workflow_id=? GROUP BY status`;
- 看板列映射:pending/ready→待办,dispatched/running→进行中,reported/waiting-verify→待核对,done/skipped→完成,failed/aborted/conflict/needs-fix→异常;
- 进行中(监听/崩溃恢复共用):`SELECT * FROM workflow_steps WHERE status IN ('dispatched','running')`;
- 批次:`SELECT w.seq, s.status, count(*) FROM workflow_steps s JOIN workflow_waves w ON w.id = s.wave_id WHERE s.workflow_id = ? GROUP BY w.seq, s.status`;
- 成本:`SELECT * FROM v_workflow_cost WHERE workflow_id = ?`(按步汇总,含全部重试);
- 追溯:`SELECT * FROM workflow_events WHERE workflow_id=? ORDER BY created_at`;
- 任务树:`WITH RECURSIVE` 按 id 前缀展开,或直接 `ORDER BY sort_order`(点号路径天然层级);
- 文件反查:`SELECT s.id, s.title FROM workflow_steps s, json_each(s.files_changed) WHERE json_each.value LIKE 'src/auth/%'`。

### 8.2 看板呈现(已实现 + 规划)

| 形态 | 状态 | 说明 |
| --- | --- | --- |
| pi 内 TUI 看板 `/wf board` | ✅ 已实现 | 终端 5 列(待办/进行中/待核对/完成/异常),层级缩进 + 摘要 |
| 静态 HTML 看板 `/wf board --html out.html` | ✅ 已实现 | 单文件快照,浏览器打开/分享 |
| 同步思源数据库 | 规划中 | 订阅 workflow_events 增推送到思源 AV(属性视图/看板) |

实时展示:编排者 footer 状态条(`ctx.ui.setStatus("wf", …)`,powerline 兼容)+ `/wf status` 文本全景 + `/wf board`。

---

## 9. 命令与 UI

### 9.1 命令族(32 条,双入口共享;/wf 与 wf CLI 同一注册表)

| 命令 | 入口 | 作用 |
| --- | --- | --- |
| `/wf plan "<目标>" [--repo] [--workflow] [--dry-run]` | both | planner agent 自动拆解(无 id=新建,有 id=追加 gap wave) |
| `/wf import <plan.json>` | both | 手工 JSON 走同一校验通道(不经过 planner) |
| `/wf plan-init` | cli | 生成 plan.json 模板 |
| `/wf dispatch <dotted…> [--workflow] [--dry-run]` | both | 派发:worktree + task_md 入库 + 短指引 + 开 tab(写 step_dispatched);无参=派发就绪集 |
| `/wf verify <dotted> [approve\|reject <原因>]` | both | 核对期望 vs 回报(gate 更新环节) |
| `/wf merge [--wave N]` | both | wave 全部终态后串行合并;冲突转 conflict |
| `/wf resolve-conflict <stepId>` | both | 冲突已人工解决,继续 |
| `/wf goal-check [--workflow <id>] [approve\|reject <原因>]` | both | 目标完成度核对(verifying 状态,见 §4.4) |
| `/wf next [--note <说明>]` | both | 滚动到下一 wave(gap wave 用) |
| `/wf retry <dotted> [--fresh]` | both | 重派(默认复用原 worktree,`--fresh` 重建);**tab 仍存活则复用不重开**(实时去重) |
| `/wf skip <stepId> <原因>` | both | 人工终态:非终态 → skipped(依赖视为 done) |
| `/wf steer <dotted> <文本>` | pi | 向子任务 tab 注入文本(CLI 用 `wf inject <target> <text...>` 等价) |
| `/wf resume [--workflow <id>]` | both | paused → running(预算超限暂停后恢复) |
| `/wf rebind-window [wfId]` | both | 绑定窗口已关闭时,重绑当前焦点窗口 |
| `/wf status [--all]` / `/wf tree` / `/wf board [--wave N] [--html]` | both | 全景 / 层级任务树 / 看板(终端列 + HTML 导出) |
| `/wf step <id>` / `/wf events [N] [--follow]` | both | 单步详情(含 attempts)/ 审计流 |
| `/wf context [stepId]` | both | 读任务详情:无参按身份解析(子 pi),显式传 stepId(CLI) |
| `/wf done <id> '<JSON>'` / `/wf fail <id> <原因>` | both | 回报(子任务侧) |
| `wf inject/poll/session/open-tab/fix-tab/tabs/cleanup/clean/doctor/debug` | cli | 排查/自动化专用(详见 skill/SKILL.md §4.6 命令矩阵) |

不再存在的设计命令(已被替代):`/wf start`(用 import/plan 直接建)、`/wf pause`(预算护栏自动 pause)、`/wf abort`、`/wf close-tab`(cleanup 统一关终态 tab)。

### 9.2 子 pi 侧命令(子任务 tab 内)

| 命令 | 作用 |
| --- | --- |
| `/wf done <dotted> <JSON>` | 回报完成(写 workflow_attempts/workflow_steps/workflow_events) |
| `/wf fail <dotted> <原因>` | 主动报失败 |
| `/wf context` | 从 DB 读 workflow_steps.task_md(优先本次派发的 workflow_attempts.task_md 冻结版)回显任务详情;CLI 同款 `wf context [stepId]` |

### 9.3 工具(主 agent 用)

`workflow` 工具(`/wf plan/dispatch/verify/merge/goal-check` 等)与命令共用 orchestrator.ts,主 agent 在流程 1-7 中按需调用。

### 9.4 UI

- 子 tab 标题:`wf <workflowId>/<dotted>`(`ctx.ui.setTitle`,session_start 时设);
- 编排者 footer 状态条:`ctx.ui.setStatus("wf", …)`(pi 原生 footer 与 pi-powerline-footer 的 extension_statuses 段都渲染;monitor 5s tick + 每次 /wf 命令后刷新;无活动 workflow 自动清空);
- 编排者 widget:status/tree/board/step/events/goal-check 按命令展示,监听事件实时刷新。

---

## 10. 安全模型

- 子任务 tab 是**可见交互式会话**,用户天然在场可干预,风险低于无头自动执行;
- 项目级 agent 默认禁用,`trustProjectAgents` + 首次确认;
- 预算护栏:`budget_cents` 累计超限自动 pause;`max_steps` 防拆解失控;单步 `timeout_min` 超时标 aborted;
- merge 前必须 worktree 内已 commit,杜绝半成品合入;`/wf done` 只写状态不自动合并,合并权在编排者;
- 目标把关(`verifying`)确保 workflow 不会在目标未达成时误报完成。

---

## 11. 分阶段实施计划

| 阶段 | 内容 | 验收标准 |
| --- | --- | --- |
| **P1 派发闭环** | db.ts(完整 schema,§3)+ dispatch.ts(gittree create + task_md 渲染入库 + 短指引 + ghostctl new-tab)+ `/wf context/done/fail` + `/wf status` + 手工 `/wf verify` | 手动 `/wf import` 一个含 1.1/1.2 的计划 → dispatch 出两个 tab,子 pi 经 `/wf context` 取任务、`/wf done` 回报后 DB 完整留痕,`/wf tree` 显示层级 |
| **P2 监听与批次** | monitor.ts(ghostctl 轮询 + 标题匹配)+ wave 推进(就绪集按 deps 并行/串行)+ `/wf merge` + 崩溃恢复(按 tab_id 重连) | 3 并行任务各改各文件,wave 完成串行合回;关一个 tab 不回报 → 自动 aborted;杀 pi 重启后状态重连 |
| **P3 期望核对** | expectations 设定(任务 markdown 注入)+ 自动/人工核对 + needs-fix 闭环 + retry + 预算护栏 + steer | "执行前设定期望 → 回报 → 核对不达标 → needs-fix 重派 → 达标"全链路事件完整 |
| **P4 智能编排** | `/wf plan` / `/wf next` 自动拆解(planner JSON 契约)+ **目标把关闭环**(verifying + goal-check + gap wave) | 一条需求目标 → 自动 recon+plan+wave 迭代执行 → 目标核对通过才 completed,未达成自动补 wave |
| **P5 看板** | §8.2:终端列看板 ✅ + HTML 导出 ✅;思源同步规划中 | 看板数据全部来自 §8.1 查询 |

每阶段结束:`/reload` 热加载验证 + 真实小仓库演练 + 文档更新。

### 实施状态

- **P1 派发闭环 ✅(2026-08)** — src/: index/cli/orchestrator/dispatch/db/validate/agents + skill/ + bin/;
- **P2 监听与批次 ✅(2026-08)** — src/monitor.ts(tab 存活轮询 5s/消失→aborted/崩溃恢复/就绪集/wave 串行 merge);
- **P3 期望核对 ✅(2026-08)** — retry 上下文注入/max_retries/--fresh/steer/resolve-conflict/usage 自报/预算护栏/超时;
- **P4 智能编排 ✅(2026-08)** — src/planner.ts(headless planner 自动拆解,JSON 契约)+ goal-check 目标把关(verifying→completed/gap wave)+ /wf next wave 滚动 + appendSteps(gap wave 追加);真实链路:一条需求目标 → 5 步计划落库;
- **P5 看板 ✅(2026-08)** — src/board.ts(buildBoard 5 列数据 + 文本列布局 + 单文件 HTML 导出 + XSS 转义);/wf board + wf board [--html];思源同步(P5b)待实施;
- 验收:129 断言。

---

## 12. 已定决策与待确认

### 已定(用户拍板)

1. **存储**:SQLite 唯一事实源,全局单库,`node:sqlite`,纯数据库不产 markdown;
2. **任务 id**:层级化点号 id(`1.1`、`1.2.3`),父子由前缀推导,worktree 命名 `wf-<workflow>-<dotted>`;
3. **gate**:执行前设定期望,执行后更新(回报 → 核对 → done/needs-fix);
4. **worktree**:每步一个;
5. **执行模型**:主 pi 编排 + 每个子任务一个可见 Ghostty tab;子 pi 全新会话,子 agent 自主发挥(不复用父会话上下文);
6. **监听**:ghostctl layout 轮询按标题匹配,`/wf done` 为正式回报通道,tab 消失为兜底;
7. **迭代批次**:wave 内并行/串行,合并冲突解决后再拆下一 wave;
8. **目标把关**:workflow 结束前必须核对最初目标全部达成(verifying → completed / gap wave),否则不允许结束;
9. 看板已实现(§8.1/8.2):终端 5 列 + HTML 导出;思源同步规划中;
10. **不参考 pi-dynamic-workflows**:不符合要求,自研初版完成后再看生态;
11. **任务传递**:任务 markdown 写入数据库(`workflow_steps.task_md` 当前版 + `workflow_attempts.task_md` 冻结版),`--input` 只注入短指引,子 agent 经 `/wf context` 自取任务;
12. **监听轮询间隔**:5s(可配);
13. **tab 生命周期**:子任务完成不自动关 tab(留给人看);`wf cleanup` 统一关终态 tab + 清 .pi-glla(合并前置);
14. **headless 模式**:设计保留(§5 决策 8),尚未实现;当前子任务形态为可见 tab。

### 待确认

(无 —— 全部决策已拍板,P1 按 §11 实施中)
