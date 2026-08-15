/**
 * orchestrator.ts — 编排核心流程(设计文档 §2)
 *
 * 纯逻辑、不依赖 pi 命令上下文,可独立测试:
 * - importPlan:计划校验 + 事务落库(workflow/wave/steps/deps + task_raw)
 * - reportDone / reportFail:子任务回报(供 /wf done / /wf fail)
 * - verifyStep:期望核对(供 /wf verify,gate 前后对照的执行后环节)
 */
import type { DatabaseSync } from "node:sqlite";
import {
	ATTEMPT_STATUS,
	EVT,
	STEP_STATUS,
	WORKFLOW_STATUS,
	type WorkflowRow,
	addEvent,
	addStepDeps,
	buildUpdate,
	createStep,
	createWave,
	createWorkflow,
	getLatestAttempt,
	getStep,
	getStepsByWorkflow,
	getWave,
	getWorkflow,
	listWaves,
	setStepMeta,
	updateStepReport,
	updateStepStatus,
	updateWorkflowStatus,
	workflowCost,
} from "./db.ts";
import { canTransition, legalTargets } from "./core/state.ts";
import { discoverAgents, type AgentConfig } from "./agents.ts";
import { validatePlan, type PlanInput } from "./validate.ts";
import { sanitizeTerminalText } from "./sanitize.ts";

export interface ImportResult {
	ok: boolean;
	errors?: string[];
	workflowId?: string;
	stepCount?: number;
	wave?: number;
}

/** 计划导入:校验 → 事务落库(workflow_created / step_created 事件) */
export function importPlan(
	db: DatabaseSync,
	plan: PlanInput,
	cwd: string,
	agents?: AgentConfig[],
): ImportResult {
	const agentList = agents ?? discoverAgents(cwd, "user").agents;
	const result = validatePlan(
		{ ...plan, repoPath: plan.repoPath ?? cwd },
		agentList,
	);
	if (!result.ok) {
		return { ok: false, errors: result.errors };
	}
	if (getWorkflow(db, result.workflowId)) {
		return { ok: false, errors: [`workflow 已存在: ${result.workflowId}`] };
	}

	db.exec("BEGIN");
	try {
		createWorkflow(db, {
			id: result.workflowId,
			title: sanitizeTerminalText(plan.title ?? ""),
			goal: sanitizeTerminalText(plan.goal ?? ""),
			repoPath: plan.repoPath ?? cwd,
			description: plan.description ? sanitizeTerminalText(plan.description) : undefined,
			concurrency: plan.concurrency,
			budgetCents: plan.budgetCents,
			maxSteps: plan.maxSteps,
		});
		const wave = createWave(
			db,
			result.workflowId,
			result.wave,
			result.waveNote ? sanitizeTerminalText(result.waveNote) : undefined,
		);
		for (const s of result.steps) {
			const step = createStep(db, {
				workflowId: result.workflowId,
				dotted: s.dotted,
				parentId: s.parentId,
				waveId: wave.id,
				title: sanitizeTerminalText(s.title),
				agent: s.agent,
				task: s.task ? sanitizeTerminalText(s.task) : s.task,
				expectations: s.expectations
					? s.expectations.map(sanitizeTerminalText)
					: undefined,
				gate: s.gate,
				maxRetries: s.maxRetries,
				timeoutMin: s.timeoutMin,
				sortOrder: s.sortOrder,
			});
			// 原始任务文本存入 KV,派发渲染时取用(重试可重新渲染)
			setStepMeta(db, step.id, "task_raw", s.task);
			if (s.deps.length > 0) addStepDeps(db, step.id, s.deps);
		}
		buildUpdate(
			db,
			"workflow",
			{ current_wave: result.wave, updated_at: Date.now() },
			{ id: result.workflowId },
		);
		db.exec("COMMIT");
	} catch (e) {
		db.exec("ROLLBACK");
		throw e;
	}

	return {
		ok: true,
		workflowId: result.workflowId,
		stepCount: result.steps.length,
		wave: result.wave,
	};
}

