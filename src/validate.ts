/**
 * validate.ts — 计划 JSON 校验与层级 id 工具
 *
 * 校验规则(设计文档 §3.3 / §5):
 * - workflow id:kebab-case
 * - step id:层级点号(`1`、`1.1`、`1.2.3`),唯一
 * - agent 必须存在于发现结果
 * - deps 引用存在、无自引用、无环(拓扑检查)
 * - steps 数量 ≤ max_steps
 */
import type { AgentConfig } from "./agents.ts";

export const DOTTED_RE = /^[0-9]+(\.[0-9]+)*$/;
export const WORKFLOW_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** 点号路径 → 层级数值编码(每段基数 1000,深度 ≤ 4):1.2.3 → 1002003 */
export function packDotted(dotted: string): number {
	const segs = dotted.split(".").map(Number);
	if (segs.length > 4 || segs.some((s) => s >= 1000)) {
		throw new Error(`点号层级过深或段值过大: ${dotted}(≤4 层,每层 <1000)`);
	}
	// 固定 4 段 × 3 位,未满段补 0:1 → 1000000,1.1 → 1001000,2 → 2000000
	// 保证前缀序(DFS):父 < 所有子孙 < 下一个兄弟,层级树按 sort_order 即树序
	let n = 0;
	for (let i = 0; i < 4; i++) {
		n = n * 1000 + (segs[i] ?? 0);
	}
	return n;
}

/** 由点号 id 推导父 id:`1.2` → `1`;顶层返回 null */
export function deriveParentDotted(dotted: string): string | null {
	const idx = dotted.lastIndexOf(".");
	return idx === -1 ? null : dotted.slice(0, idx);
}

export interface PlanStepInput {
	id: string; // 点号,如 1 / 1.1
	title: string;
	agent: string;
	task?: string;
	deps?: string[];
	gate?: boolean;
	expectations?: string[];
	maxRetries?: number;
	timeoutMin?: number;
}

export interface PlanInput {
	name: string; // workflow id,kebab-case
	title: string;
	goal: string;
	repoPath?: string;
	description?: string;
	concurrency?: number;
	budgetCents?: number;
	maxSteps?: number;
	wave?: number;
	waveNote?: string;
	steps: PlanStepInput[];
}

export interface NormalizedStep {
	fullId: string; // <workflowId>-<dotted>
	dotted: string;
	parentId: string | null;
	title: string;
	agent: string;
	task: string;
	deps: string[]; // 完整 id
	gate: boolean;
	expectations: string[] | null;
	maxRetries: number;
	timeoutMin: number;
	sortOrder: number;
}

export interface ValidationResult {
	ok: boolean;
	errors: string[];
	workflowId: string;
	wave: number;
	waveNote: string | null;
	steps: NormalizedStep[];
}

/**
 * 校验计划。失败返回 ok=false + errors;成功返回可直接落库的标准化步骤。
 */
