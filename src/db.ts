/**
 * db.ts — workflow 插件数据层(node:sqlite 封装)
 *
 * 唯一事实源:~/.pi/agent/workflows/workflow.db
 * - WAL + busy_timeout + foreign_keys,编排者/子 pi/外部工具并发安全
 * - PRAGMA user_version 顺序迁移,只追加
 * - 所有写操作双写 workflow_events(审计流,只增不改)
 *
 * 测试可用环境变量 WF_DB_PATH 覆盖数据库位置。
 */
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const DB_DIR = path.join(os.homedir(), ".pi", "agent", "workflows");
export const DB_PATH =
	process.env.WF_DB_PATH ?? path.join(DB_DIR, "workflow.db");

// ────────────────────────────────────────────────────────────
// 事件类型(TEXT 约定值,新增零迁移)
// ────────────────────────────────────────────────────────────
export const EVT = {
	// workflow
	workflowCreated: "workflow_created",
	workflowStarted: "workflow_started",
	workflowPaused: "workflow_paused",
	workflowResumed: "workflow_resumed",
	workflowCompleted: "workflow_completed",
	workflowFailed: "workflow_failed",
	workflowAborted: "workflow_aborted",
	workflowGoalCheckStarted: "workflow_goal_check_started",
	workflowGoalCheckPassed: "workflow_goal_check_passed",
	workflowGoalCheckFailed: "workflow_goal_check_failed",
	// wave
	waveStarted: "wave_started",
	waveCompleted: "wave_completed",
	waveMerged: "wave_merged",
	// step
	stepCreated: "step_created",
	stepDecomposed: "step_decomposed",
	stepDispatched: "step_dispatched",
	stepTabOpened: "step_tab_opened",
	stepTabClosed: "step_tab_closed",
	stepReported: "step_reported",
	stepVerified: "step_verified",
	stepNeedsFix: "step_needs_fix",
	stepFailed: "step_failed",
	stepRetrying: "step_retrying",
	stepAborted: "step_aborted",
	stepSkipped: "step_skipped",
	stepConflict: "step_conflict",
	stepResolved: "step_resolved",
	// worktree
	worktreeCreated: "worktree_created",
	worktreeMerged: "worktree_merged",
	worktreeCleaned: "worktree_cleaned",
	mergeConflict: "merge_conflict",
	mergeResolved: "merge_resolved",
} as const;
export type EventType = (typeof EVT)[keyof typeof EVT];

// ────────────────────────────────────────────────────────────
// 步骤/工作流状态(TEXT 约定值)
// ────────────────────────────────────────────────────────────
export const STEP_STATUS = {
	pending: "pending",
	ready: "ready",
	dispatched: "dispatched",
	running: "running",
	reported: "reported",
	waitingVerify: "waiting-verify",
	done: "done",
	failed: "failed",
	aborted: "aborted",
	conflict: "conflict",
	skipped: "skipped",
	needsFix: "needs-fix",
} as const;
export type StepStatus = (typeof STEP_STATUS)[keyof typeof STEP_STATUS];

export const WORKFLOW_STATUS = {
	idle: "idle",
	running: "running",
	paused: "paused",
	verifying: "verifying",
	completed: "completed",
	failed: "failed",
	aborted: "aborted",
} as const;
export type WorkflowStatus =
	(typeof WORKFLOW_STATUS)[keyof typeof WORKFLOW_STATUS];

export const ATTEMPT_STATUS = {
	running: "running",
	reported: "reported",
	done: "done",
	failed: "failed",
	aborted: "aborted",
} as const;
export type AttemptStatus =
	(typeof ATTEMPT_STATUS)[keyof typeof ATTEMPT_STATUS];

export const WAVE_STATUS = {
	planned: "planned",
	dispatching: "dispatching",
	running: "running",
	merging: "merging",
	merged: "merged",
	verified: "verified",
} as const;

// ────────────────────────────────────────────────────────────
// 行类型
// ────────────────────────────────────────────────────────────
export interface WorkflowRow {
	id: string;
	title: string;
	goal: string;
	context: string | null;
	description: string;
	repo_path: string;
	base_sha: string | null;
	status: WorkflowStatus;
	current_wave: number;
	concurrency: number;
	budget_cents: number | null;
	max_steps: number;
	goal_check: string | null;
	created_at: number;
	updated_at: number;
	started_at: number | null;
	completed_at: number | null;
}

