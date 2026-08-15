/**
 * ui/notify.ts — 主控自主编排通知(arch-refactor §3.3,自 src/index.ts 同名迁移)
 *
 * - sendWorkflowNotifications:同一 tick 多条状态事件聚合为一条消息
 *   (pi.sendMessage followUp,不打断主控;降级 ctx.ui.notify;两条通道都失败 → 不标记下轮重试);
 * - WorkflowNotifySender:通知发送通道的最小类型面(便于测试注入);
 * - NOTIFY_MAX_LINES:单次聚合通知的最大行数,超出留到下一轮。
 */
import type { DatabaseSync } from "node:sqlite";
import { markNotified, type NotifyItem } from "../monitor.ts";

/** 通知发送通道的最小类型面(pi.sendMessage + ctx.ui.notify,便于测试注入) */
export interface WorkflowNotifySender {
	sendMessage: (
		message: {
			customType: string;
			content: string;
			display: boolean;
		},
		options: { deliverAs: "followUp"; triggerTurn: boolean },
	) => Promise<unknown>;
	ui: {
		notify: (message: string, type?: "info" | "warning" | "error") => void;
	};
}

/** 单次聚合通知的最大行数,超出留到下一轮 */
export const NOTIFY_MAX_LINES = 5;

/**
 * 聚合发送状态事件通知(主控自主编排):
 * - 同一 tick 多条合并为一条消息,最多 NOTIFY_MAX_LINES 行(超出不标记,下轮再发);
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
	const toSend = items.slice(0, NOTIFY_MAX_LINES);
	if (toSend.length === 0) return;
	const content = [
		`[wf] ${toSend.length} 个关键事件(可依次执行):`,
		...toSend.map((i) => `- ${i.text}`),
	].join("\n");
	let delivered = false;
	try {
		await sender.sendMessage(
			{ customType: "workflow-notify", content, display: true },
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
