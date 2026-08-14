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
	addEvent,
	addStepDeps,
	buildUpdate,
	createStep,
	createWave,
	createWorkflow,
	getLatestAttempt,
	getStep,
	getWorkflow,
	setStepMeta,
	updateStepReport,
	updateStepStatus,
} from "./db.ts";
import { discoverAgents, type AgentConfig } from "./agents.ts";
import { validatePlan, type PlanInput } from "./validate.ts";

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
			title: plan.title,
			goal: plan.goal,
			repoPath: plan.repoPath ?? cwd,
			description: plan.description,
			concurrency: plan.concurrency,
			budgetCents: plan.budgetCents,
			maxSteps: plan.maxSteps,
		});
		const wave = createWave(
			db,
			result.workflowId,
			result.wave,
			result.waveNote ?? undefined,
		);
		for (const s of result.steps) {
			const step = createStep(db, {
				workflowId: result.workflowId,
				dotted: s.dotted,
				parentId: s.parentId,
				waveId: wave.id,
				title: s.title,
				agent: s.agent,
				task: s.task,
				expectations: s.expectations ?? undefined,
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

/**
 * 子任务回报(/wf done):写 attempt + step(report/summary/files/issues/tests)
 * gate=1 → waiting-verify,否则 reported。
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
	const report = checked.report!;
	const attempt = getLatestAttempt(db, stepId);
	if (attempt && attempt.status === ATTEMPT_STATUS.running) {
		buildUpdate(
			db,
			"workflow_attempts",
			{
				status: "reported",
				report: JSON.stringify(report),
				finished_at: Date.now(),
			},
			{ id: attempt.id },
		);
	}
	updateStepReport(db, stepId, report);
	const nextStatus =
		step.gate === 1 ? STEP_STATUS.waitingVerify : STEP_STATUS.reported;
	updateStepStatus(db, stepId, nextStatus);
	addEvent(db, {
		workflowId: step.workflow_id,
		stepId: step.id,
		attemptId: attempt?.id,
		type: EVT.stepReported,
		payload: { report, gate: step.gate === 1 },
	});
	return { ok: true, status: nextStatus };
}

/** 子任务主动报失败(/wf fail) */
export function reportFail(
	db: DatabaseSync,
	stepId: string,
	reason: string,
): ReportResult {
	const step = getStep(db, stepId);
	if (!step) {
		return { ok: false, error: `步骤不存在: ${stepId}` };
	}
	const attempt = getLatestAttempt(db, stepId);
	if (attempt && attempt.status === ATTEMPT_STATUS.running) {
		buildUpdate(
			db,
			"workflow_attempts",
			{ status: "failed", error: reason, finished_at: Date.now() },
			{ id: attempt.id },
		);
	}
	updateStepStatus(db, stepId, STEP_STATUS.failed, { error: reason });
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
 * 仅 reported / waiting-verify 可核对。
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
	if (
		step.status !== STEP_STATUS.reported &&
		step.status !== STEP_STATUS.waitingVerify
	) {
		return {
			ok: false,
			error: `步骤 ${step.id} 状态为 ${step.status},仅 reported/waiting-verify 可核对`,
		};
	}
	if (action === "reject") {
		const why = reason?.trim() || "(未说明)";
		updateStepStatus(db, stepId, STEP_STATUS.needsFix, { error: why });
		addEvent(db, {
			workflowId: step.workflow_id,
			stepId: step.id,
			type: EVT.stepNeedsFix,
			payload: { reason: why },
		});
		return { ok: true, status: STEP_STATUS.needsFix };
	}
	updateStepStatus(db, stepId, STEP_STATUS.done);
	addEvent(db, {
		workflowId: step.workflow_id,
		stepId: step.id,
		type: EVT.stepVerified,
	});
	return { ok: true, status: STEP_STATUS.done };
}
