/**
 * master.ts — master-agent 模式(主控 agent 独立 gittree 自主编排)
 *
 * 用户需求(7 步,全部满足):
 *   1. /wf create "<goal>"(发起方一步创建,立即返回,不阻塞发起方;
 *      发起方可同时创建多个 workflow,互不干扰)
 *   2. 基于当前分支创建主控 gittree(gittree-wf-master-<id>)+ 专属窗口开主控 pi tab
 *   3. 主控 agent 自主分析拆解(/wf plan --workflow <id>)、派发子任务
 *   4. 子任务基于主控 gittree 分支创建(gittree create <name> <masterBranch>),
 *      合并进主控分支(git merge 在主控 worktree 内执行)
 *   5. 全部 wave 合并完成 → /wf goal-check approve → awaiting-merge + master_done 事件
 *   6. 发起方 monitor 收到 master-done 通知 → /wf master-merge <id> 合并回主分支
 *   7. 合并完成 → 删主控 gittree、workflow completed
 *
 * 关键机制:
 * - 会话隔离天然生效:主控 worktree 位于 repo 内,主控会话 monitor 只看到本
 *   workflow(谁发起谁看);发起方经 owner_cwd 通道可见
 * - 身份识别:PI_WF_MASTER 环境变量 / cwd 段 `gittree-wf-master-<id>`
 *   (识别顺序在步骤正则之前,避免 id 以数字结尾时误判为子步骤)
 * - 不阻塞:create 只做落库 + gittree + 开 tab,编排全程由主控会话自主推进
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
	addEvent,
	createWorkflow,
	EVT,
	getStepsByWorkflow,
	getWorkflow,
	getWorkflowMeta,
	MASTER_MODE_KEY,
	MASTER_MODE_VALUE,
	MASTER_TAB_KEY,
	setWorkflowMeta,
	updateWorkflowStatus,
	WORKFLOW_STATUS,
} from "./core/db.ts";
import { piInvocation, resolveBin, run } from "./exec/shell.ts";
import { newWindow, closeTerminal } from "./exec/ghostty.ts";
import { findTerminalId, shellQuote } from "./exec/window.ts";

// ────────────────────────────────────────────────────────────
// 命名与 mode 元数据
// ────────────────────────────────────────────────────────────

/** 主控 gittree 名(gittree create/clean/merge 用) */
export function masterName(workflowId: string): string {
	return `wf-master-${workflowId}`;
}

/** 主控分支名(gittree 命名约定:分支 = gittree-<name>) */
export function masterBranch(workflowId: string): string {
	return `gittree-${masterName(workflowId)}`;
}

/** 主控 worktree 目录(gittree 约定:<repo>/.worktrees/gittree-<name>) */
export function masterWorktreePath(
	repoPath: string,
	workflowId: string,
): string {
	return path.join(repoPath, ".worktrees", `gittree-${masterName(workflowId)}`);
}

/** 该 workflow 是否为 master-agent 模式(主控独立 gittree 自主编排) */
export function isMasterMode(db: DatabaseSync, workflowId: string): boolean {
	return getWorkflowMeta(db, workflowId, MASTER_MODE_KEY) === MASTER_MODE_VALUE;
}

