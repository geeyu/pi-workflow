/**
 * core/state.ts — 步骤/工作流状态常量与状态机迁移表(单一来源)
 *
 * STATUS_ICON / stepIcon 自 index.ts / cli.ts / board.ts 收敛到此处;
 * STEP_TRANSITIONS / WORKFLOW_TRANSITIONS 为状态机迁移表(本期只建表不接线,
 * 接线列为后续 wave,见 docs/arch-refactor.md §5.3)。
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

/** 步骤状态合法迁移:key = 当前状态 → 允许的目标状态集(从现状调用点提炼,初稿) */
export const STEP_TRANSITIONS: Record<string, readonly string[]> = {
	pending: ["ready", "dispatched", "failed", "aborted", "skipped"],
	ready: ["dispatched", "failed", "aborted", "skipped"],
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
	done: [],
	skipped: [],
	failed: ["dispatched", "running", "failed", "aborted", "needs-fix"], // 可重派
	aborted: ["dispatched", "running", "failed", "aborted", "needs-fix"],
	"needs-fix": ["dispatched", "running", "failed", "aborted", "needs-fix"],
	conflict: ["done", "failed", "aborted", "needs-fix"], // resolve-conflict → done
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
