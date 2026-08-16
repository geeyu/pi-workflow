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
 * 设计文档:../docs/DESIGN.md;实现契约:docs/arch-refactor.md
 */

import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

/** 本扩展目录(兼容 jiti 的 CJS/ESM 两种加载) */
const EXT_DIR =
	typeof __dirname !== "undefined"
		? __dirname
		: path.dirname(fileURLToPath(import.meta.url));

import {
	type CmdEnv,
	getCommand,
	listCommands,
	resolveIdentity,
	UsageError,
} from "./command.ts";
import { getDb, StepTransitionError } from "./core/db.ts";
import {
	filterNotifyItems,
	markNotified,
	type NotifyItem,
	recoverStaleSteps,
	startMonitor,
} from "./observe/monitor.ts";
import {
	hideCompletedFromPreviousTurn,
	renderWorkflowStatus,
	resetCompletedDisplayState,
	togglePlanCollapsed,
	workflowStatusSegment,
} from "./ui/status.ts";

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

import { COLLAPSE_KEY_OFF, resolveCollapseKey } from "./config.ts";
// ────────────────────────────────────────────────────────────
// 主控自主编排通知(arch-refactor §3.3 / §4.1)
// sendWorkflowNotifications 定义块已移至 ./ui/notify.ts(1.2 唯一改动区域),
// 调用点(workflowExtension 内 onState)经本地 import 使用,此处再导出保持外部
// 调用面(test/workflow.test.ts 等)零改动。
// ────────────────────────────────────────────────────────────
import { NOTIFY_MAX_LINES, sendWorkflowNotifications } from "./ui/notify.ts";

export {
	NOTIFY_MAX_LINES,
	sendWorkflowNotifications,
	type WorkflowNotifySender,
} from "./ui/notify.ts";

import { renderWorkflowNotify } from "./ui/renderers.ts";

// ────────────────────────────────────────────────────────────
// 插件入口(命令注册 + 生命周期)
// ────────────────────────────────────────────────────────────
export default function workflowExtension(pi: ExtensionAPI) {
	const db = getDb();

	// ── workflow-notify 结构化渲染(P0-3):状态字形着色 + /wf 命令高亮 ──
	// 未注册/渲染器异常时 pi 自动降级 markdown(内容自带字形与命令,降级可读)
	pi.registerMessageRenderer("workflow-notify", renderWorkflowNotify);

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
				} else if (e instanceof StepTransitionError) {
					// 状态机迁移校验错误(updateStepStatus strict):消息已含合法目标列表
					notify(ctx, e.message, "error");
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

	// ── 面板折叠快捷键(P0-2):默认 ctrl+shift+t,配置 collapseKey="off" 禁用。
	// 键位在扩展加载时解析一次(改配置需 /reload 重绑,同 rpiv-todo);
	// handler 折叠/展开并立即重绘面板。无 UI(headless)时 no-op。
	const collapseKey = resolveCollapseKey();
	if (collapseKey !== COLLAPSE_KEY_OFF) {
		pi.registerShortcut(collapseKey, {
			description: "折叠/展开计划概览面板",
			handler: (ctx) => {
				// 会话隔离:子任务会话不渲染编排者面板(与 session_start 一致)
				if (resolveIdentity(ctx.cwd)?.stepId) return;
				togglePlanCollapsed();
				renderWorkflowStatus(ctx, db);
			},
		});
	}

	// ── session_start:子 pi 设标题;编排者崩溃恢复 + 启动轮询 ─
	pi.on("session_start", async (_event, ctx) => {
		// 任何会话启动都确保 .pi-glla 被仓库忽略(子 pi 运行时目录,非代码产出;
		// 否则 git status 的 untracked 改动会拦截 gittree merge 的干净检查)
		try {
			ensureGllaIgnored(ctx.cwd);
		} catch {
			/* 忽略失败,cleanup 的合并前置修复兜底 */
		}
		const ident = resolveIdentity(ctx.cwd, db);
		if (ident?.stepId) {
			// 子任务会话(worker):只设标题,不渲染编排者面板/状态条、不启动 monitor
			// (会话隔离强化:面板/通知/轮询只属于发起编排的会话,谁发起谁看)
			ctx.ui.setTitle(`wf ${ident.workflowId}/${ident.dotted}`);
			return;
		}
		// master-agent 模式:主控会话设专属标题(wf-master <id>);其余同编排者侧
		// (monitor 按 cwd 会话隔离天然只看到本 workflow;通知按角色过滤:step 级
		// 事件由主控处理,终局级 master-done/failed 只发给发起方)
		const sessionMasterId = ident?.master ? ident.workflowId : null;
		if (sessionMasterId) {
			ctx.ui.setTitle(`wf-master ${sessionMasterId}`);
		}
		// 编排者侧:崩溃恢复 + 面板完成行跟踪重置(全新上下文)
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
		resetCompletedDisplayState();
		// 存活轮询(5s,设计决策 12)+ 状态事件通知(设计增强①)
		// 会话隔离:monitor 只轮询/通知 cwd 所在仓库的 workflow(谁发起谁看)
		monitorStop = startMonitor(db, {
			cwd: ctx.cwd,
			onClosed: (closed) =>
				ctx.ui.notify(
					`[wf] tab 关闭未回报 → aborted: ${closed.join(", ")}`,
					"warning",
				),
			onState: (items) =>
				sendWorkflowNotifications(
					db,
					{ sendMessage: pi.sendMessage.bind(pi), ui: ctx.ui },
					filterNotifyItems(db, items, sessionMasterId),
				),
			onTick: () => renderWorkflowStatus(ctx, db),
		});
		renderWorkflowStatus(ctx, db);
	});

	// ── agent_start:收起上一 turn 完成的面板行(P1-3,参考 rpiv completedTaskIdsPendingHide)
	// 子会话已在上面的 session_start 提前 return,不会走到这里渲染
	pi.on("agent_start", async (_event, ctx) => {
		if (resolveIdentity(ctx.cwd)?.stepId) return;
		hideCompletedFromPreviousTurn();
		renderWorkflowStatus(ctx, db);
	});

	pi.on("session_shutdown", async () => {
		monitorStop?.();
		monitorStop = null;
	});
}
