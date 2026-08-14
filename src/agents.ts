/**
 * agents.ts — agent 发现(设计文档 §6.1)
 *
 * agent 定义:
 *   ~/.pi/agent/agents/*.md(用户级,始终可用)
 *   .pi/agents/*.md(项目级,需 trustProjectAgents)
 * 格式:YAML frontmatter(name/description/tools/model)+ 正文 = system prompt
 *
 * 说明:不依赖 pi 包的 getAgentDir/parseFrontmatter,本地实现(零依赖、
 * 可在 pi 外独立测试);配置目录固定为 ~/.pi(个人扩展,不做 rebrand 适配)。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

export function getAgentDir(): string {
	return path.join(os.homedir(), ".pi", "agent", "agents");
}

export const CONFIG_DIR_NAME = ".pi";

interface ParsedFrontmatter<T extends Record<string, string>> {
	frontmatter: T;
	body: string;
}

/** 极简 frontmatter 解析:--- 包裹的 key: value 行 + 正文 */
function parseFrontmatter<T extends Record<string, string>>(
	content: string,
): ParsedFrontmatter<T> {
	const frontmatter = {} as T;
	let body = content;
	const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
	if (m) {
		body = m[2];
		for (const line of m[1].split("\n")) {
			const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
			if (kv) {
				(frontmatter as Record<string, string>)[kv[1]] = kv[2];
			}
		}
	}
	return { frontmatter, body };
}

function loadAgentsFromDir(
	dir: string,
	source: "user" | "project",
): AgentConfig[] {
	const out: AgentConfig[] = [];
	if (!fs.existsSync(dir)) return out;
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;
		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}
		const { frontmatter, body } =
			parseFrontmatter<Record<string, string>>(content);
		if (!frontmatter.name || !frontmatter.description) continue;
		out.push({
			name: frontmatter.name.trim(),
			description: frontmatter.description.trim(),
			tools: frontmatter.tools
				?.split(",")
				.map((t) => t.trim())
				.filter(Boolean),
			model: frontmatter.model?.trim() || undefined,
			systemPrompt: body.trim(),
			source,
			filePath,
		});
	}
	return out;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

/**
 * 发现 agent。scope:
 * - "user":仅用户级(默认)
 * - "project":仅项目级
 * - "both":项目级覆盖同名用户级
 */
export function discoverAgents(
	cwd: string,
	scope: AgentScope = "user",
): AgentDiscoveryResult {
	const userAgents = loadAgentsFromDir(getAgentDir(), "user");
	const projectDir = path.join(cwd, CONFIG_DIR_NAME, "agents");
	const projectAgents = loadAgentsFromDir(projectDir, "project");

	let agents: AgentConfig[];
	if (scope === "project") {
		agents = projectAgents;
	} else if (scope === "both") {
		const byName = new Map<string, AgentConfig>();
		for (const a of userAgents) byName.set(a.name, a);
		for (const a of projectAgents) byName.set(a.name, a);
		agents = [...byName.values()];
	} else {
		agents = userAgents;
	}

	return {
		agents,
		projectAgentsDir: fs.existsSync(projectDir) ? projectDir : null,
	};
}