export interface WaveRow {
	id: number;
	workflow_id: string;
	seq: number;
	status: string;
	note: string | null;
	merge_result: string | null;
	created_at: number;
	started_at: number | null;
	merged_at: number | null;
}

export interface StepRow {
	id: string; // <workflowId>-<dotted>
	workflow_id: string;
	parent_id: string | null;
	wave_id: number | null;
	title: string;
	agent: string;
	status: StepStatus;
	gate: number;
	expectations: string | null; // JSON 数组
	task_md: string;
	report: string | null; // JSON
	summary: string | null;
	files_changed: string | null; // JSON 数组
	issues: string | null; // JSON 数组
	tests: string | null;
	error: string | null;
	worktree: string | null;
	tab_id: string | null;
	retries_done: number;
	max_retries: number;
	timeout_min: number;
	usage_input: number | null;
	usage_output: number | null;
	usage_cost_cents: number | null;
	usage_turns: number | null;
	sort_order: number;
	created_at: number;
	updated_at: number;
	started_at: number | null;
	finished_at: number | null;
}

export interface AttemptRow {
	id: number;
	step_id: string;
	attempt_no: number;
	status: AttemptStatus;
	task_md: string | null;
	pointer: string | null;
	report: string | null;
	stderr: string | null;
	model: string | null;
	tab_id: string | null;
	usage_input: number | null;
	usage_output: number | null;
	usage_cost_cents: number | null;
	usage_turns: number | null;
	error: string | null;
	started_at: number | null;
	finished_at: number | null;
}

export interface EventRow {
	id: number;
	workflow_id: string;
	wave_id: number | null;
	step_id: string | null;
	attempt_id: number | null;
	type: string;
	payload: string | null;
	created_at: number;
}

export interface EventInput {
	workflowId: string;
	waveId?: number | null;
	stepId?: string | null;
	attemptId?: number | null;
	type: EventType;
	payload?: unknown;
}

export interface NewWorkflowInput {
	id: string;
	title: string;
	goal: string;
	repoPath: string;
	description?: string;
	concurrency?: number;
	budgetCents?: number | null;
	maxSteps?: number;
}

export interface NewStepInput {
	workflowId: string;
	dotted: string; // 1.1 / 2.3.1
	parentId?: string | null;
	waveId?: number | null;
	title: string;
	agent: string;
	task: string; // 原始任务文本(占位 task_md,派发时渲染覆盖)
	expectations?: string[];
	gate?: boolean;
	maxRetries?: number;
	timeoutMin?: number;
	sortOrder: number;
}

