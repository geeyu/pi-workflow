/**
 * cli.ts — pi-workflow 辅助命令行(创建/执行/排查)
 *
 * 本文件仅为 CLI 适配器:main() 查命令注册表(command.ts)派发,统一退出码
 * (0 成功 / 1 业务失败 / 3 用法错误)与统一错误格式;help 文本与重构前逐字一致。
 * 命令体全部在 src/command.ts 注册表,与插件入口(src/index.ts)双入口共享。
 *
 * 运行:node --experimental-strip-types src/cli.ts(入口 bin/wf)
 */
import {
	getCommand,
	UsageError,
	type CmdEnv,
} from "./command.ts";
import { getDb } from "./core/db.ts";

/** help 文本与重构前逐字一致(静态文本;命令清单与注册表一致性由测试保证) */
const HELP_TEXT = `pi-workflow CLI — 创建/执行/排查(设计 §6 skill 手册)

用法:
  wf plan "<需求目标>" [--repo <path>] [--workflow <id>]      planner 自动拆解(无 id=新建,有 id=追加 gap wave)
  wf plan-init <name> "<目标>" [--repo <path>] [--steps N]   生成 plan.json 模板
  wf import <plan.json>                                      校验 + 落库
  wf status [--json] [wfId]                                  状态全景
  wf tree [wfId]                                             层级任务树
  wf board [wfId] [--wave N] [--html out.html]                   看板(终端列布局/导出 HTML)
  wf step <id>                                               单步详情
  wf events [wfId] [N] [--follow]                            审计流
  wf dispatch <dotted...> [--workflow <id>] [--dry-run]      派发子任务(真实开 tab)
  wf verify <id> approve|reject [原因]                       期望核对
  wf merge [--wave N]                                        合并 wave 回主分支
  wf retry <id> [--fresh]                                     重派失败/中止/待修步骤(--fresh 重建 worktree)
  wf rebind-window [wfId]                                    重新绑定窗口(绑定窗口已关闭时,把当前焦点窗口设为绑定窗口)
  wf goal-check [--workflow <id>] [approve|reject <原因>]     目标把关(verifying→completed/gap wave)
  wf next [--note <说明>]                                      滚动到下一 wave
  wf done <id> '<JSON>' / wf fail <id> <原因>                回报(子任务侧)
  wf context [stepId]                                        读任务详情(无参=身份解析,子 pi 用)
  wf skip <id> <原因>                                         人工终态:非终态步骤 → skipped(依赖视为 done)
  wf resolve-conflict <stepId>                                确认解决冲突步骤(→done,继续 merge)
  wf resume [--workflow <id>]                                 暂停(预算超限)后恢复
  wf inject <target> <text...>                              向步骤 tab/终端注入指令+自动回车(target=完整id/点号id/terminal前缀;等价 /wf steer)
  wf poll [wf] [--until S] [--timeout T] [--interval I]     轮询直到达成/超时(0达成/1超时/2不可达/3用法)
  wf session [wf|--last] [-n N] [--json]                    读主控 pi 会话最近文本(按 cwd 编码定位)
  wf open-tab <stepId>                                      手动补开子任务 tab(绑 worktree/窗口,恢复 running)
  wf fix-tab <stepId> <tid|auto>                            修复步骤 tab 状态(排查用,只改 DB 状态)
  wf tabs [workflowId] [--json]                              子任务 tab 状态(存活判定)
  wf cleanup [workflowId] [--dry-run] [--no-fix]             关终态 tab + 清 .pi-glla + 合并前置修复
  wf clean                                                   清理残留 worktree
  wf doctor                                                  环境自检
  wf debug                                                   诊断信息`;

function createCliEnv(): CmdEnv {
	return {
		kind: "cli",
		cwd: process.cwd(),
		db: getDb(),
		show: (lines) => {
			for (const l of lines) console.log(l);
		},
		info: (line) => console.log(line),
		warn: (line) => console.warn(line),
		fail: (line) => {
			console.error(line);
			process.exitCode = 1;
		},
		notifyPi: () => {
			/* pi 专属提示,CLI 不输出 */
		},
		setExitCode: (code) => {
			process.exitCode = code;
		},
	};
}

async function main(): Promise<void> {
	const [cmd, ...args] = process.argv.slice(2);
	if (cmd === "help" || cmd === undefined) {
		console.log(HELP_TEXT);
		return;
	}
	const def = getCommand(cmd);
	if (!def || def.entry === "pi") {
		console.error(`未知命令: ${cmd}(wf help 查看用法)`);
		process.exitCode = 1;
		return;
	}
	const env = createCliEnv();
	try {
		await def.run(args, env);
	} catch (e) {
		if (e instanceof UsageError) {
			if (e.message) console.error(e.message); // 带具体提示的用法错误(如 poll 的 --until 非法)
			console.error(`用法: ${def.usage}`);
			process.exitCode = 3;
		} else {
			console.error("执行失败:", (e as Error).message);
			if (process.exitCode === undefined) process.exitCode = 1;
		}
	}
}

main().catch((e) => {
	console.error("执行失败:", (e as Error).message);
	if (process.exitCode === undefined) process.exitCode = 1;
});
