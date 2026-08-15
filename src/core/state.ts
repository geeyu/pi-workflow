/**
 * core/state.ts — 步骤/工作流状态常量与状态机迁移表(单一来源)
 *
 * STATUS_ICON / stepIcon 自 index.ts / cli.ts / board.ts 收敛到此处;
 * STEP_TRANSITIONS / WORKFLOW_TRANSITIONS 为状态机迁移表:步骤级已接线
 * (db.ts updateStepStatus 强制校验非法迁移);workflow 级暂未接线。
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

/** 步骤状态合法迁移(updateStepStatus 强制校验;2026-08 接线补全审计缺项:)
 * - dispatched → reported/waiting-verify:子 agent 快速回报的竞态护栏(正常路径先 running);
 * - done → conflict:merge 冲突会把已 done 步骤重新打开待解决(wave.ts mergeWave);
 * - failed/aborted/needs-fix/conflict → skipped:人工终态 /wf skip 允许从任何非终态进入;
 * - 同状态重复写入视为幂等(不报非法)。 */
export const STEP_TRANSITIONS: Record<string, readonly string[]> = {
	pending: [
		"ready",
		"dispatched",
		"reported",
		"waiting-verify",
		"failed",
		"aborted",
		"skipped",
	], // 人工回报/报失败不要求先派发(子 agent 或人工直接 /wf done|fail)
	ready: [
		"dispatched",
		"reported",
		"waiting-verify",
		"failed",
		"aborted",
		"skipped",
	],
	dispatched: [
		"running",
		"reported",
		"waiting-verify",
		"failed",
		"aborted",
		"skipped",
	],
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
	done: ["conflict"], // 终态;唯一例外:merge 冲突重新打开
	skipped: [],
	failed: ["dispatched", "running", "failed", "aborted", "needs-fix", "skipped"], // 可重派/人工终态
	aborted: ["dispatched", "running", "failed", "aborted", "needs-fix", "skipped"],
	"needs-fix": ["dispatched", "running", "failed", "aborted", "needs-fix", "skipped"],
	conflict: ["done", "failed", "aborted", "needs-fix", "skipped"], // resolve-conflict → done
};

export function canTransition(from: string, to: string): boolean {
	return STEP_TRANSITIONS[from]?.includes(to) ?? false;
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