// ────────────────────────────────────────────────────────────
// 主控 pointer(注入主控 pi 首条消息)
// ────────────────────────────────────────────────────────────
function buildMasterPointer(workflowId: string, goal: string): string {
	return [
		`[wf-master] You are the master agent of workflow ${workflowId}`,
		`(own gittree, branch ${masterBranch(workflowId)}; repo is your cwd)`,
		``,
		`Goal: ${goal.trim() || "(see /wf status)"}`,
		``,
		`Autonomous loop (no need to ask the initiator):`,
		`1. /wf status - check workflow state (goal/plan)`,
		`2. Explore the repo, then /wf plan "<goal>" --workflow ${workflowId} to decompose`,
		`   (or write plan.json yourself and /wf import plan.json --workflow ${workflowId})`,
		`3. /wf dispatch - dispatch ready steps (auto opens sub tabs + sub gittrees)`,
		`4. On step report: /wf step <id> to inspect, /wf verify <id> approve|reject;`,
		`   on failure: /wf retry <id> [--fresh]; resolve conflicts yourself`,
		`5. When a wave is fully done: wf cleanup && /wf merge (merges into YOUR gittree`,
		`   branch, auto deletes sub gittrees; conflicts: resolve + commit in this worktree)`,
		`6. Need more waves: /wf next, then plan again (--workflow ${workflowId})`,
		`7. When everything is merged and the goal is met: /wf goal-check approve`,
		``,
		`After step 7 the initiator is notified and decides whether to merge your`,
		`gittree back to the main branch. You may then close this tab yourself.`,
		`If you cannot continue: /wf master-fail ${workflowId} <reason>`,
	].join("\n");
}

// ────────────────────────────────────────────────────────────
// create:落库 + 主控 gittree + 专属窗口开主控 tab(一步完成,非阻塞)
// ────────────────────────────────────────────────────────────
export interface CreateMasterOptions {
	repoPath: string;
	/** 发起方 cwd(owner 会话通道,保证发起方随时可见) */
	ownerCwd: string;
	workflowId: string;
	title: string;
	goal: string;
	dryRun?: boolean;
	gittreeBin?: string;
}

export interface CreateMasterResult {
	ok: boolean;
	workflowId?: string;
	masterWorktree?: string;
	masterBranchName?: string;
	tabId?: string | null;
	error?: string;
}

/**
 * 创建 master-agent 模式 workflow(发起方调用,立即返回):
 *   1. workflow 落库(status=running,owner_cwd=发起方)+ mode=master 元数据
 *   2. gittree create wf-master-<id>(基于当前分支,--fresh 防残留)
 *   3. 专属窗口(首次 new-window --no-focus 并绑定)+ new-tab 开主控 pi
 *   4. 事件 master_started
 * 主控 pi 启动后自主完成 plan→dispatch→verify→merge→goal-check 闭环。
 */
