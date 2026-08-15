/**
 * index.ts — workflow 插件入口(/wf 命令族 + widget + 子 pi 身份绑定)
 *
 * 编排者侧(主 pi):/wf import / dispatch / verify / status / tree / step / events
 * 子任务侧(子 pi):/wf context / done / fail(身份经 PI_WF_* 环境变量或 cwd 解析)
 *
 * 命令体已收敛到 src/command.ts 注册表,本文件 handler 查表派发;
 * 生命周期(session_start/shutdown、monitor、resources_discover)保留在本文件。
 * resolveIdentity / workflowStatusSegment 保留再导出(兼容既有调用面/测试)。
 *
 * 设计文档:../DESIGN.md;实现契约:docs/arch-refactor.md
 */
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { DatabaseSync } from "node:sqlite";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** 本扩展目录(兼容 jiti 的 CJS/ESM 两种加载) */
const EXT_DIR =
	typeof __dirname !== "undefined"
		? __dirname
		: path.dirname(fileURLToPath(import.meta.url));
import {
	getCommand,
	listCommands,
	UsageError,
	resolveIdentity,
	type CmdEnv,
} from "./command.ts";
import { renderWorkflowStatus, workflowStatusSegment } from "./ui/status.ts";
import { getDb } from "./db.ts";
import {
	recoverStaleSteps,
	startMonitor,
	markNotified,
	type NotifyItem,
} from "./monitor.ts";

// 兼容再导出(定义已移至 command.ts / ui/status.ts)
export { resolveIdentity, type WfIdentity } from "./command.ts";
export { workflowStatusSegment } from "./ui/status.ts";

function notify(
	ctx: ExtensionCommandContext,
	message: string,
	type: "info" | "warning" | "error" = "info",
): void {
	ctx.ui.notify(message, type);
}

// ────────────────────────────────────────────────────────────
// 主控自主编排通知(设计增强①:monitor 状态事件 → sendMessage)
// ────────────────────────────────────────────────────────────
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

// ────────────────────────────────────────────────────────────
// 插件入口(命令注册 + 生命周期)
// ────────────────────────────────────────────────────────────
export default function workflowExtension(pi: ExtensionAPI) {
	const db = getDb();

	// ── /wf 命令:查注册表派发(command.ts)──────────────────
	pi.registerCommand("wf", {
		description:
			"workflow 编排:import/dispatch/context/done/fail/verify/status/tree/step/events",
		getArgumentCompletions: (prefix) =>
			listCommands("pi")
				.map((d) => d.name)
				.filter((w) => w.startsWith(prefix))
				.map((w) => ({ value: w, label: w })),
		handler: async (args, ctx) => {
			const [sub, ...rest] = args.trim().split(/\s+/);
			const def = getCommand(sub);
			if (!def || def.entry === "cli") {
				notify(
					ctx,
					`用法: /wf import|dispatch|context|done|fail|verify|merge|status|tree|step|events\n示例: /wf status / /wf import plan.json / /wf done 1.1 '{"summary":"..."}'`,
					"warning",
				);
				return;
			}
			const env: CmdEnv = {
				kind: "pi",
				cwd: ctx.cwd,
				db,
				show: (lines) => {
					if (def.widget) ctx.ui.setWidget(def.widget, lines);
					else notify(ctx, lines.join("\n"), "info");
				},
				info: (line) => notify(ctx, line, "info"),
				warn: (line) => notify(ctx, line, "warning"),
				fail: (line) => notify(ctx, line, "error"),
				notifyPi: (line) => notify(ctx, line, "info"),
				setExitCode: () => {
					/* pi 无退出码 */
				},
			};
			try {
				await def.run(rest, env);
			} catch (e) {
				if (e instanceof UsageError) {
					notify(ctx, `用法: ${def.usage}`, "warning");
				} else {
					notify(ctx, `wf 命令失败: ${(e as Error).message}`, "error");
				}
			} finally {
				renderWorkflowStatus(ctx, db);
			}
		},
	});

	// ── 注册本插件 skill(使用与排查手册)──────────────────
	// skill 目录在仓库根 skill/,而 EXT_DIR 指向 src/,故需回退一级
	pi.on("resources_discover", async (_event, _ctx) => {
		return { skillPaths: [path.resolve(EXT_DIR, "..", "skill")] };
	});

	// ── 存活轮询句柄(编排者侧)────────────────────────────
	let monitorStop: (() => void) | null = null;

	// ── session_start:子 pi 设标题;编排者崩溃恢复 + 启动轮询 ─
	pi.on("session_start", async (_event, ctx) => {
		const ident = resolveIdentity(ctx.cwd);
		if (ident?.stepId) {
			ctx.ui.setTitle(`wf ${ident.workflowId}/${ident.dotted}`);
		} else {
			// 崩溃恢复:running/dispatched 但 tab 已消失 → aborted(设计 §4.5)
			try {
				const { closed } = await recoverStaleSteps(db);
				if (closed.length > 0) {
					ctx.ui.notify(
						`[wf] 崩溃恢复:tab 已消失的步骤标 aborted: ${closed.join(", ")}`,
						"warning",
					);
				}
			} catch {
				/* 恢复失败不阻塞启动 */
			}
			// 存活轮询(5s,设计决策 12)+ 状态事件通知(设计增强①)
			monitorStop = startMonitor(db, {
				onClosed: (closed) =>
					ctx.ui.notify(
						`[wf] tab 关闭未回报 → aborted: ${closed.join(", ")}`,
						"warning",
					),
				onState: (items) =>
					sendWorkflowNotifications(
						db,
						{ sendMessage: pi.sendMessage.bind(pi), ui: ctx.ui },
						items,
					),
				onTick: () => renderWorkflowStatus(ctx, db),
			});
		}
		renderWorkflowStatus(ctx, db);
	});

	pi.on("session_shutdown", async () => {
		monitorStop?.();
		monitorStop = null;
	});
}
