/**
 * observe/wave.ts — wave 合并(arch-refactor §3.7,自 src/observe/monitor.ts 同名迁移)
 *
 * - mergeWave:wave 全部终态后按 sort_order 串行 gittree merge --delete,
 *   冲突 → 步骤 conflict(事件 merge_conflict),wave → merged(事件 wave_merged);
 * - mergePreview:供测试/诊断的合并进度预览(不执行)。
 */
import type { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import {
	EVT,
	STEP_STATUS,
	type StepRow,
	type WorkflowRow,
	addEvent,
	buildUpdate,
	getStepsByWave,
	getWave,
	updateStepStatus,
} from "../core/db.ts";
import { resolveBin, run, worktreeName, worktreePath } from "../exec/shell.ts";

export interface MergeResult {
	ok: boolean;
	wave: number;
	merged: string[];
	conflicts: string[];
	skipped: number;
	error?: string;
}

/**
 * wave 全部终态后串行合并:
 * - 未终态步骤存在 → 拒绝
 * - 按 sort_order 逐个 gittree merge <name> --delete
 * - 失败 → 步骤 conflict + 事件 merge_conflict,中断后续合并
 * - 全部成功 → wave merged + 事件 wave_merged
 */
export async function mergeWave(
	db: DatabaseSync,
	workflow: WorkflowRow,
	waveSeq: number,
	opts: { gittreeBin?: string } = {},
): Promise<MergeResult> {
	const gittreeBin = opts.gittreeBin ?? resolveBin("gittree");
	const wave = getWave(db, workflow.id, waveSeq);
	if (!wave) {
		return {
			ok: false,
			wave: waveSeq,
			merged: [],
			conflicts: [],
			skipped: 0,
			error: `wave ${waveSeq} 不存在`,
		};
	}
	const steps = getStepsByWave(db, wave.id);
	if (steps.length === 0) {
		return {
			ok: false,
			wave: waveSeq,
			merged: [],
			conflicts: [],
			skipped: 0,
			error: `wave ${waveSeq} 没有步骤`,
		};
	}

	const notFinal = steps.filter(
		(s) => s.status !== STEP_STATUS.done && s.status !== STEP_STATUS.skipped,
	);
	if (notFinal.length > 0) {
		return {
			ok: false,
			wave: waveSeq,
			merged: [],
			conflicts: [],
			skipped: 0,
			error: `wave ${waveSeq} 未全部完成: ${notFinal.map((s) => s.id).join(", ")}`,
		};
	}

	const ordered = [...steps].sort((a, b) => a.sort_order - b.sort_order);
	const merged: string[] = [];
	const conflicts: string[] = [];

	/** 兜底清理:目录仍在则 gittree clean --branch --force(删 worktree+分支);失败仅记事件不阻断 */
	const sweepWorktree = async (s: StepRow): Promise<void> => {
		if (!s.worktree) return;
		const wtDir = worktreePath(
			workflow.repo_path,
			workflow.id,
			s.id.slice(workflow.id.length + 1),
		);
		if (!fs.existsSync(wtDir)) return; // 已清理,无需处理
		const res = await run(
			gittreeBin,
			["clean", s.worktree, "--branch", "--force"],
			workflow.repo_path,
		);
		addEvent(db, {
			workflowId: workflow.id,
			stepId: s.id,
			type: EVT.worktreeCleaned,
			payload:
				res.code === 0
					? { worktree: s.worktree, mergeSweep: true }
					: {
							worktree: s.worktree,
							mergeSweep: true,
							error: (res.stderr || res.stdout).slice(0, 300),
						},
		});
	};

	for (const s of ordered) {
		if (!s.worktree) continue;
		if (s.status === STEP_STATUS.skipped) {
			// skipped:不合并,但 worktree/分支一并清掉(合并主线后不留 gittree 残留)
			await sweepWorktree(s);
			continue;
		}
		// 幂等:worktree 目录已不存在(上次 merge --delete 已清理)→ 视为已合并跳过
		const wtDir = worktreePath(
			workflow.repo_path,
			workflow.id,
			s.id.slice(workflow.id.length + 1),
		);
		if (!fs.existsSync(wtDir)) {
			merged.push(s.id);
			continue;
		}
		// 分支不存在(评审类步骤无提交/此前已合并清理)→ 无需合并,跳过
		const branchCheck = await run(
			"git",
			["rev-parse", "--verify", `refs/heads/gittree-${s.worktree}`],
			workflow.repo_path,
		);
		if (branchCheck.code !== 0) {
			merged.push(s.id);
			continue;
		}
		const res = await run(
			gittreeBin,
			["merge", s.worktree, "--delete"],
			workflow.repo_path,
		);
		if (res.code === 0) {
			merged.push(s.id);
			addEvent(db, {
				workflowId: workflow.id,
				stepId: s.id,
				type: EVT.worktreeMerged,
				payload: { worktree: s.worktree },
			});
		} else {
			// 冲突:保留 worktree 现场,步骤标 conflict
			updateStepStatus(
				db,
				s.id,
				STEP_STATUS.conflict,
				{ error: `merge 冲突: ${res.stderr || res.stdout}`.trim() },
				{ strict: true },
			);
			addEvent(db, {
				workflowId: workflow.id,
				stepId: s.id,
				type: EVT.mergeConflict,
				payload: {
					worktree: s.worktree,
					detail: (res.stderr || res.stdout).slice(0, 500),
				},
			});
			conflicts.push(s.id);
			break; // 冲突中断后续合并(需人工解决)
		}
	}

	if (conflicts.length === 0) {
		// 合并全部成功:对 wave 内所有步骤做目录残留兜底清理
		// (覆盖 merge --delete 未删干净 / 已合并但目录残留等场景)
		for (const s of ordered) {
			await sweepWorktree(s);
		}
		buildUpdate(
			db,
			"workflow_waves",
			{ status: "merged", merged_at: Date.now() },
			{ id: wave.id },
		);
		addEvent(db, {
			workflowId: workflow.id,
			waveId: wave.id,
			type: EVT.waveMerged,
			payload: { wave: waveSeq, merged },
		});
		return {
			ok: true,
			wave: waveSeq,
			merged,
			conflicts,
			skipped: steps.length - merged.length,
		};
	}

	return {
		ok: false,
		wave: waveSeq,
		merged,
		conflicts,
		skipped: 0,
		error: `wave ${waveSeq} 存在冲突,解决后 /wf resolve-conflict`,
	};
}

/** 供测试/诊断:wave 合并进度预览(不执行) */
export function mergePreview(
	db: DatabaseSync,
	workflowId: string,
	waveSeq: number,
): string[] {
	const wave = getWave(db, workflowId, waveSeq);
	if (!wave) return [];
	const steps = getStepsByWave(db, wave.id);
	return [...steps]
		.sort((a, b) => a.sort_order - b.sort_order)
		.map(
			(s) =>
				`${s.id} [${s.status}] ${s.worktree ? worktreeName(workflowId, s.id.slice(workflowId.length + 1)) : "(无 worktree)"}`,
		);
}