// ────────────────────────────────────────────────────────────
// 迁移(v1:初始 schema — 10 表 + 2 视图)
// ────────────────────────────────────────────────────────────
const MIGRATIONS: string[] = [
	`
CREATE TABLE IF NOT EXISTS workflow (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  goal          TEXT NOT NULL,
  context       TEXT,
  description   TEXT NOT NULL DEFAULT '',
  repo_path     TEXT NOT NULL,
  base_sha      TEXT,
  status        TEXT NOT NULL DEFAULT 'idle',
  current_wave  INTEGER NOT NULL DEFAULT 0,
  concurrency   INTEGER NOT NULL DEFAULT 4,
  budget_cents  INTEGER,
  max_steps     INTEGER NOT NULL DEFAULT 50,
  goal_check    TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  started_at    INTEGER,
  completed_at  INTEGER
);

CREATE TABLE IF NOT EXISTS workflow_goal_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id  TEXT NOT NULL REFERENCES workflow(id) ON DELETE CASCADE,
  text         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  evidence     TEXT,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  checked_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_workflow_goal_items_workflow_status ON workflow_goal_items(workflow_id, status);

CREATE TABLE IF NOT EXISTS workflow_waves (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id  TEXT NOT NULL REFERENCES workflow(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'planned',
  note         TEXT,
  merge_result TEXT,
  created_at   INTEGER NOT NULL,
  started_at   INTEGER,
  merged_at    INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_waves_workflow_seq ON workflow_waves(workflow_id, seq);

CREATE TABLE IF NOT EXISTS workflow_steps (
  id             TEXT PRIMARY KEY,
  workflow_id    TEXT NOT NULL REFERENCES workflow(id) ON DELETE CASCADE,
  parent_id      TEXT REFERENCES workflow_steps(id),
  wave_id        INTEGER REFERENCES workflow_waves(id),
  title          TEXT NOT NULL,
  agent          TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending',
  gate           INTEGER NOT NULL DEFAULT 0,
  expectations   TEXT,
  task_md        TEXT NOT NULL,
  report         TEXT,
  summary        TEXT,
  files_changed  TEXT,
  issues         TEXT,
  tests          TEXT,
  error          TEXT,
  worktree       TEXT,
  tab_id         TEXT,
  retries_done   INTEGER NOT NULL DEFAULT 0,
  max_retries    INTEGER NOT NULL DEFAULT 1,
  timeout_min    INTEGER NOT NULL DEFAULT 60,
  usage_input    INTEGER,
  usage_output   INTEGER,
  usage_cost_cents INTEGER,
  usage_turns    INTEGER,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  started_at     INTEGER,
  finished_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_workflow_steps_workflow_status ON workflow_steps(workflow_id, status);
CREATE INDEX IF NOT EXISTS idx_workflow_steps_wave_id          ON workflow_steps(wave_id);
CREATE INDEX IF NOT EXISTS idx_workflow_steps_parent_id        ON workflow_steps(parent_id);
CREATE INDEX IF NOT EXISTS idx_workflow_steps_workflow_sort    ON workflow_steps(workflow_id, sort_order);

CREATE TABLE IF NOT EXISTS workflow_step_deps (
  step_id    TEXT NOT NULL REFERENCES workflow_steps(id) ON DELETE CASCADE,
  dep_id     TEXT NOT NULL REFERENCES workflow_steps(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (step_id, dep_id)
);

CREATE TABLE IF NOT EXISTS workflow_attempts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  step_id     TEXT NOT NULL REFERENCES workflow_steps(id) ON DELETE CASCADE,
  attempt_no  INTEGER NOT NULL,
  status      TEXT NOT NULL,
  task_md     TEXT,
  pointer     TEXT,
  report      TEXT,
  stderr      TEXT,
  model       TEXT,
  tab_id      TEXT,
  usage_input INTEGER,
  usage_output INTEGER,
  usage_cost_cents INTEGER,
  usage_turns INTEGER,
  error       TEXT,
  started_at  INTEGER,
  finished_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_attempts_step_attempt ON workflow_attempts(step_id, attempt_no);

CREATE TABLE IF NOT EXISTS workflow_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id TEXT NOT NULL REFERENCES workflow(id) ON DELETE CASCADE,
  wave_id     INTEGER REFERENCES workflow_waves(id),
  step_id     TEXT REFERENCES workflow_steps(id),
  attempt_id  INTEGER REFERENCES workflow_attempts(id),
  type        TEXT NOT NULL,
  payload     TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workflow_events_workflow_created ON workflow_events(workflow_id, created_at);
CREATE INDEX IF NOT EXISTS idx_workflow_events_step_created     ON workflow_events(step_id, created_at);
CREATE INDEX IF NOT EXISTS idx_workflow_events_type_created     ON workflow_events(type, created_at);
CREATE INDEX IF NOT EXISTS idx_workflow_events_wave_created     ON workflow_events(wave_id);

CREATE TABLE IF NOT EXISTS workflow_agents (
  name          TEXT PRIMARY KEY,
  description   TEXT,
  model         TEXT,
  tools         TEXT,
  system_prompt TEXT,
  prompt_hash   TEXT,
  source        TEXT NOT NULL DEFAULT 'user',
  file_path     TEXT,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_metadata (
  workflow_id TEXT NOT NULL REFERENCES workflow(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  value       TEXT,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (workflow_id, key)
);

CREATE TABLE IF NOT EXISTS workflow_step_metadata (
  step_id     TEXT NOT NULL REFERENCES workflow_steps(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  value       TEXT,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (step_id, key)
);

CREATE VIEW IF NOT EXISTS v_workflow_kanban AS
SELECT s.workflow_id, s.id, s.parent_id, s.wave_id, s.title, s.status,
       s.agent, s.gate, s.sort_order, s.started_at, s.finished_at,
       w.title AS workflow_title, w.status AS workflow_status
FROM workflow_steps s JOIN workflow w ON w.id = s.workflow_id;

CREATE VIEW IF NOT EXISTS v_workflow_cost AS
SELECT a.step_id, s.workflow_id,
       SUM(a.usage_cost_cents) AS cost_cents,
       SUM(a.usage_turns)      AS turns,
       COUNT(*)                AS attempts
FROM workflow_attempts a JOIN workflow_steps s ON s.id = a.step_id
GROUP BY a.step_id;
`,
];

