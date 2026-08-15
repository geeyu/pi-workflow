/**
 * session.ts — 主控 pi 会话读取(wf session 用)
 *
 * 目录规则:~/.pi/agent/sessions/<cwd 编码>/,cwd 编码(实测):
 *   去掉前导 /、/ 替换为 -,整体包 -- 前后缀。
 *   例:/Users/geeyu/.pi/agent/extensions/workflow
 *      → --Users-geeyu-.pi-agent-extensions-workflow--
 * 文件:取 mtime 最新的 *.jsonl(一次会话一个文件,不跨文件聚合)。
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** cwd → 会话目录名(编码规则见文件头) */
export function encodeSessionDir(cwd: string): string {
	const stripped = cwd.replace(/^\/+/, "").replace(/\/+$/, "");
	return `--${stripped.replace(/\//g, "-")}--`;
}

export interface SessionMessage {
	/** 行内 timestamp(ISO) */
	ts: string;
	/** user / assistant / notify(custom_message) */
	role: string;
	text: string;
}

const SKIP_TYPES = new Set(["session", "model_change", "thinking_level_change"]);

/**
 * 解析一行 jsonl:
 * - session/model_change/thinking_level_change → null(跳过);
 * - message → role + content 中所有 {type:"text"} 拼接(thinking/toolCall 跳过);
 * - custom_message(如 workflow-notify)→ role=notify,content 为文本;
 * - 其余未知 type / 无文本 → null。
 */
export function parseSessionLine(raw: string): SessionMessage | null {
	let line: Record<string, unknown>;
	try {
		line = JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return null;
	}
	const type = line.type;
	const ts = typeof line.timestamp === "string" ? line.timestamp : "";
	if (typeof type !== "string" || SKIP_TYPES.has(type)) return null;
	if (type === "message") {
		const msg = line.message as { role?: string; content?: unknown } | undefined;
		if (!msg) return null;
		const content = Array.isArray(msg.content) ? msg.content : [];
		const text = content
			.flatMap((p) =>
				typeof p === "object" &&
				p !== null &&
				(p as { type?: string }).type === "text"
					? [(p as { text?: string }).text ?? ""]
					: [],
			)
			.join("");
		if (!text) return null; // 纯 thinking/toolCall 消息跳过
		return { ts, role: msg.role === "user" ? "user" : "assistant", text };
	}
	if (type === "custom_message") {
		const content = typeof line.content === "string" ? line.content : "";
		if (!content) return null;
		return { ts, role: "notify", text: content };
	}
	return null;
}

/** 定位 cwd 对应会话目录下 mtime 最新的 *.jsonl;目录不存在/无 jsonl → null */
export function findLatestSessionFile(
	sessionsRoot: string,
	cwd: string,
): string | null {
	const dir = path.join(sessionsRoot, encodeSessionDir(cwd));
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return null;
	}
	const jsonls: string[] = [];
	for (const f of entries) {
		if (!f.endsWith(".jsonl")) continue;
		jsonls.push(path.join(dir, f));
	}
	jsonls.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
	return jsonls[0] ?? null;
}