export function validatePlan(
	input: PlanInput,
	agents: AgentConfig[],
	opts?: { maxSteps?: number },
): ValidationResult {
	const errors: string[] = [];
	const workflowId = input.name.trim();
	const maxSteps = opts?.maxSteps ?? 50;

	if (!WORKFLOW_ID_RE.test(workflowId)) {
		errors.push(
			`workflow id 必须为 kebab-case(如 add-redis-cache),收到: ${JSON.stringify(workflowId)}`,
		);
	}
	if (!input.title?.trim()) errors.push("title 不能为空");
	if (!input.goal?.trim())
		errors.push("goal 不能为空(需求目标,结束前必须核对达成)");
	if (!Array.isArray(input.steps) || input.steps.length === 0) {
		errors.push("steps 不能为空");
	}

	const agentNames = new Set(agents.map((a) => a.name));
	const dottedSet = new Set<string>();
	const byDotted = new Map<string, PlanStepInput>();
	const rawDeps = new Map<string, string[]>(); // dotted → dotted deps

	for (const [i, s] of (input.steps ?? []).entries()) {
		const tag = `steps[${i}]`;
		const dotted = s.id.trim();
		if (!DOTTED_RE.test(dotted)) {
			errors.push(
				`${tag}.id 必须为点号层级(1 / 1.1 / 1.2.3),收到: ${JSON.stringify(dotted)}`,
			);
			continue;
		}
		if (dottedSet.has(dotted)) {
			errors.push(`${tag}.id 重复: ${dotted}`);
			continue;
		}
		dottedSet.add(dotted);
		byDotted.set(dotted, s);
		if (!s.title?.trim()) errors.push(`${tag}(id=${dotted}) title 不能为空`);
		if (!s.agent?.trim()) errors.push(`${tag}(id=${dotted}) agent 不能为空`);
		else if (!agentNames.has(s.agent.trim()))
			errors.push(
				`${tag}(id=${dotted}) agent 不存在: ${s.agent}(可用: ${[...agentNames].join(", ") || "无"})`,
			);
		if (s.expectations && !Array.isArray(s.expectations))
			errors.push(`${tag}(id=${dotted}) expectations 必须是字符串数组`);
		if (
			s.maxRetries !== undefined &&
			(!Number.isInteger(s.maxRetries) || s.maxRetries < 0 || s.maxRetries > 10)
		)
			errors.push(`${tag}(id=${dotted}) maxRetries 非法: ${s.maxRetries}`);
		if (
			s.timeoutMin !== undefined &&
			(!Number.isInteger(s.timeoutMin) || s.timeoutMin < 1)
		)
			errors.push(`${tag}(id=${dotted}) timeoutMin 非法: ${s.timeoutMin}`);
		rawDeps.set(
			dotted,
			(s.deps ?? []).map((d) => d.trim()),
		);
	}

	if (errors.length > 0) {
		return {
			ok: false,
			errors,
			workflowId,
			wave: 1,
			waveNote: null,
			steps: [],
		};
	}

	// deps:存在性 + 自引用 + 无环(Kahn)
	for (const [dotted, deps] of rawDeps) {
		for (const dep of deps) {
			if (dep === dotted) errors.push(`step ${dotted} 不能依赖自己`);
			else if (!dottedSet.has(dep))
				errors.push(`step ${dotted} 依赖不存在的步骤: ${dep}`);
		}
	}
	if (errors.length === 0) {
		const indeg = new Map<string, number>();
		for (const d of dottedSet) indeg.set(d, 0);
		const adj = new Map<string, string[]>();
		for (const [dotted, deps] of rawDeps) {
			for (const dep of deps) {
				indeg.set(dotted, (indeg.get(dotted) ?? 0) + 1);
				if (!adj.has(dep)) adj.set(dep, []);
				adj.get(dep)!.push(dotted);
			}
		}
		const queue = [...dottedSet].filter((d) => (indeg.get(d) ?? 0) === 0);
		let visited = 0;
		while (queue.length > 0) {
			const cur = queue.shift()!;
			visited++;
			for (const next of adj.get(cur) ?? []) {
				const n = (indeg.get(next) ?? 0) - 1;
				indeg.set(next, n);
				if (n === 0) queue.push(next);
			}
		}
		if (visited !== dottedSet.size) {
			const cyclic = [...dottedSet].filter((d) => (indeg.get(d) ?? 0) > 0);
			errors.push(`依赖存在环: ${cyclic.join(", ")}`);
		}
	}

	if (input.steps.length > maxSteps) {
		errors.push(`steps 数量 ${input.steps.length} 超过上限 ${maxSteps}`);
	}

	if (errors.length > 0) {
		return {
			ok: false,
			errors,
			workflowId,
			wave: 1,
			waveNote: null,
			steps: [],
		};
	}

	// 标准化:推导 parent、pack sort_order、完整 id
	const steps: NormalizedStep[] = [];
	for (const s of input.steps) {
		const dotted = s.id.trim();
		const parentDotted = deriveParentDotted(dotted);
		let sortOrder: number;
		try {
			sortOrder = packDotted(dotted);
		} catch (e) {
			errors.push(`step ${dotted} 层级非法: ${(e as Error).message}`);
			continue;
		}
		steps.push({
			fullId: `${workflowId}-${dotted}`,
			dotted,
			parentId: parentDotted ? `${workflowId}-${parentDotted}` : null,
			title: s.title.trim(),
			agent: s.agent.trim(),
			task: s.task ?? "",
			deps: (s.deps ?? []).map((d) => `${workflowId}-${d.trim()}`),
			gate: Boolean(s.gate),
			expectations:
				Array.isArray(s.expectations) && s.expectations.length > 0
					? s.expectations
					: null,
			maxRetries: s.maxRetries ?? 1,
			timeoutMin: s.timeoutMin ?? 60,
			sortOrder,
		});
	}

	if (errors.length > 0) {
		return {
			ok: false,
			errors,
			workflowId,
			wave: 1,
			waveNote: null,
			steps: [],
		};
	}

	return {
		ok: true,
		errors: [],
		workflowId,
		wave: input.wave ?? 1,
		waveNote: input.waveNote ?? null,
		steps,
	};
}
