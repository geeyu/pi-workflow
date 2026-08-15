/**
 * core/state.ts — 步骤/工作流状态常量与状态机迁移表(单一来源)
 *
 * STATUS_ICON / stepIcon 自 index.ts / cli.ts / board.ts 收敛到此处;
 * STEP_TRANSITIONS / WORKFLOW_TRANSITIONS 为状态机迁移表(1.2 起接线:
 * canTransition 在 updateStepStatus(strict) 与 reportDone/reportFail/
 * verifyStep/skip/resolve-conflict/fix-tab 等关键入口校验,非法迁移给出
 * 明确错误与合法目标列表,见 docs/ux-research.md P0-4)。
 *
 * 迁移表口径 = 生产代码真实路径(以 T6/T7/T10/T13/T15 与全调用点核对):
 * - done → conflict:mergeWave 合并失败把已 done 步骤标 conflict(人工解决)
 * - conflict → skipped:/wf skip 人工终态允许任意非终态
 * - aborted → reported/waiting-verify:子任务在 monitor 误判 aborted 后
 *   仍存活回报(tab 实存,恢复路径,与 dispatchStep 的 tab 复用语义一致)
 * - 同态幂等:from → from 永远合法(重复回报/重复标记不报错)
 */
export const STATUS_ICON: Record<string, string> = {
	pending: "○",
	ready: "○",
	dispatched: "▶",
	running: "▶",
	reported: "◐",
	"waiting-verify": "◐",
	done: "✓",
	skipped: "–",
	failed: "✗",
	aborted: "✗",
	conflict: "⚠",
	"needs-fix": "↻",
};

/** 步骤状态图标(入参为 status 字符串;原 index.ts 版入参为 StepRow) */
export function stepIcon(status: string): string {
	return STATUS_ICON[status] ?? "?";
}

/** 步骤状态合法迁移:key = 当前状态 → 允许的目标状态集 */
export const STEP_TRANSITIONS: Record<string, readonly string[]> = {
	// 子任务回报(reported/waiting-verify)可从任意非终态非冲突状态进入:
	// 手动纠正(pending/ready)、失败后人工确认(failed)、驳回后重报(needs-fix)、
	// monitor 误判后存活回报(aborted)——均为真实流程(T7/T14/T25b 冒烟覆盖)
	pending: [
		"ready",
		"dispatched",
		"failed",
		"aborted",
		"skipped",
		"reported",
		"waiting-verify",
	],
	ready: [
		"dispatched",
		"failed",
		"aborted",
		"skipped",
		"reported",
		"waiting-verify",
	],
	dispatched: ["running", "failed", "aborted", "skipped"],
	running: [
		"reported",
		"waiting-verify",
		"failed",
		"aborted",
		"conflict",
		"needs-fix",
		"done",
		"skipped",
	],
	reported: ["done", "needs-fix", "failed", "skipped"],
	"waiting-verify": ["done", "needs-fix", "failed", "skipped"],
	// done → conflict:mergeWave 合并失败(人工 resolve-conflict 回 done)
	done: ["conflict"],
	skipped: [],
	// failed/aborted/needs-fix 可重派(dispatched/running)、人工终态(skipped)、
	// 或存活重报(reported/waiting-verify)
	failed: [
		"dispatched",
		"running",
		"failed",
		"aborted",
		"needs-fix",
		"reported",
		"waiting-verify",
	],
	aborted: [
		"dispatched",
		"running",
		"failed",
		"aborted",
		"needs-fix",
		"reported",
		"waiting-verify",
	],
	"needs-fix": [
		"dispatched",
		"running",
		"failed",
		"aborted",
		"needs-fix",
		"reported",
		"waiting-verify",
	],
	// resolve-conflict → done;skip 人工终态也允许 conflict → skipped
	conflict: ["done", "failed", "aborted", "needs-fix", "skipped"],
};

/**
 * 状态迁移是否合法。同态幂等(from → from)视为合法(重复回报/重复标记
 * 不报错,与 rpiv-todo invariants.ts 的 isTransitionValid 语义一致)。
 */
export function canTransition(from: string, to: string): boolean {
	if (from === to) return true;
	return STEP_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * 非法迁移错误信息里的合法目标列表(含同态自身)。
 * 未知状态 → 空列表(迁移表外,报错时提示「未知状态」由调用方处理)。
 */
export function legalTargets(from: string): string[] {
	const targets = STEP_TRANSITIONS[from];
	if (!targets) return [];
	return [from, ...targets];
}

/** workflow 状态合法迁移(初稿,本期不接线) */
export const WORKFLOW_TRANSITIONS: Record<string, readonly string[]> = {
	idle: ["running"],
	running: ["paused", "verifying", "completed", "failed", "aborted"],
	paused: ["running"],
	verifying: ["completed", "running"],
	completed: [],
	failed: [],
	aborted: [],
};