export async function createWorkflowWithMaster(
	db: DatabaseSync,
	opts: CreateMasterOptions,
): Promise<CreateMasterResult> {
	const { repoPath, workflowId } = opts;
	const name = masterName(workflowId);
	const wtPath = masterWorktreePath(repoPath, workflowId);
	const gittreeBin = opts.gittreeBin ?? resolveBin("gittree");

	if (opts.dryRun) {
		return {
			ok: true,
			workflowId,
			masterWorktree: wtPath,
			masterBranchName: masterBranch(workflowId),
		};
	}

	if (getWorkflow(db, workflowId)) {
		return {
			ok: false,
			error: `workflow 已存在: ${workflowId}(复用现有 workflow,或换 id)`,
		};
	}
	// 残留防护:同名 master gittree 已存在 → 报错引导清理,绝不静默复用
	if (fs.existsSync(wtPath)) {
		return {
			ok: false,
			error: `master gittree 已存在(上次残留): ${wtPath};请先 gittree clean ${name} --branch --force 清理后重试`,
		};
	}

	// 1. 落库(workflow_created 事件)
	createWorkflow(db, {
		id: workflowId,
		title: opts.title,
		goal: opts.goal,
		repoPath,
		ownerCwd: opts.ownerCwd,
	});
	// 主控会话已开跑 → 立即 running(updateWorkflowStatus 同时记 started_at)
	updateWorkflowStatus(db, workflowId, WORKFLOW_STATUS.running);
	setWorkflowMeta(db, workflowId, MASTER_MODE_KEY, MASTER_MODE_VALUE);

	// 2. 主控 gittree(基于当前分支;--fresh 防上次残留分支的陈旧提交)
	const createRes = await run(
		gittreeBin,
		["create", name, "HEAD", "--fresh"],
		repoPath,
	);
	if (createRes.code !== 0) {
		return {
			ok: false,
			workflowId,
			error: `主控 gittree 创建失败: ${createRes.stderr || createRes.stdout}`,
		};
	}

	// 3. 一步创建主控 tab:new-window --command 让 Ghostty 自带的初始 tab 直接
	// 成为主控(带 cwd + 启动命令)——无多余空白 tab、无需 sweep/绑定窗口,
	// 主控后续在自己所在窗口开子任务 tab(resolveMasterWindow)。
	const pointer = buildMasterPointer(workflowId, opts.goal);
	const cmd = `env PI_WF_MASTER=${workflowId} PI_WF_REPO=${repoPath} ${piInvocation()} ${shellQuote(pointer)}`;
	try {
		// 后台创建(不抢焦点,不打扰当前开发)
		await newWindow({ cwd: wtPath, command: cmd, noFocus: true });
	} catch (e) {
		return {
			ok: false,
			workflowId,
			error: `主控窗口创建失败: ${e instanceof Error ? e.message : String(e)}`,
		};
	}
	// 反查主控 terminal id(按 cwd 匹配;新窗口初始 tab 的 AppleScript 引用
	// 刚创建时不可用,但 layout 读取不受影响)
	const tabId = await findTerminalId(null, wtPath);
	if (tabId) {
		setWorkflowMeta(db, workflowId, MASTER_TAB_KEY, tabId);
	}
	addEvent(db, {
		workflowId,
		type: EVT.masterStarted,
		payload: {
			masterBranch: masterBranch(workflowId),
			worktree: name,
			tabId: tabId ?? null,
		},
	});
	return {
		ok: true,
		workflowId,
		masterWorktree: wtPath,
		masterBranchName: masterBranch(workflowId),
		tabId,
	};
}

// ────────────────────────────────────────────────────────────
// master-merge:发起方合并主控 gittree 回主分支(用户需求第 7 步)
// ────────────────────────────────────────────────────────────
export interface MergeMasterOptions {
	gittreeBin?: string;
}

export interface MergeMasterResult {
	ok: boolean;
	workflowId?: string;
	error?: string;
	/** 合并时主控 tab 已关闭(可能早已关闭) */
	tabClosed?: boolean;
}

/**
 * 发起方决定合并:把主控 gittree 分支合并回发起方当前分支:
 *   1. 校验:master 模式 + 状态 awaiting-merge(主控已完成目标把关)
 *   2. 关闭主控会话 tab(终局,不再需要)
 *   3. gittree merge wf-master-<id> --delete(合入当前分支,删 worktree+分支)
 *   4. workflow → completed + master_merged / workflow_completed 事件
 */
