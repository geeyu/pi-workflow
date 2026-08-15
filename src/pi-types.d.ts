/**
 * pi 扩展 API 最小类型面(@earendil-works/pi-coding-agent 本地声明)
 *
 * 运行时由 pi 进程提供,此处仅为 TypeScript 类型检查(import type 会被擦除,
 * 不影响运行)。若需完整类型,可自行 npm i -D @earendil-works/pi-coding-agent。
 */
declare module "@earendil-works/pi-coding-agent" {
	/** 主题语义色(跟随用户主题) */
	export type ThemeColor =
		| "accent"
		| "success"
		| "error"
		| "warning"
		| "muted"
		| "dim"
		| "text"
		| "toolTitle";

	export interface Theme {
		fg(color: ThemeColor, text: string): string;
		strikethrough(text: string): string;
		bold(text: string): string;
	}

	export interface WidgetComponent {
		render(width: number): string[];
		invalidate?(): void;
		dispose?(): void;
	}

	/** TUI 组件最小面(render 返回含 ANSI 的行;message renderer / widget factory 共用) */
	export interface Component {
		render(width: number): string[];
		invalidate(): void;
		dispose?(): void;
	}

	/** 自定义消息(registerMessageRenderer 的渲染入参;sendMessage 的投递形状) */
	export interface CustomMessage<T = unknown> {
		role: "custom";
		customType: string;
		content: string | Array<{ type: string; text?: string; source?: unknown }>;
		display: boolean;
		details?: T;
		timestamp: number;
	}

	export interface MessageRenderOptions {
		expanded: boolean;
		/** 输出水平内边距(outputPad 设置) */
		outputPad: number;
	}

	/** 自定义消息渲染器:返回 undefined/抛错 → 降级默认 markdown 渲染 */
	export type MessageRenderer<T = unknown> = (
		message: CustomMessage<T>,
		options: MessageRenderOptions,
		theme: Theme,
	) => Component | undefined;

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
		/** factory 形式:每帧渲染拿 theme(语义色)与 width(截断),主题切换自动重绘 */
		setWidget(
			key: string,
			content:
				| ((tui: unknown, theme: Theme) => WidgetComponent)
				| undefined,
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
		/** 注册自定义消息渲染器(customType 消息在对话流中以此渲染;未注册/undefined → markdown 降级) */
		registerMessageRenderer<T = unknown>(
			customType: string,
			renderer: MessageRenderer<T>,
		): void;
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
