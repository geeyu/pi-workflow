/**
 * core/state.ts — 状态常量与图标单一来源(arch-refactor §5)
 *
 * - STATUS_ICON / stepIcon:步骤状态 → 图标(单一来源,index/cli/board/ui 全部引用之);
 * - STEP_TRANSITIONS / canTransition:步骤状态合法迁移表(初稿,本期只建表不接线);
 * - WORKFLOW_TRANSITIONS:workflow 状态合法迁移表(初稿,本期只建表不接线)。
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

/** 步骤状态 → 图标(原 index.ts 版入参为 StepRow,签名微调为 status 字符串,行为不变) */
export function stepIcon(status: string): string {
	return STATUS_ICON[status] ?? "?";
}

/**
 * 步骤状态合法迁移:key = 当前状态 → 允许的目标状态集(从现状调用点提炼,初稿)。
 * 接线(用 canTransition 替换 orchestrator/dispatch 的散落 if 校验)列为后续 wave。
 */
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

/** 步骤状态迁移是否合法 */
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
