/**
 * ui/renderers.ts — 对话流自定义渲染器(P0-3)
 *
 * workflow-notify 消息的组件化渲染:状态字形着色 + 可执行 /wf 命令高亮,
 * 进度摘要行 dim。未注册渲染器 / 返回 undefined / 抛错时,pi 自动降级为
 * 默认 markdown 盒子渲染(内容含字形与命令,降级也可读)。
 *
 * 渲染器是纯函数(除返回的组件对象外无状态),组件 render 每帧拿宽度,
 * 行内 ANSI 由 theme.fg 产出,超宽截断按可见宽度(跳过转义序列)。
 */
import type {
	Component,
	MessageRenderer,
	Theme,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import type { WorkflowNotifyDetails } from "./notify.ts";

/** 事件 kind → 字形颜色(与面板语义一致:核对=warning,异常=error,完成=success) */
const KIND_COLOR: Record<string, ThemeColor> = {
	reported: "warning",
	"waiting-verify": "warning",
	failed: "error",
	aborted: "error",
	conflict: "error",
	"needs-fix": "error",
	"wave-done": "success",
	"workflow-done": "success",
};

/** 可执行命令片段(文案由本插件生成,命令形如 `/wf verify 1.1 approve`,终止于空白/CJK/中文标点/斜杠分隔符) */
const WF_CMD_RE = /\/wf(?: [^\s()，。、；;：:【】\u4e00-\u9fff/]+)+/g;

/** 高亮 `/wf …` 命令片段(accent 色) */
function highlightCommands(theme: Theme, text: string): string {
	return text.replace(WF_CMD_RE, (m) => theme.fg("accent", m));
}

/** 行内可见宽度(跳过 ANSI 转义序列) */
function visibleWidth(s: string): number {
	let n = 0;
	let i = 0;
	while (i < s.length) {
		if (s.charCodeAt(i) === 0x1b) {
			// 跳过 \x1b[…m 整段
			while (i < s.length && s[i] !== "m") i++;
			i++;
			continue;
		}
		n += s.charCodeAt(i) > 0xff ? 2 : 1;
		i++;
	}
	return n;
}

/** 按可见宽度截断含 ANSI 的行(截断后补 reset,避免颜色泄漏到下一行) */
function truncateAnsi(s: string, n: number): string {
	if (visibleWidth(s) <= n) return s;
	let out = "";
	let w = 0;
	let i = 0;
	while (i < s.length) {
		if (s.charCodeAt(i) === 0x1b) {
			while (i < s.length && s[i] !== "m") i++;
			i++;
			out += s.slice(0, i); // 保留转义序列
			continue;
		}
		const cw = s.charCodeAt(i) > 0xff ? 2 : 1;
		if (w + cw > n - 1) break;
		out += s[i];
		w += cw;
		i++;
	}
	return out + "…\x1b[0m";
}

/**
 * workflow-notify 渲染器:
 * - 有 details:进度行(dim)→ 每项「字形(按 kind 着色)+ 文案(命令高亮)」;
 * - 无 details(旧消息/外部构造):按 content 行渲染,首行 dim,命令仍高亮。
 */
export const renderWorkflowNotify: MessageRenderer<WorkflowNotifyDetails> = (
	message,
	_options,
	theme,
): Component => {
	const details = message.details;
	const content =
		typeof message.content === "string" ? message.content : "";
	return {
		render(width: number): string[] {
			// 强制限制:pi 传的 width 可能异常偏大(实测收到 346,远超终端宽),
			// 不依赖它——输出行永远不超过 104 列,杜绝超宽行。
			const limit = Math.min(Math.max(20, width - 2), 104);
			const lines: string[] = [];
			if (details && Array.isArray(details.items) && details.items.length > 0) {
				if (details.progress.length > 0) {
					lines.push(
						theme.fg(
							"dim",
							`[wf] ${details.progress.map((p) => p.text).join(" | ")}`,
						),
					);
				}
				for (const item of details.items) {
					const color = KIND_COLOR[item.kind] ?? "dim";
					lines.push(
						`${theme.fg(color, item.glyph)} ${highlightCommands(theme, item.text)}`,
					);
				}
			} else {
				const parts = content.split("\n");
				for (const [i, line] of parts.entries()) {
					if (line.length === 0) continue;
					lines.push(
						i === 0
							? theme.fg("dim", line)
							: highlightCommands(theme, line),
					);
				}
			}
			return lines.map((l) => truncateAnsi(l, limit));
		},
		invalidate(): void {
			/* 无缓存状态,无需处理 */
		},
	};
};