export interface AppendStepsResult {
	ok: boolean;
	errors?: string[];
	added?: number;
}

/**
 * 给已有 workflow 的指定 wave 追加步骤(P4 gap wave:/wf plan --workflow <id>)。
 * 校验同 importPlan;重复 dotted id 拒绝;不新建 workflow/wave。
 */
export function appendSteps(
	db: DatabaseSync,
	workflowId: string,
	waveSeq: number,
	plan: PlanInput,
	cwd: string,
	agents?: AgentConfig[],
): AppendStepsResult {
	const workflow = getWorkflow(db, workflowId);
	if (!workflow) {
		return { ok: false, errors: [`workflow 不存在: ${workflowId}`] };
	}
	const wave = getWave(db, workflowId, waveSeq);
	if (!wave) {
		return { ok: false, errors: [`wave ${waveSeq} 不存在,先 /wf next 创建`] };
	}
	const agentList = agents ?? discoverAgents(cwd, "user").agents;
	// 步骤 id 前缀用现有 workflow id
	const result = validatePlan(
		{ ...plan, name: workflowId, repoPath: workflow.repo_path },
		agentList,
	);
	if (!result.ok) {
		return { ok: false, errors: result.errors };
	}
	const existing = new Set(getStepsByWorkflow(db, workflowId).map((s) => s.id));
	const dup = result.steps.filter((s) => existing.has(s.fullId));
	if (dup.length > 0) {
		return {
			ok: false,
			errors: [`步骤已存在: ${dup.map((s) => s.dotted).join(", ")}`],
		};
	}

	db.exec("BEGIN");
	try {
		for (const s of result.steps) {
			const step = createStep(db, {
				workflowId,
				dotted: s.dotted,
				parentId: s.parentId,
				waveId: wave.id,
				title: sanitizeTerminalText(s.title),
				agent: s.agent,
				task: s.task ? sanitizeTerminalText(s.task) : s.task,
				expectations: s.expectations
					? s.expectations.map(sanitizeTerminalText)
					: undefined,
				gate: s.gate,
				maxRetries: s.maxRetries,
				timeoutMin: s.timeoutMin,
				sortOrder: s.sortOrder,
			});
			setStepMeta(db, step.id, "task_raw", s.task);
			if (s.deps.length > 0) addStepDeps(db, step.id, s.deps);
		}
		db.exec("COMMIT");
	} catch (e) {
		db.exec("ROLLBACK");
		throw e;
	}

	return { ok: true, added: result.steps.length };
}

export interface ReportResult {
	ok: boolean;
	error?: string;
	status?: string;
}

const REPORT_PAYLOAD_KEYS = ["filesChanged", "issues"] as const;

/** 校验 /wf done 的回报 JSON(输出契约 §6.1) */
export function validateReportPayload(payload: unknown): {
	ok: boolean;
	report?: Record<string, unknown>;
	error?: string;
} {
	if (
		typeof payload !== "object" ||
		payload === null ||
		Array.isArray(payload)
	) {
		return { ok: false, error: "回报必须是 JSON 对象" };
	}
	const p = payload as Record<string, unknown>;
	if (typeof p.summary !== "string" || p.summary.trim() === "") {
		return { ok: false, error: "report.summary 必须是非空字符串" };
	}
	for (const key of REPORT_PAYLOAD_KEYS) {
		if (
			p[key] !== undefined &&
			(!Array.isArray(p[key]) ||
				(p[key] as unknown[]).some((x) => typeof x !== "string"))
		) {
			return { ok: false, error: `report.${key} 必须是字符串数组` };
		}
	}
	if (
		p.tests !== undefined &&
		!["passed", "failed", "none"].includes(p.tests as string)
	) {
		return { ok: false, error: "report.tests 必须是 passed|failed|none" };
	}
	return { ok: true, report: p };
}

