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
	}
}
