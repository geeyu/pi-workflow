---
name: workflow
description: >
  pi workflow 编排插件(pi-workflow)的使用与排查手册。当用户提到 workflow、
  子任务派发、worktree 并行开发、/wf 命令、任务看板、任务卡住/失败排查、
  wf 辅助脚本等场景时触发。提供创建计划、执行编排、子任务回报、期望核对、
  冲突处理、目标把关的完整指引;所有命令双入口(/wf 插件命令 + wf CLI)。
---

# pi-workflow 使用手册

> 主 pi 为调度者,把大计划拆成并行/串行批次;每个子任务 = 一个 gittree worktree + 一个 Ghostty tab(可见、可干预);全生命周期事件落 SQLite(`~/.pi/agent/workflows/workflow.db`,唯一事实源)。
>
> 权威层级:本手册 → `docs/DESIGN.md`(设计)→ 代码(src/ 命令注册表,以代码为准)。

## 命令入口(随 skill 分发,不依赖全局安装)

所有命令双入口:`/wf <cmd>`(pi 插件命令)+ `wf <cmd>`(CLI)。

**CLI 命令本体就在本 skill 内**(Agent Skills 规范:skill 自带脚本,按相对路径调用):

```bash
<skill目录>/bin/wf status          # 相对 skill 目录调用(克隆 skill 即得命令)
~/.pi/agent/extensions/workflow/skill/bin/wf status
```

- 命令实现:`skill/bin/wf`(bash 包装,node 自动兜底:WF_NODE→PATH→fnm→brew,裸 PATH 可用)→ 仓库根 `src/cli.ts`(与插件共享同一命令注册表)
- **全局软链可选**(已安装环境可用):`~/.local/bin/wf` 已软链到本 skill 的 `bin/wf`,PATH 含 `~/.local/bin` 时可直接 `wf <cmd>`;无软链环境仍按 `<skill目录>/bin/wf` 相对路径调用
- 无 `/wf` 插件环境(纯脚本/CI)也能用 CLI;`/wf` 与 `wf` 行为一致,退出码契约 0/1/2/3

## 何时使用

- 编排者:拆分大任务、派发子 agent、核对回报、合并 wave、目标把关
- 子任务:在子 tab 里读任务(`/wf context`)、回报(`/wf done`)
- 排查:任务卡住/失败/tab 异常/合并冲突/状态修复

## 30 秒速览(三步)

```bash
/wf create "目标" --repo ~/repo        # ① 创建即开跑:主控 agent 独立 gittree 自主编排(不阻塞发起方)
/wf master-merge <id>                  # ② 主控完成后通知发起方,决定合并回主分支
```

经典编排(发起方即编排者):

```bash
/wf plan "目标" --repo ~/repo     # ① planner 自动拆解(或 wf import plan.json)
/wf dispatch 1.1 1.2              # ② 派发(自动开子 tab;依赖 done 后可并行)
/wf verify 1.1 approve            # ③ 回报后核对 → wf cleanup && /wf merge → /wf goal-check approve
```

- 子任务侧:tab 内 `/wf context` 读任务 → 实现并 commit → `/wf done 1.1 '{"summary":"..."}'`
- 状态变化由 monitor 每 5s 检测并**自动通知主控**(不用轮询)
- 全部命令有 CLI 等价(`wf ...`),可无头自动化;退出码 0 成功 / 1 业务错 / 2 不可达 / 3 用法错

## 常用命令速查(完整参考见 references/commands.md)

| 场景 | 命令 |
| --- | --- |
| 拆解计划 | `/wf plan "<目标>"` / `wf plan-init` + `/wf import plan.json` |
| **master-agent 模式** | `/wf create "<目标>"`(主控 agent 独立 gittree 自主编排,不阻塞发起方)→ 完成后 `/wf master-merge <id>` 合并回主分支 |
| 派发/重派 | `/wf dispatch 1.1 1.2` / `/wf retry <id> [--fresh]`(tab 存活自动复用不重开) |
| 引导子 agent | `/wf steer <id> <英文指令>`(CLI: `wf inject <target> <text...>`) |
| 核对/驳回 | `/wf verify <id> approve\|reject <原因>` |
| 人工终态 | `/wf skip <id> <原因>` |
| 合并/冲突 | `wf cleanup && /wf merge`;冲突 → 人工解决 → `wf resolve-conflict <id>` → merge |
| 目标把关 | `/wf goal-check approve\|reject`(多 workflow 时 `--workflow <id>`) |
| 查询 | `/wf status` / `wf board` / `wf step <id>` / `wf events` / `wf poll --until done` |
| 排查 | `wf doctor` / `wf tabs` / `wf fix-tab` / `wf open-tab` |

## 参考文档(按需加载)

| 文件 | 内容 |
| --- | --- |
| [references/commands.md](references/commands.md) | 32 条命令完整参考:用法/参数/示例/退出码(5 组分类) |
| [references/lifecycle.md](references/lifecycle.md) | 编排流程:快速上手 → 端到端序列 → 子任务侧 → 冲突处理 → monitor 自主编排 |
| [references/data-model.md](references/data-model.md) | 状态机(步骤/workflow)/ 35 类事件 / DB 表与列名速查 / plan.json 格式 |
| [references/troubleshooting.md](references/troubleshooting.md) | 排查手册:自检 / 常见问题对照表 / 快捷修复序列 / 重置 / 安全须知 |

## 关键规则(踩坑前置)

- 回报前**必须在 worktree 内 git commit**(合并前置);`/wf done` 只写状态,合并权在编排者
- gate 步骤(reviewer)回报后必须 `/wf verify` 才能进合并
- 注入子 tab 的指令用**纯 ASCII**(AppleScript 中文乱码);中文内容走 `/wf context`
- 收到「tab 已关闭」通知先 `wf tabs` 核实存活,再决定 retry(monitor 已抗抖动:连续 2 次未命中才判)
- 多 workflow 同仓库时,CLI 命令显式传 `--workflow <id>` 最可靠
- **会话隔离(谁发起谁看)**:monitor 轮询/状态通知/footer 状态条/计划面板只针对**当前会话 cwd 所在仓库**的 workflow;其他仓库的 workflow 不会被本会话轮询、通知或显示,互不干扰(如 hammerspoon-kit 的 workflow 不会通知 extensions/workflow 会话)
- 冲突处理顺序:先 `git worktree remove --force` 再 `git branch -D`(反了报占用)
