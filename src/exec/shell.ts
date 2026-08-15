/**
 * exec/shell.ts — 无状态工具层:进程执行 + 可执行文件解析 + worktree 路径计算
 * (arch-refactor §3.4,自 src/exec/dispatch.ts 同名迁移;三者均无依赖,最先 import)
 *
 * - run:execFile 封装(Ghostty 非交互 shell 的 PATH 极简,补充 brew 常用目录);
 * - resolveBin / resolveOnPath:gittree/ghostctl/pi 可执行文件解析;
 * - piInvocation:子 pi 启动命令(绝对路径,子 tab 的 PATH 不可靠);
 * - worktreeName / worktreePath:gittree worktree 命名与路径约定(window/template/dispatch 三方共用)。
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

export function run(
	cmd: string,
	args: string[],
	cwd: string,
): Promise<RunResult> {
	return new Promise((resolve) => {
		// Ghostty 新窗口的非交互 shell 的 PATH 极简(无 brew),会命中系统旧版
		// python3(3.9,不支持 str | None 语法导致 ghostctl 报错)。补充常用目录。
		const env = {
			...process.env,
			PATH: [
				"/opt/homebrew/bin",
				"/usr/local/bin",
				process.env.PATH ?? "",
			].join(":"),
		};
		execFile(
			cmd,
			args,
			{ cwd, timeout: 120_000, env },
			(err, stdout, stderr) => {
				if (!err) {
					resolve({
						code: 0,
						stdout: String(stdout ?? ""),
						stderr: String(stderr ?? ""),
					});
					return;
				}
				const errCode = (err as NodeJS.ErrnoException).code;
				const code = typeof errCode === "number" ? errCode : 1;
				resolve({
					code,
					stdout: String(stdout ?? ""),
					stderr: String(stderr ?? ""),
				});
			},
		);
	});
}

/**
 * 子 pi 启动命令(绝对路径,子 tab 的非交互 shell PATH 不可靠):
 * - 运行在 pi 插件内(argv[1] 为 pi 入口,如 dist/cli.js):复用当前进程的 node + pi 脚本;
 * - 运行在 wf CLI 下(argv[1] 为 src/cli.ts):解析真实 pi 入口
 *   (env PI_BIN → PATH → ~/.local/bin),若为 js 脚本则 realpath 后交给显式 node 启动——
 *   pi 通常是指向 dist/cli.js 的符号链接,其 shebang 为 `#!/usr/bin/env node`,
 *   子 shell PATH 无 node 时直接启动失败(tab 秒关)。
 */
export function piInvocation(): string {
	const script = process.argv[1];
	if (script && !script.startsWith("/$bunfs/") && fs.existsSync(script)) {
		const isWfCli =
			path.basename(script) === "cli.ts" &&
			script.includes(`${path.sep}extensions${path.sep}workflow${path.sep}`);
		if (!isWfCli) {
			return `"${process.execPath}" "${script}"`;
		}
	}
	const envBin = process.env.PI_BIN;
	if (envBin) {
		// 显式覆盖:信任调用方,不做存在性校验
		return `"${envBin}"`;
	}
	const found = resolveOnPath("pi") ?? path.join(os.homedir(), ".local", "bin", "pi");
	try {
		fs.accessSync(found, fs.constants.X_OK);
		const real = fs.realpathSync(found);
		return real.endsWith(".js")
			? `"${process.execPath}" "${real}"`
			: `"${real}"`;
	} catch {
		return "pi";
	}
}

/** 在 PATH 上找可执行文件(返回绝对路径;找不到返回 null) */
function resolveOnPath(name: string): string | null {
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!dir) continue;
		const candidate = path.join(dir, name);
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			return candidate;
		} catch {
			/* 尝试下一个 */
		}
	}
	return null;
}

/**
 * 解析 gittree/ghostctl 可执行文件:
 * 优先 PATH,兜底 ~/.local/bin(Ghostty 新窗口的非交互 shell 不含该路径)。
 */
export function resolveBin(name: "gittree" | "ghostctl"): string {
	const local = path.join(os.homedir(), ".local", "bin", name);
	for (const c of [name, local]) {
		try {
			fs.accessSync(c, fs.constants.X_OK);
			return c;
		} catch {
			/* 尝试下一个 */
		}
	}
	return name; // 让 execFile 报错更直观
}

export function worktreeName(workflowId: string, dotted: string): string {
	return `wf-${workflowId}-${dotted}`;
}

export function worktreePath(
	repoPath: string,
	workflowId: string,
	dotted: string,
): string {
	// gittree 约定:worktree 路径 <repo>/.worktrees/gittree-<name>
	return path.join(
		repoPath,
		".worktrees",
		`gittree-${worktreeName(workflowId, dotted)}`,
	);
}
