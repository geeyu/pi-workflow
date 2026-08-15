/**
 * sanitize.ts — 终端文本净化(对照 rpiv-todo tool/sanitize.ts,P0-1)
 *
 * 模型可控文本(step.title / task_md / agent 回报 summary·issues / fail reason 等)
 * 在进入终端渲染器(widget / notify / 对话流)与落库前,必须剥掉终端控制序列:
 * 完整的 CSI/OSC 转义整体丢弃(不留 `[31m` 之类可见残留),换行/制表符变成空格
 * (字段不能改变布局),双向控制符删除(字段不能重排相邻输出的阅读顺序)。
 *
 * 接线点:orchestrator(回报/失败/导入落库前)、ui/status.ts(面板渲染)、
 * command.ts / board.ts(命令输出)。纯函数,无副作用,可单测。
 */

/**
 * 净化一段可能含终端控制序列的模型文本。
 * - CSI(ESC [ … 字母,含 C1 单字节引入符)整段剥除;
 * - OSC(ESC ] … BEL/ST)连同负载剥除;未闭合的 OSC 吞掉剩余文本(与真实终端一致);
 * - 残余的双字符 ESC 序列剥除;Unicode 行/段分隔符与 \n\r\t 一律变空格;
 * - 其余 C0/C1 控制符删除;双向控制符(Bidi embedding/override/isolate、LRM/RLM)删除。
 */
export function sanitizeTerminalText(value: string): string {
	return (
		value
			// CSI 序列:ESC-[ 与 C1 单字节引入符 0x9b,参数位 + 中间位 + 终结位
			.replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, "")
			// OSC 序列及其负载;未闭合 OSC 吞掉余下文本(与真实终端行为一致)
			.replace(/(?:\u001b\]|\u009d)[^\u0007\u009c\u001b]*(?:\u0007|\u009c|\u001b\\)?/g, "")
			// 任何剩余的双字符 ESC 序列
			.replace(/\u001b./g, "")
			// Unicode 行/段分隔符与 \n 一样会改变布局,统一变空格
			.replace(/[\u2028\u2029]/g, " ")
			.replace(/[\u0000-\u001f\u007f-\u009f]/g, (character) =>
				character === "\n" || character === "\r" || character === "\t" ? " " : "",
			)
			// 双向嵌入/覆盖/隔离控制符与 LRM/RLM 标记
			.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
	);
}

/**
 * 对字符串数组逐元素净化(命令输出行 / expectations 列表等)。
 */
export function sanitizeTerminalLines(lines: string[]): string[] {
	return lines.map(sanitizeTerminalText);
}