// ────────────────────────────────────────────────────────────
// 连接与迁移
// ────────────────────────────────────────────────────────────
let _db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
	if (!_db) {
		fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
		const db = new DatabaseSync(DB_PATH);
		db.exec("PRAGMA journal_mode=WAL");
		db.exec("PRAGMA busy_timeout=5000");
		db.exec("PRAGMA foreign_keys=ON");
		migrate(db);
		_db = db;
	}
	return _db;
}

/** 仅测试用:重置连接(配合 WF_DB_PATH 指向临时库) */
export function resetDbForTests(): void {
	if (_db) {
		try {
			_db.close();
		} catch {
			/* ignore */
		}
		_db = null;
	}
}

function migrate(db: DatabaseSync): void {
	const row = db.prepare("PRAGMA user_version").get() as {
		user_version: number;
	};
	let version = row.user_version;
	while (version < MIGRATIONS.length) {
		db.exec("BEGIN");
		try {
			db.exec(MIGRATIONS[version]);
			db.exec(`PRAGMA user_version = ${version + 1}`);
			db.exec("COMMIT");
		} catch (err) {
			db.exec("ROLLBACK");
			throw err;
		}
		version++;
	}
}

export function now(): number {
	return Date.now();
}

// ────────────────────────────────────────────────────────────
// 事件
// ────────────────────────────────────────────────────────────
export function addEvent(db: DatabaseSync, input: EventInput): void {
	db.prepare(
		`INSERT INTO workflow_events (workflow_id, wave_id, step_id, attempt_id, type, payload, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	).run(
		input.workflowId,
		input.waveId ?? null,
		input.stepId ?? null,
		input.attemptId ?? null,
		input.type,
		input.payload === undefined ? null : JSON.stringify(input.payload),
		now(),
	);
}

// ────────────────────────────────────────────────────────────
// workflow
// ────────────────────────────────────────────────────────────
export function createWorkflow(
	db: DatabaseSync,
	input: NewWorkflowInput,
): WorkflowRow {
	const ts = now();
	db.prepare(
		`INSERT INTO workflow (id, title, goal, context, description, repo_path, concurrency, budget_cents, max_steps, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		input.id,
		input.title,
		input.goal,
		null,
		input.description ?? "",
		input.repoPath,
		input.concurrency ?? 4,
		input.budgetCents ?? null,
		input.maxSteps ?? 50,
		ts,
		ts,
	);
	addEvent(db, {
		workflowId: input.id,
		type: EVT.workflowCreated,
		payload: { title: input.title },
	});
	return getWorkflow(db, input.id)!;
}

export function getWorkflow(
	db: DatabaseSync,
	id: string,
): WorkflowRow | undefined {
	return db.prepare("SELECT * FROM workflow WHERE id = ?").get(id) as
		| WorkflowRow
		| undefined;
}

export function listWorkflows(
	db: DatabaseSync,
	status?: WorkflowStatus,
): WorkflowRow[] {
	if (status) {
		return db
			.prepare(
				"SELECT * FROM workflow WHERE status = ? ORDER BY created_at DESC",
			)
			.all(status) as WorkflowRow[];
	}
	return db
		.prepare("SELECT * FROM workflow ORDER BY created_at DESC")
		.all() as WorkflowRow[];
}

export function listActiveWorkflows(db: DatabaseSync): WorkflowRow[] {
	return db
		.prepare(
			"SELECT * FROM workflow WHERE status NOT IN ('completed', 'aborted') ORDER BY created_at DESC",
		)
		.all() as WorkflowRow[];
}

export function updateWorkflowStatus(
	db: DatabaseSync,
	id: string,
	status: WorkflowStatus,
	extra?: { error?: string },
): void {
	const patch: Record<string, unknown> = { status, updated_at: now() };
	if (status === "running" && !patch.started_at) patch.started_at = now();
	if (status === "completed") patch.completed_at = now();
	buildUpdate(db, "workflow", patch, { id });
}

/** 通用 UPDATE 助手:只更新给定字段;表名白名单防注入 */
const UPDATEABLE_TABLES = new Set([
	"workflow",
	"workflow_steps",
	"workflow_attempts",
	"workflow_waves",
]);

export function buildUpdate(
	db: DatabaseSync,
	table: string,
	patch: Record<string, unknown>,
	where: Record<string, unknown>,
): void {
	if (!UPDATEABLE_TABLES.has(table)) {
		throw new Error(`buildUpdate: 不允许更新表 ${table}`);
	}
	const keys = Object.keys(patch);
	if (keys.length === 0) return;
	const setSql = keys.map((k) => `${k} = ?`).join(", ");
	const whereSql = Object.keys(where)
		.map((k) => `${k} = ?`)
		.join(" AND ");
	db.prepare(`UPDATE ${table} SET ${setSql} WHERE ${whereSql}`).run(
		...keys.map((k) => patch[k]),
		...Object.values(where),
	);
}

// ────────────────────────────────────────────────────────────
// wave
// ────────────────────────────────────────────────────────────
export function createWave(
	db: DatabaseSync,
	workflowId: string,
	seq: number,
	note?: string,
): WaveRow {
	db.prepare(
		`INSERT INTO workflow_waves (workflow_id, seq, status, note, created_at)
		 VALUES (?, ?, 'planned', ?, ?)`,
	).run(workflowId, seq, note ?? null, now());
	return db
		.prepare("SELECT * FROM workflow_waves WHERE workflow_id = ? AND seq = ?")
		.get(workflowId, seq) as WaveRow;
}

export function getWave(
	db: DatabaseSync,
	workflowId: string,
	seq: number,
): WaveRow | undefined {
	return db
		.prepare("SELECT * FROM workflow_waves WHERE workflow_id = ? AND seq = ?")
		.get(workflowId, seq) as WaveRow | undefined;
}

export function listWaves(db: DatabaseSync, workflowId: string): WaveRow[] {
	return db
		.prepare("SELECT * FROM workflow_waves WHERE workflow_id = ? ORDER BY seq")
		.all(workflowId) as WaveRow[];
}

// ────────────────────────────────────────────────────────────
// step
// ────────────────────────────────────────────────────────────
export function createStep(db: DatabaseSync, input: NewStepInput): StepRow {
	const ts = now();
	const id = `${input.workflowId}-${input.dotted}`;
	db.prepare(
		`INSERT INTO workflow_steps (id, workflow_id, parent_id, wave_id, title, agent, status, gate, expectations, task_md, retries_done, max_retries, timeout_min, sort_order, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
	).run(
		id,
		input.workflowId,
		input.parentId ?? null,
		input.waveId ?? null,
		input.title,
		input.agent,
		input.gate ? 1 : 0,
		input.expectations && input.expectations.length > 0
			? JSON.stringify(input.expectations)
			: null,
		input.task,
		input.maxRetries ?? 1,
		input.timeoutMin ?? 60,
		input.sortOrder,
		ts,
		ts,
	);
	addEvent(db, {
		workflowId: input.workflowId,
		stepId: id,
		type: EVT.stepCreated,
		payload: { dotted: input.dotted, title: input.title, agent: input.agent },
	});
	return getStep(db, id)!;
}

export function getStep(db: DatabaseSync, id: string): StepRow | undefined {
	return db.prepare("SELECT * FROM workflow_steps WHERE id = ?").get(id) as
		| StepRow
		| undefined;
}

export function getStepsByWorkflow(
	db: DatabaseSync,
	workflowId: string,
): StepRow[] {
	return db
		.prepare(
			"SELECT * FROM workflow_steps WHERE workflow_id = ? ORDER BY sort_order",
		)
		.all(workflowId) as StepRow[];
}

export function getStepsByWave(db: DatabaseSync, waveId: number): StepRow[] {
	return db
		.prepare(
			"SELECT * FROM workflow_steps WHERE wave_id = ? ORDER BY sort_order",
		)
		.all(waveId) as StepRow[];
}

export function getStepDeps(db: DatabaseSync, stepId: string): string[] {
	const rows = db
		.prepare(
			"SELECT dep_id FROM workflow_step_deps WHERE step_id = ? ORDER BY dep_id",
		)
		.all(stepId) as Array<{ dep_id: string }>;
	return rows.map((r) => r.dep_id);
}

export function addStepDeps(
	db: DatabaseSync,
	stepId: string,
	depIds: string[],
): void {
	const stmt = db.prepare(
		"INSERT OR IGNORE INTO workflow_step_deps (step_id, dep_id, created_at) VALUES (?, ?, ?)",
	);
	const ts = now();
	for (const depId of depIds) stmt.run(stepId, depId, ts);
}

export function updateStepStatus(
	db: DatabaseSync,
	stepId: string,
	status: StepStatus,
	extra?: { error?: string },
): void {
	const patch: Record<string, unknown> = { status, updated_at: now() };
	if (extra?.error !== undefined) patch.error = extra.error;
	if (status === "running" || status === "dispatched") {
		if (extra?.error === undefined) patch.started_at = now();
	}
	if (
		["done", "failed", "aborted", "conflict", "skipped", "needsFix"].includes(
			status,
		)
	) {
		patch.finished_at = now();
	}
	buildUpdate(db, "workflow_steps", patch, { id: stepId });
}

export function updateStepReport(
	db: DatabaseSync,
	stepId: string,
	report: Record<string, unknown>,
): void {
	const ts = now();
	db.prepare(
		`UPDATE workflow_steps
		 SET report = ?, summary = ?, files_changed = ?, issues = ?, tests = ?, updated_at = ?
		 WHERE id = ?`,
	).run(
		JSON.stringify(report),
		typeof report.summary === "string" ? report.summary : null,
		Array.isArray(report.filesChanged)
			? JSON.stringify(report.filesChanged)
			: null,
		Array.isArray(report.issues) ? JSON.stringify(report.issues) : null,
		typeof report.tests === "string" ? report.tests : null,
		ts,
		stepId,
	);
}

export function stepStatusCounts(
	db: DatabaseSync,
	workflowId: string,
): Record<string, number> {
	const rows = db
		.prepare(
			"SELECT status, COUNT(*) AS n FROM workflow_steps WHERE workflow_id = ? GROUP BY status",
		)
		.all(workflowId) as Array<{ status: string; n: number }>;
	const out: Record<string, number> = {};
	for (const r of rows) out[r.status] = r.n;
	return out;
}

export function getRunningSteps(
	db: DatabaseSync,
	workflowId?: string,
): StepRow[] {
	if (workflowId) {
		return db
			.prepare(
				"SELECT * FROM workflow_steps WHERE workflow_id = ? AND status IN ('dispatched','running') ORDER BY sort_order",
			)
			.all(workflowId) as StepRow[];
	}
	return db
		.prepare(
			"SELECT * FROM workflow_steps WHERE status IN ('dispatched','running') ORDER BY sort_order",
		)
		.all() as StepRow[];
}

// ────────────────────────────────────────────────────────────
// attempt
// ────────────────────────────────────────────────────────────
export function createAttempt(
	db: DatabaseSync,
	stepId: string,
	opts: { taskMd: string; pointer: string; tabId?: string | null },
): AttemptRow {
	const row = db
		.prepare(
			"SELECT COALESCE(MAX(attempt_no), 0) + 1 AS next_no FROM workflow_attempts WHERE step_id = ?",
		)
		.get(stepId) as { next_no: number };
	const attemptNo = row.next_no;
	db.prepare(
		`INSERT INTO workflow_attempts (step_id, attempt_no, status, task_md, pointer, tab_id, started_at)
		 VALUES (?, ?, 'running', ?, ?, ?, ?)`,
	).run(
		stepId,
		attemptNo,
		opts.taskMd,
		opts.pointer,
		opts.tabId ?? null,
		now(),
	);
	return db
		.prepare(
			"SELECT * FROM workflow_attempts WHERE step_id = ? AND attempt_no = ?",
		)
		.get(stepId, attemptNo) as AttemptRow;
}

export function getAttempt(
	db: DatabaseSync,
	id: number,
): AttemptRow | undefined {
	return db.prepare("SELECT * FROM workflow_attempts WHERE id = ?").get(id) as
		| AttemptRow
		| undefined;
}

export function getLatestAttempt(
	db: DatabaseSync,
	stepId: string,
): AttemptRow | undefined {
	return db
		.prepare(
			"SELECT * FROM workflow_attempts WHERE step_id = ? ORDER BY attempt_no DESC LIMIT 1",
		)
		.get(stepId) as AttemptRow | undefined;
}

export function getAttemptsByStep(
	db: DatabaseSync,
	stepId: string,
): AttemptRow[] {
	return db
		.prepare(
			"SELECT * FROM workflow_attempts WHERE step_id = ? ORDER BY attempt_no",
		)
		.all(stepId) as AttemptRow[];
}

export function updateAttempt(
	db: DatabaseSync,
	attemptId: number,
	patch: {
		status?: AttemptStatus;
		report?: string | null;
		error?: string | null;
		tabId?: string | null;
		finishedAt?: boolean;
	},
): void {
	const p: Record<string, unknown> = {};
	if (patch.status !== undefined) p.status = patch.status;
	if (patch.report !== undefined) p.report = patch.report;
	if (patch.error !== undefined) p.error = patch.error;
	if (patch.tabId !== undefined) p.tab_id = patch.tabId;
	if (patch.finishedAt) p.finished_at = now();
	buildUpdate(db, "workflow_attempts", p, { id: attemptId });
}

// ────────────────────────────────────────────────────────────
// metadata(KV 扩展点)
// ────────────────────────────────────────────────────────────
export function setWorkflowMeta(
	db: DatabaseSync,
	workflowId: string,
	key: string,
	value: unknown,
): void {
	db.prepare(
		`INSERT INTO workflow_metadata (workflow_id, key, value, updated_at) VALUES (?, ?, ?, ?)
		 ON CONFLICT(workflow_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
	).run(workflowId, key, JSON.stringify(value), now());
}

export function getWorkflowMeta(
	db: DatabaseSync,
	workflowId: string,
	key: string,
): unknown {
	const row = db
		.prepare(
			"SELECT value FROM workflow_metadata WHERE workflow_id = ? AND key = ?",
		)
		.get(workflowId, key) as { value: string } | undefined;
	if (!row) return undefined;
	try {
		return JSON.parse(row.value);
	} catch {
		return row.value;
	}
}

export function setStepMeta(
	db: DatabaseSync,
	stepId: string,
	key: string,
	value: unknown,
): void {
	db.prepare(
		`INSERT INTO workflow_step_metadata (step_id, key, value, updated_at) VALUES (?, ?, ?, ?)
		 ON CONFLICT(step_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
	).run(stepId, key, JSON.stringify(value), now());
}

export function getStepMeta(
	db: DatabaseSync,
	stepId: string,
	key: string,
): unknown {
	const row = db
		.prepare(
			"SELECT value FROM workflow_step_metadata WHERE step_id = ? AND key = ?",
		)
		.get(stepId, key) as { value: string } | undefined;
	if (!row) return undefined;
	try {
		return JSON.parse(row.value);
	} catch {
		return row.value;
	}
}

// ────────────────────────────────────────────────────────────
// events 查询
// ────────────────────────────────────────────────────────────
export function getEvents(
	db: DatabaseSync,
	opts: {
		workflowId?: string;
		stepId?: string;
		limit?: number;
		afterId?: number;
	},
): EventRow[] {
	const clauses: string[] = [];
	const params: unknown[] = [];
	if (opts.workflowId) {
		clauses.push("workflow_id = ?");
		params.push(opts.workflowId);
	}
	if (opts.stepId) {
		clauses.push("step_id = ?");
		params.push(opts.stepId);
	}
	if (opts.afterId) {
		clauses.push("id > ?");
		params.push(opts.afterId);
	}
	const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
	const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
	return db
		.prepare(
			`SELECT * FROM workflow_events ${where} ORDER BY id DESC LIMIT ${limit}`,
		)
		.all(...params) as EventRow[];
}

// ────────────────────────────────────────────────────────────
// 聚合查询(看板/成本,可用性预置)
// ────────────────────────────────────────────────────────────
export function workflowCost(
	db: DatabaseSync,
	workflowId: string,
): {
	cost_cents: number;
	turns: number;
	attempts: number;
} | null {
	const rows = db
		.prepare("SELECT * FROM v_workflow_cost WHERE workflow_id = ?")
		.all(workflowId) as Array<{
		cost_cents: number | null;
		turns: number | null;
		attempts: number | null;
	}>;
	if (rows.length === 0) return null;
	return {
		cost_cents: rows.reduce((s, r) => s + (r.cost_cents ?? 0), 0),
		turns: rows.reduce((s, r) => s + (r.turns ?? 0), 0),
		attempts: rows.reduce((s, r) => s + (r.attempts ?? 0), 0),
	};
}
