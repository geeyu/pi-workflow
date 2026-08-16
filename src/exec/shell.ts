/**
 * exec/shell.ts — 无状态工具层:进程执行 + 可执行文件解析 + worktree 路径计算
 * (arch-refactor §3.4,自 src/exec/dispatch.ts 同名迁移;三者均无依赖,最先 import)
 *
 * - run:execFile 封装(进程 PATH 可能缺失 brew 目录,补充常用位);
 * - resolveBin / resolveOnPath:gittree/pi 可执行文件解析(窗口操作已内化为
 *   exec/ghostty.ts 直接调 osascript,不再解析外部 CLI);
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
		// 当前进程 PATH 可能缺 brew 常用目录(gittree/ghostty 子 shell 场景),补充。
		const env = {
			...process.env,
			PATH: ["/opt/homebrew/bin", "/usr/local/bin", process.env.PATH ?? ""].join(
				":",
			),
		};
		execFile(cmd, args, { cwd, timeout: 120_000, env }, (err, stdout, stderr) => {
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
		});
	});
}

/**
 * 子 pi 启动命令(绝对路径,子 tab 的非交互 shell PATH 不可靠):
 * - 运行在 pi 插件内(argv[1] 为 pi 入口,如 dist/cli.js):复用当前进程的 node + pi 脚本;
 * - 运行在 wf CLI 下(argv[1] 为 src/cli.ts):解析真实 pi 入口
 *   (env PI_BIN → PATH → ~/.local/bin → fnm 安装目录),若为 js 脚本则 realpath 后交给
 *   显式 node 启动——pi 通常是指向 dist/cli.js 的符号链接,其 shebang 为
 *   `#!/usr/bin/env node`,子 shell PATH 无 node 时直接启动失败(tab 秒关);
 * - 兜底链走完仍找不到 → 返回裸 pi(Ghostty login shell 大概率也找不到,tab 秒关),
 *   但 fnm 扫描覆盖了本机 pi 的真实安装位,正常情况不会走到这一步。
 */

/** pi 子进程调用(node + 脚本,或裸可执行) */
export interface PiCommand {
	command: string;
	args: string[];
}

/**
 * 解析 pi 可执行文件(所有"启动子 pi"场景共用:子任务 tab、planner、master tab)。
 * 与 piInvocation 同源:当前进程是 pi 则复用其 node+脚本(不要求 basename 是 pi,
 * realpath 展开后可能是 cli.js —— planner 曾因只认 "pi" 而 fallback 到 PATH 导致
 * spawn pi ENOENT);否则按 PI_BIN → PATH → ~/.local/bin → fnm 兜底链解析。
 */
export function resolvePiCommand(): PiCommand {
	const script = process.argv[1];
	if (script && !script.startsWith("/$bunfs/") && fs.existsSync(script)) {
		const isWfCli =
			path.basename(script) === "cli.ts" &&
			script.includes(`${path.sep}extensions${path.sep}workflow${path.sep}`);
		if (!isWfCli) {
			return { command: process.execPath, args: [script] };
		}
	}
	const envBin = process.env.PI_BIN;
	if (envBin) {
		// 显式覆盖:信任调用方,不做存在性校验
		return { command: envBin, args: [] };
	}
	// 兜底链:PATH → ~/.local/bin/pi → fnm node-versions 各版本安装位(取最新)
	// 主控会话的 bash 工具 PATH 极简(无 npm 全局 bin),~/.local/bin 软链也可能缺失
	// (曾出现:dispatch 返回裸 pi → Ghostty env:pi: No such file → 子 tab 秒关)。
	for (const c of [
		resolveOnPath("pi"),
		path.join(os.homedir(), ".local", "bin", "pi"),
		...fnmPiCandidates(),
	]) {
		if (!c) continue;
		try {
			fs.accessSync(c, fs.constants.X_OK);
			const real = fs.realpathSync(c);
			return real.endsWith(".js")
				? { command: process.execPath, args: [real] }
				: { command: real, args: [] };
		} catch {
			/* 尝试下一个 */
		}
	}
	return { command: "pi", args: [] };
}

export function piInvocation(): string {
	const c = resolvePiCommand();
	return c.args.length > 0
		? `"${c.command}" "${c.args[0]}"`
		: `"${c.command}"`;
}

/**
 * fnm 各版本 node 安装目录下的 pi(版本号倒序,优先最新)。
 * ~/.local/share/fnm/node-versions/<v>/installation/bin/pi。
 */
function fnmPiCandidates(): string[] {
	const fnmRoot = path.join(
		os.homedir(),
		".local",
		"share",
		"fnm",
		"node-versions",
	);
	let versions: string[] = [];
	try {
		versions = fs
			.readdirSync(fnmRoot)
			.filter((v) => /^v?\d+\.\d+\.\d+$/.test(v))
			.sort((a, b) =>
				b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" }),
			); // 版本号数字倒序,优先最新
	} catch {
		return [];
	}
	return versions.map((v) => path.join(fnmRoot, v, "installation", "bin", "pi"));
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
 * 解析 gittree 可执行文件:
 * 优先 PATH,兜底已知安装位(与 gittree skill 的内部约定一致):
 * - gittree 本体: ~/.pi/agent/extensions/gittree/scripts/gittree.sh
 * (窗口操作不再解析外部 ghostctl —— exec/ghostty.ts 内化 osascript 实现。)
 */
export function resolveBin(name: "gittree"): string {
	const known: Record<typeof name, string> = {
		gittree: path.join(
			os.homedir(),
			".pi",
			"agent",
			"extensions",
			"gittree",
			"scripts",
			"gittree.sh",
		),
	};
	const local = path.join(os.homedir(), ".local", "bin", name);
	for (const c of [name, local, known[name]]) {
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