/** 迁移校验错误文案(非法迁移给出明确错误 + 合法目标列表,P0-4) */
function transitionError(stepId: string, from: string, to: string): string {
	return `状态迁移非法: ${stepId} ${from} → ${to};允许: ${legalTargets(from).join(", ")}`;
}

/**
 * 子任务回报(/wf done):写 attempt + step(report/summary/files/issues/tests)
 * gate=1 → waiting-verify,否则 reported。
 * 状态机校验:任意非终态非冲突状态可回报(手动纠正/失败后确认/驳回后重报/
 * monitor 误判后存活回报);终态(done/skipped)与 conflict 给明确错误与合法目标。
 */
export function reportDone(
	db: DatabaseSync,
	stepId: string,
	payload: unknown,
): ReportResult {
	const checked = validateReportPayload(payload);
	if (!checked.ok) {
		return { ok: false, error: checked.error };
	}
	const step = getStep(db, stepId);
	if (!step) {
		return { ok: false, error: `步骤不存在: ${stepId}` };
	}
	const nextStatus =
		step.gate === 1 ? STEP_STATUS.waitingVerify : STEP_STATUS.reported;
	if (!canTransition(step.status, nextStatus)) {
		return {
			ok: false,
			error: transitionError(step.id, step.status, nextStatus),
		};
	}
	const report = checked.report!;
	// 模型可控文本落库前净化(P0-1):summary/issues/filesChanged 过 sanitize,
	// 防转义序列在后续 widget/notify/对话流渲染时污染终端布局。
	const clean: Record<string, unknown> = {
		...report,
		summary: sanitizeTerminalText(String(report.summary)),
	};
	for (const key of REPORT_PAYLOAD_KEYS) {
		if (Array.isArray(clean[key])) {
			clean[key] = (clean[key] as string[]).map(sanitizeTerminalText);
		}
	}
	const attempt = getLatestAttempt(db, stepId);
	if (attempt && attempt.status === ATTEMPT_STATUS.running) {
		buildUpdate(
			db,
			"workflow_attempts",
			{
				status: "reported",
				report: JSON.stringify(clean),
				finished_at: Date.now(),
			},
			{ id: attempt.id },
		);
	}
	updateStepReport(db, stepId, clean);
	// 可选 usage 自报(设计 P3 预算护栏数据源):{input, output, costCents, turns}
	applyUsage(db, stepId, attempt, report.usage);
	updateStepStatus(db, stepId, nextStatus, undefined, { strict: true });
	addEvent(db, {
		workflowId: step.workflow_id,
		stepId: step.id,
		attemptId: attempt?.id,
		type: EVT.stepReported,
		payload: { report: clean, gate: step.gate === 1 },
	});
	return { ok: true, status: nextStatus };
}

interface UsageReport {
	input?: number;
	output?: number;
	costCents?: number;
	turns?: number;
}

/** 把子 agent 自报的 usage 写入 attempt 明细 + step 汇总(幂等:只处理当前 attempt) */
function applyUsage(
	db: DatabaseSync,
	stepId: string,
	attempt: ReturnType<typeof getLatestAttempt>,
	usageRaw: unknown,
): void {
	if (typeof usageRaw !== "object" || usageRaw === null) return;
	const u = usageRaw as UsageReport;
	const usage = {
		input: Number(u.input) || 0,
		output: Number(u.output) || 0,
		costCents: Number(u.costCents) || 0,
		turns: Number(u.turns) || 0,
	};
	if (usage.input + usage.output + usage.costCents + usage.turns === 0) return;
	if (attempt) {
		buildUpdate(
			db,
			"workflow_attempts",
			{
				usage_input: usage.input,
				usage_output: usage.output,
				usage_cost_cents: usage.costCents,
				usage_turns: usage.turns,
			},
			{ id: attempt.id },
		);
	}
	const stepRow = getStep(db, stepId);
	if (stepRow) {
		buildUpdate(
			db,
			"workflow_steps",
			{
				usage_input: (stepRow.usage_input ?? 0) + usage.input,
				usage_output: (stepRow.usage_output ?? 0) + usage.output,
				usage_cost_cents: (stepRow.usage_cost_cents ?? 0) + usage.costCents,
				usage_turns: (stepRow.usage_turns ?? 0) + usage.turns,
			},
			{ id: stepId },
		);
	}
}