export async function mergeMaster(
	db: DatabaseSync,
	workflowId: string,
	opts: MergeMasterOptions = {},
): Promise<MergeMasterResult> {
	const wf = getWorkflow(db, workflowId);
	if (!wf) {
		return { ok: false, error: `workflow 不存在: ${workflowId}` };
	}
	if (!isMasterMode(db, workflowId)) {
		return {
			ok: false,
			error: `workflow ${workflowId} 不是 master-agent 模式(无主控 gittree)`,
		};
	}
	if (wf.status === WORKFLOW_STATUS.completed) {
		return {
			ok: true,
			workflowId,
			error: `workflow ${workflowId} 已合并完成(重复执行无操作)`,
		};
	}
	if (wf.status !== WORKFLOW_STATUS.awaitingMerge) {
		return {
			ok: false,
			error: `workflow ${workflowId} 状态为 ${wf.status},仅 awaiting-merge(主控已完成)可合并;主控仍在执行或已失败`,
		};
	}
	const name = masterName(workflowId);
	const gittreeBin = opts.gittreeBin ?? resolveBin("gittree");

	// 1. 关主控会话 tab(尽力而为;已关则跳过)
	let tabClosed = false;
	const masterTab = getWorkflowMeta(db, workflowId, MASTER_TAB_KEY) as
		| string
		| undefined;
	if (masterTab) {
		try {
			await closeTerminal(masterTab);
			tabClosed = true;
			addEvent(db, {
				workflowId,
				type: EVT.masterTabClosed,
				payload: { tabId: masterTab, reason: "master-merge" },
			});
		} catch {
			/* 已关闭/查询失败 → 跳过,不阻断合并 */
		}
	}

	// 1.5 清理主控 worktree 的临时产物(非代码产出,会拦截 gittree merge 的
	// 干净检查——真实现象:主控会话遗留 .pi-glla / plan.json 导致合并失败)。
	// 已知临时条目直接删;其他 untracked 交给 gittree 报错(不误删主控产出)。
	const masterWt = masterWorktreePath(wf.repo_path, workflowId);
	const TEMP_ENTRIES = new Set([".pi-glla", "plan.json", ".DS_Store"]);
	for (const name of TEMP_ENTRIES) {
		const p = path.join(masterWt, name);
		if (fs.existsSync(p)) {
			try {
				fs.rmSync(p, { recursive: true, force: true });
			} catch {
				/* 清理失败交给 gittree 的报错兜底 */
			}
		}
	}

	// 2. 合并主控 gittree 到发起方当前分支(--delete 删 worktree+分支)
	const mergeRes = await run(
		gittreeBin,
		["merge", name, "--delete"],
		wf.repo_path,
	);
	if (mergeRes.code !== 0) {
		return {
			ok: false,
			workflowId,
			error: `主控 gittree 合并失败: ${mergeRes.stderr || mergeRes.stdout}`,
		};
	}

	// 2.5 兜底清理:终态步骤残留的 tab/worktree(主控未清理干净的场景;
	// 占用中的由 gittree clean 跳过,不阻断合并)
	for (const st of getStepsByWorkflow(db, workflowId)) {
		if (st.tab_id && (st.status === "done" || st.status === "skipped")) {
			try {
				await closeTerminal(st.tab_id);
			} catch {
				/* 尽力而为 */
			}
		}
		if (st.worktree) {
			await run(
				gittreeBin,
				["clean", st.worktree, "--branch", "--force"],
				wf.repo_path,
			);
		}
	}

	// 3. 终态
	updateWorkflowStatus(db, workflowId, WORKFLOW_STATUS.completed);
	addEvent(db, {
		workflowId,
		type: EVT.masterMerged,
		payload: { masterBranch: masterBranch(workflowId), tabClosed },
	});
	addEvent(db, { workflowId, type: EVT.workflowCompleted });
	return { ok: true, workflowId, tabClosed };
}

// ────────────────────────────────────────────────────────────
// master-fail:主控放弃(无法继续)→ 通知发起方人工介入
// ────────────────────────────────────────────────────────────
export function markMasterFailed(
	db: DatabaseSync,
	workflowId: string,
	reason: string,
): { ok: boolean; error?: string } {
	const wf = getWorkflow(db, workflowId);
	if (!wf) {
		return { ok: false, error: `workflow 不存在: ${workflowId}` };
	}
	if (!isMasterMode(db, workflowId)) {
		return {
			ok: false,
			error: `workflow ${workflowId} 不是 master-agent 模式`,
		};
	}
	if (
		wf.status === WORKFLOW_STATUS.completed ||
		wf.status === WORKFLOW_STATUS.failed ||
		wf.status === WORKFLOW_STATUS.aborted
	) {
		return {
			ok: false,
			error: `workflow ${workflowId} 已终态(${wf.status}),无需标记失败`,
		};
	}
	updateWorkflowStatus(db, workflowId, WORKFLOW_STATUS.failed);
	addEvent(db, {
		workflowId,
		type: EVT.masterFailed,
		payload: { reason: reason.trim() || "(未说明)" },
	});
	return { ok: true };
}
