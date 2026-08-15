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
> 权威层级:本手册 → `DESIGN.md`(设计)→ 代码(src/ 命令注册表,以代码为准)。

## 何时使用

- 编排者:拆分大任务、派发子 agent、核对回报、合并 wave、目标把关
- 子任务:在子 tab 里读任务(`/wf context`)、回报(`/wf done`)
- 排查:任务卡住/失败/tab 异常/合并冲突/状态修复

## 30 秒速览(三步)

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
- 冲突处理顺序:先 `git worktree remove --force` 再 `git branch -D`(反了报占用)