export interface BudgetCheck {
	ok: boolean;
	reason?: string;
}

/**
 * 预算护栏(设计 §10):累计成本(budget_cents 美分)超限 → 拒绝继续派发。
 * 未设预算或暂无 usage 数据时放行。
 */
export function checkBudget(
	db: DatabaseSync,
	workflow: WorkflowRow,
): BudgetCheck {
	if (!workflow.budget_cents) return { ok: true };
	const cost = workflowCost(db, workflow.id);
	const spent = cost?.cost_cents ?? 0;
	if (spent >= workflow.budget_cents) {
		return {
			ok: false,
			reason: `预算已用尽(${(spent / 100).toFixed(2)} / ${(workflow.budget_cents / 100).toFixed(2)} 元);需调整预算或人工处理`,
		};
	}
	return { ok: true };
}

/** 子任务主动报失败(/wf fail):非终态非冲突可报(同 reportDone 口径),reason 落库前净化(P0-1) */
export function reportFail(
	db: DatabaseSync,
	stepId: string,
	reason: string,
): ReportResult {
	const step = getStep(db, stepId);
	if (!step) {
		return { ok: false, error: `步骤不存在: ${stepId}` };
	}
	// 校验(P0-4):非终态非冲突可报(同 reportDone 口径);reason 落库前净化(P0-1)
	if (!canTransition(step.status, STEP_STATUS.failed)) {
		return {
			ok: false,
			error: transitionError(step.id, step.status, STEP_STATUS.failed),
		};
	}
	reason = sanitizeTerminalText(reason);
	const attempt = getLatestAttempt(db, stepId);
	if (attempt && attempt.status === ATTEMPT_STATUS.running) {
		buildUpdate(
			db,
			"workflow_attempts",
			{ status: "failed", error: reason, finished_at: Date.now() },
			{ id: attempt.id },
		);
	}
	updateStepStatus(db, stepId, STEP_STATUS.failed, { error: reason }, { strict: true });
	addEvent(db, {
		workflowId: step.workflow_id,
		stepId: step.id,
		attemptId: attempt?.id,
		type: EVT.stepFailed,
		payload: { reason },
	});
	return { ok: true };
}

/**
 * 期望核对(/wf verify,gate 执行后更新):approve → done;reject → needs-fix。
 * 状态机校验:仅 reported / waiting-verify 可核对(迁移表约束,非法迁移
 * 给出明确错误与合法目标列表)。
 */
export function verifyStep(
	db: DatabaseSync,
	stepId: string,
	action: "approve" | "reject",
	reason?: string,
): ReportResult {
	const step = getStep(db, stepId);
	if (!step) {
		return { ok: false, error: `步骤不存在: ${stepId}` };
	}
	const target = action === "reject" ? STEP_STATUS.needsFix : STEP_STATUS.done;
	// 核对是「执行后」动作:仅 reported/waiting-verify 可核对(同态重复核对也拒绝)
	if (
		step.status !== STEP_STATUS.reported &&
		step.status !== STEP_STATUS.waitingVerify
	) {
		return {
			ok: false,
			error: `状态迁移非法: ${step.id} ${step.status} → ${target};允许: ${STEP_STATUS.reported}, ${STEP_STATUS.waitingVerify}`,
		};
	}
	if (action === "reject") {
		const why = reason?.trim() || "(未说明)";
		updateStepStatus(db, stepId, STEP_STATUS.needsFix, { error: why }, { strict: true });
		addEvent(db, {
			workflowId: step.workflow_id,
			stepId: step.id,
			type: EVT.stepNeedsFix,
			payload: { reason: why },
		});
		return { ok: true, status: STEP_STATUS.needsFix };
	}
	updateStepStatus(db, stepId, STEP_STATUS.done, undefined, { strict: true });
	addEvent(db, {
		workflowId: step.workflow_id,
		stepId: step.id,
		type: EVT.stepVerified,
	});
	return { ok: true, status: STEP_STATUS.done };
}

