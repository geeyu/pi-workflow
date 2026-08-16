/**
 * ui/notify.ts — 主控自主编排通知(arch-refactor §3.3,自 src/index.ts 同名迁移)
 *
 * - sendWorkflowNotifications:同一 tick 多条状态事件聚合为一条消息
 *   (pi.sendMessage followUp,不打断主控;降级 ctx.ui.notify;两条通道都失败 → 不标记下轮重试);
 * - P0-3 结构化渲染:内容自带状态字形与各 workflow 进度摘要(降级 markdown 也可读),
 *   另附 details 结构化数据,index.ts 注册 registerMessageRenderer("workflow-notify")
 *   后对话流中以「字形着色 + /wf 命令高亮」渲染(见 ui/renderers.ts);
 * - WorkflowNotifySender:通知发送通道的最小类型面(便于测试注入);
 * - NOTIFY_MAX_LINES:单次聚合通知的最大行数,超出留到下一轮。
 */
import type { DatabaseSync } from "node:sqlite";
import { getStepsByWorkflow, stepStatusCounts } from "../core/db.ts";
import {
	isNotifyItemFresh,
	markNotified,
	type NotifyItem,
	type NotifyKind,
} from "../observe/monitor.ts";
import { PLAN_ICON } from "./status.ts";

/** 通知发送通道的最小类型面(pi.sendMessage + ctx.ui.notify,便于测试注入) */
export interface WorkflowNotifySender {
	sendMessage: (
		message: {
			customType: string;
			content: string;
			display: boolean;
			details?: WorkflowNotifyDetails;
		},
		options: { deliverAs: "followUp"; triggerTurn: boolean },
	) => Promise<unknown>;
	ui: {
		notify: (message: string, type?: "info" | "warning" | "error") => void;
	};
}

/** 单次聚合通知的最大行数,超出留到下一轮 */
export const NOTIFY_MAX_LINES = 5;

/** 事件 kind → 状态字形(与面板/status 字形表同源,见 ui/status.ts PLAN_ICON) */
export const NOTIFY_GLYPH: Record<NotifyKind, string> = {
	reported: PLAN_ICON.verify, // ◐
	"waiting-verify": PLAN_ICON.verify,
	failed: PLAN_ICON.abnormal, // ✗
	aborted: PLAN_ICON.abnormal,
	conflict: PLAN_ICON.conflict, // ⚠
	"needs-fix": PLAN_ICON.needsFix, // ↻
	"wave-done": PLAN_ICON.done, // ✓
	"workflow-done": PLAN_ICON.done,
	"master-done": PLAN_ICON.done,
	"master-failed": PLAN_ICON.abnormal,
};

/** 渲染器用的结构化载荷(对话流组件渲染;无渲染器时降级 content markdown) */
export interface WorkflowNotifyDetails {
	/** 每项事件(字形 + 文案,文案含可执行 /wf 命令) */
	items: Array<{
		workflowId: string;
		stepId?: string;
		waveSeq?: number;
		kind: NotifyKind;
		glyph: string;
		text: string;
	}>;
	/** 各 workflow 进度摘要(字形 + 计数) */
	progress: Array<{ workflowId: string; text: string }>;
}

/** 单 workflow 进度段:● <id> done/total ✓d 🔄r ◐v ✗a(与面板标题同构) */
function progressText(db: DatabaseSync, workflowId: string): string | null {
	const steps = getStepsByWorkflow(db, workflowId);
	if (steps.length === 0) return null;
	const counts = stepStatusCounts(db, workflowId);
	const done = (counts.done ?? 0) + (counts.skipped ?? 0);
	const running = (counts.dispatched ?? 0) + (counts.running ?? 0);
	const verify = (counts.reported ?? 0) + (counts["waiting-verify"] ?? 0);
	const abnormal =
		(counts.failed ?? 0) +
		(counts.aborted ?? 0) +
		(counts.conflict ?? 0) +
		(counts["needs-fix"] ?? 0);
	const parts = [`● ${workflowId}`, `${done}/${steps.length}`];
	if (running > 0) parts.push(`${PLAN_ICON.running}${running}`);
	if (verify > 0) parts.push(`${PLAN_ICON.verify}${verify}`);
	if (abnormal > 0) parts.push(`${PLAN_ICON.abnormal}${abnormal}`);
	if (done > 0) parts.push(`${PLAN_ICON.done}${done}`);
	return parts.join(" ");
}

/**
 * 聚合发送状态事件通知(主控自主编排):
 * - 同一 tick 多条合并为一条消息,最多 NOTIFY_MAX_LINES 行(超出不标记,下轮再发);
 * - 内容 = 进度摘要行(每 workflow 一段,状态字形 + 计数)+ 逐条事件(字形前缀 + 可执行命令);
 *   降级路径(无 renderer 的 markdown toast)同样可读;
 * - details 携带结构化 items/progress,供 registerMessageRenderer 组件化渲染;
 * - 通道:pi.sendMessage({customType:"workflow-notify",...},{deliverAs:"followUp",triggerTurn:true})
 *   followUp 不打断主控进行中的对话;triggerTurn 在空闲时唤醒主控,自主执行 /wf verify/merge/下发;
 * - 降级:sendMessage 抛错 → ctx.ui.notify(仅 TUI 提示);两条通道都失败 → 不标记,下轮重试;
 * - 发送成功(含降级)的项才 markNotified,保证「每种事件每步骤每 attempt 只通知一次」。
 */
export async function sendWorkflowNotifications(
	db: DatabaseSync,
	sender: WorkflowNotifySender,
	items: NotifyItem[],
): Promise<void> {
	// 发送前验证:状态已变化的旧事件丢弃(monitor 重启/长会话补发场景)
	const fresh = items.filter((i) => isNotifyItemFresh(db, i));
	const toSend = fresh.slice(0, NOTIFY_MAX_LINES);
	if (toSend.length === 0) return;
	// 进度摘要:按 workflow 去重,各取一段(如 ● demo-wf 3/8 ✓3 🔄1 ◐2 ✗1)
	const wfIds = [...new Set(toSend.map((i) => i.workflowId))];
	const progress = wfIds
		.map((id) => {
			const text = progressText(db, id);
			return text ? { workflowId: id, text } : null;
		})
		.filter((p): p is NonNullable<typeof p> => p !== null);
	const details: WorkflowNotifyDetails = {
		items: toSend.map((i) => ({
			workflowId: i.workflowId,
			stepId: i.stepId,
			waveSeq: i.waveSeq,
			kind: i.kind,
			glyph: NOTIFY_GLYPH[i.kind],
			text: i.text,
		})),
		progress,
	};
	const progressLine =
		progress.length > 0 ? `${progress.map((p) => p.text).join(" | ")} → ` : "";
	const content = [
		`[wf ${new Date().toLocaleTimeString()}] ${progressLine}${toSend.length} 个关键事件(可依次执行):`,
		...toSend.map((i) => `- ${NOTIFY_GLYPH[i.kind]} ${i.text}`),
	].join("\n");
	let delivered = false;
	try {
		await sender.sendMessage(
			{ customType: "workflow-notify", content, display: true, details },
			{ deliverAs: "followUp", triggerTurn: true },
		);
		delivered = true;
	} catch {
		try {
			sender.ui.notify(content, "info");
			delivered = true;
		} catch {
			/* 两条通道都失败:不标记,下轮重试 */
		}
	}
	if (delivered) {
		for (const item of toSend) markNotified(db, item);
	}
}
