# 编排流程(端到端)

> 由 skill/SKILL.md 拆分,按需加载。

### 1.1 三步跑通第一个 workflow

**第 1 步:准备计划**(二选一)

```bash
# 方式 A:一句话让 planner agent 自动拆解(推荐)
/wf plan "给 hello 工具加 --name 与 --verbose 参数,并同步 README" --repo ~/myrepo

# 方式 B:手写 plan.json 后导入
wf plan-init hello-cli "给 hello 工具加参数" --repo ~/myrepo --steps 4   # 生成模板
# 编辑 plan.json 后:
/wf import plan.json          # 校验 + 落库(校验规则见 §4.4)
```

**第 2 步:派发并等待回报**

```bash
/wf dispatch 1                # 顶层步骤:建 worktree + 开子 tab + 任务写库
/wf dispatch 1.1 1.2          # 依赖 done 后,并行派发
/wf status                    # 随时看全景;步骤回报时 monitor 会自动通知你
```

**第 3 步:核对、合并、收尾**

```bash
/wf verify 1.1 approve        # 对照期望核对回报(不达标用 reject,子 agent 回炉)
/wf verify 2 approve          # gate 步骤(reviewer)回报后同样核对
wf cleanup && /wf merge       # 关终态 tab + 清 .pi-glla,然后串行合回主分支
/wf goal-check approve        # 对照最初目标把关 → completed
```



# 编排流程(端到端)

> 由 skill/SKILL.md 拆分,按需加载。

## 3. 编排流程(端到端)

### 3.1 标准编排(编排者视角)

```text
① 计划     /wf plan "目标"                    → workflow + wave 1 步骤
② 派发     /wf dispatch 1                    → 顶层步骤(planner)开 tab
③ 推进     /wf dispatch 1.1 1.2              → 依赖 done 后并行(worker)
④ 引导     /wf steer 1.1 "run /wf context, implement, test, commit, then /wf done 1.1"
⑤ 核对     /wf verify 1.1 approve|reject     → done / needs-fix(回炉)
⑥ 收尾     wf cleanup && /wf merge           → wave 合回主分支
⑦ 把关     /wf goal-check approve            → completed
```

**并行/串行规则**:无依赖边且为 worker 类 → 并行;有依赖或涉及共享文件 → 串行。依赖未完成时 dispatch 会被拒绝。

> **⚠️ 串行依赖红线**:串行依赖步骤不要塞进同一 wave 靠 dispatch 顺序推进。同一 wave 内所有步骤共享同一 base_sha(冻结的首个派发 HEAD),后一步不会自动继承前一步成果,会从陈旧 HEAD 分叉成 sibling、丢失前序成果。正确做法是拆成多个 wave:每 wave 全部终态后 `/wf merge` 推进主仓库 HEAD,下一 wave 再分叉;若必须同 wave 串行,派发后一步前必须先 `/wf merge` 合并前一步。

### 3.2 子任务侧流程(子 pi tab 内)

```text
/wf context          → 读任务详情(markdown:目标/本步任务/期望/约束/输出契约)
(在 worktree 内实现;完成后 git commit)
/wf done 1.1 '<JSON>' → 回报(契约见 §2.2);gate 步骤 → waiting-verify
/wf fail 1.1 <原因>   → 主动报失败(比 tab 消失兜底更优雅)
```

> 子 pi 身份:env `PI_WF_WORKFLOW/PI_WF_STEP`(派发注入),兜底解析 cwd worktree 路径。

### 3.3 冲突处理(merge conflict)

```bash
wf step <wf>-<id>                # 看冲突步骤与错误
# 人工解决 git 冲突(编辑冲突文件,或保留一侧:git checkout --ours/--theirs <file>)
git add -A && git commit -m "merge: 解决 <wf>-<id> 冲突"   # 完成 git 合并
git worktree remove --force .worktrees/gittree-wf-<wf>-<id>  # 先移 worktree(顺序!否则 branch -D 报占用)
git branch -D gittree-wf-<wf>-<id>
wf resolve-conflict <wf>-<id>    # DB:conflict → done
wf merge --wave N                # 重新合并
```

### 3.4 主控自主编排(monitor 自动通知)

monitor 每 5s 检测关键状态,经 `pi.sendMessage(followUp, triggerTurn)` 推给主控:

| 事件 | 主控应执行 |
| --- | --- |
| 步骤回报 / gate 待核对 | `/wf verify <id> approve\|reject` |
| 失败 / 中止 | `/wf step <id>` 查原因 → `/wf retry <id>`(先 `wf tabs` 核实 tab 是否真死) |
| 冲突 / 待修复 | 解决后 `/wf resolve-conflict <id>` |
| wave 完成 | `wf cleanup && /wf merge` |
| 全流程完成 | `/wf goal-check approve` |

### 3.5 master-agent 模式(主控 agent 独立 gittree,发起方不阻塞)

`/wf create "<目标>"` 一步创建即开跑:发起方继续干自己的事(可同时创建多个
workflow),主控 agent 在独立 gittree 里全自主完成全流程,完成后通知发起方。

```text
发起方(不阻塞):                                     主控会话(wf-master <id> tab):
/wf create "目标" --repo ~/repo                   ① /wf status → 探索仓库 → 拆解
   ├─ 落库(mode=master)                          ② /wf plan "<目标>" --workflow <id>
   ├─ gittree create wf-master-<id>(当前分支)        或自研 plan.json 后 wf import --workflow <id>
   └─ 专属窗口开主控 tab(不抢焦点)                ③ /wf dispatch 派发子任务
  (继续自己的工作;多 workflow 并行)                  (子 gittree 基于主控分支创建)
  ...                                              ④ 回报→/wf verify;失败→/wf retry;冲突自解
  monitor 收到 master-done 通知                    ⑤ wave 完成→ wf cleanup && /wf merge
  → /wf master-merge <id>                            (合并进主控分支,删子 gittree)
  (合并回当前分支,删主控 gittree,completed)       ⑥ /wf next 拆下一 wave,直到全部完成
                                                    ⑦ /wf goal-check approve → awaiting-merge
                                                    (通知发起方,可自行关 tab)
```

关键点:

- **不阻塞**:创建后编排全在主控会话推进;发起方 monitor 只收终局级通知
  (master-done / master-failed),step 级事件只推给主控会话
- **子任务基于主控 gittree**:`gittree create wf-<id>-<dotted> gittree-wf-master-<id>`;
  `/wf merge` 在主控 worktree 内 `git merge` → 全部功能合入主控分支
- **终局**:目标把关通过 → `awaiting-merge`(非 completed);发起方 `/wf master-merge <id>`
  才合并回主分支并置 completed
- **失败兜底**:主控无法继续 → `/wf master-fail <id> <原因>`;主控 tab 消失(dead-master)
  → monitor 检测并通知发起方,可自行接管(/wf verify /wf merge /wf goal-check)
- **会话隔离**:主控 cwd 在 repo 内天然可见本 workflow;身份识别
  `PI_WF_MASTER` / cwd 段 `gittree-wf-master-<id>`(歧义按 DB workflow 存在性判定)

> 去重:每种事件每步骤每 attempt 只通知一次;手动 `/wf status` 不受影响。
> 通知可能延迟投递(如执行中):收到后先核实状态再动作,不盲信单条通知。

---