export interface GoalCheckResult {
	ok: boolean;
	error?: string;
	status?: string;
}

/** 进入目标核对状态(设计 §4.4:workflow → verifying) */
export function goalCheckEnter(
	db: DatabaseSync,
	workflowId: string,
): GoalCheckResult {
	const wf = getWorkflow(db, workflowId);
	if (!wf) {
		return { ok: false, error: `workflow 不存在: ${workflowId}` };
	}
	updateWorkflowStatus(db, workflowId, WORKFLOW_STATUS.verifying);
	addEvent(db, { workflowId, type: EVT.workflowGoalCheckStarted });
	return { ok: true, status: WORKFLOW_STATUS.verifying };
}

/** 目标核对通过 → completed */
export function goalCheckApprove(
	db: DatabaseSync,
	workflowId: string,
	reason?: string,
): GoalCheckResult {
	const wf = getWorkflow(db, workflowId);
	if (!wf) {
		return { ok: false, error: `workflow 不存在: ${workflowId}` };
	}
	buildUpdate(
		db,
		"workflow",
		{
			goal_check: JSON.stringify({
				result: "passed",
				reason: reason ?? "",
				checkedAt: Date.now(),
			}),
			updated_at: Date.now(),
		},
		{ id: workflowId },
	);
	updateWorkflowStatus(db, workflowId, WORKFLOW_STATUS.completed);
	addEvent(db, {
		workflowId,
		type: EVT.workflowGoalCheckPassed,
		payload: { reason: reason ?? "" },
	});
	return { ok: true, status: WORKFLOW_STATUS.completed };
}

/** 目标未达成 → 回 running,拆 gap wave 补齐 */
export function goalCheckReject(
	db: DatabaseSync,
	workflowId: string,
	reason?: string,
): GoalCheckResult {
	const wf = getWorkflow(db, workflowId);
	if (!wf) {
		return { ok: false, error: `workflow 不存在: ${workflowId}` };
	}
	const why = reason?.trim() || "(未说明)";
	buildUpdate(
		db,
		"workflow",
		{
			goal_check: JSON.stringify({
				result: "failed",
				reason: why,
				checkedAt: Date.now(),
			}),
			updated_at: Date.now(),
		},
		{ id: workflowId },
	);
	updateWorkflowStatus(db, workflowId, WORKFLOW_STATUS.running);
	addEvent(db, {
		workflowId,
		type: EVT.workflowGoalCheckFailed,
		payload: { reason: why },
	});
	return { ok: true, status: WORKFLOW_STATUS.running };
}

export interface NextWaveResult {
	ok: boolean;
	seq?: number;
	error?: string;
}

/** wave 滚动:创建 wave N+1 并更新 current_wave(gap wave 用) */
export function nextWave(
	db: DatabaseSync,
	workflowId: string,
	note?: string,
): NextWaveResult {
	const wf = getWorkflow(db, workflowId);
	if (!wf) {
		return { ok: false, error: `workflow 不存在: ${workflowId}` };
	}
	const waves = listWaves(db, workflowId);
	const nextSeq = (waves.length > 0 ? waves[waves.length - 1].seq : 0) + 1;
	const wave = createWave(db, workflowId, nextSeq, note);
	buildUpdate(
		db,
		"workflow",
		{ current_wave: nextSeq, updated_at: Date.now() },
		{ id: workflowId },
	);
	addEvent(db, {
		workflowId,
		waveId: wave.id,
		type: EVT.waveStarted,
		payload: { wave: nextSeq, note: note ?? null },
	});
	return { ok: true, seq: nextSeq };
}
