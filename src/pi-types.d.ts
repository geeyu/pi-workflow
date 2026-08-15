/**
 * pi 扩展 API 最小类型面(@earendil-works/pi-coding-agent 本地声明)
 *
 * 运行时由 pi 进程提供,此处仅为 TypeScript 类型检查(import type 会被擦除,
 * 不影响运行)。若需完整类型,可自行 npm i -D @earendil-works/pi-coding-agent。
 */
declare module "@earendil-works/pi-coding-agent" {
	export interface ExtensionUI {
		select(
			title: string,
			options: string[],
			opts?: { timeout?: number },
		): Promise<string | undefined>;
		confirm(title: string, message: string, opts?: { timeout?: number }): Promise<boolean>;
		input(title: string, placeholder?: string, opts?: { timeout?: number }): Promise<string | undefined>;
		notify(message: string, type?: "info" | "warning" | "error"): void;
		setStatus(key: string, text: string | undefined): void;
		setWidget(
			key: string,
			content: string[] | undefined,
			options?: { placement?: "aboveEditor" | "belowEditor" },
		): void;
		setTitle(title: string): void;
		setEditorText(text: string): void;
	}

	export interface ExtensionCommandContext {
		cwd: string;
		ui: ExtensionUI;
	}

	export interface ExtensionAPI {
		on(event: string, handler: (event: unknown, ctx: ExtensionCommandContext) => unknown): void;
		registerCommand(
			name: string,
			options: {
				description?: string;
				getArgumentCompletions?: (
					prefix: string,
				) =>
					| Array<{ value: string; label: string }>
					| null
					| Promise<Array<{ value: string; label: string }> | null>;
				handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
			},
		): void;
		/**
		 * 向会话注入自定义消息(参与 LLM 上下文,可驱动主控自主执行 /wf 命令)。
		 * deliverAs: "steer"(默认,当前工具流后投递)/ "followUp"(等 agent 全部工具执行完再投递,
		 * 不打断进行中对话)/ "nextTurn"(下一个用户输入时投递)。triggerTurn:空闲时立即触发一轮。
		 */
		sendMessage<T = unknown>(
			message: {
				customType: string;
				content: string | Array<{ type: string; text?: string; source?: unknown }>;
				display?: boolean;
				details?: T;
			},
			options?: {
				triggerTurn?: boolean;
				deliverAs?: "steer" | "followUp" | "nextTurn";
			},
		): Promise<void>;
		/** 发送一条真实用户消息(总是触发一轮;流式中必须指定 deliverAs) */
		sendUserMessage(
			content: string | Array<{ type: string; text?: string; source?: unknown }>,
			options?: {
				deliverAs?: "steer" | "followUp";
				expandPromptTemplates?: boolean;
			},
		): Promise<void>;
	}
}
