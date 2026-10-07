/**
 * The one definition of a progressive job's progress, shared by the repository's job view (prepare,
 * claim, advance, status) and the jobs catalog so both expose the same logical state.
 *
 * `segment_index` is the window a worker processes next. It stays on the last window once the job
 * reaches consolidation, so it cannot count finished work: only a segment whose content was
 * submitted (`content_digest` set) is complete. `progress` must be the alias of
 * `distillation_progress` and `jobId` the SQL expression naming the job.
 */
export const distillationProgressColumns = (jobId: string): string =>
  `progress.segment_index,progress.stage,progress.source_digest,(SELECT COUNT(*) FROM distillation_segments completed WHERE completed.job_id=${jobId} AND completed.content_digest IS NOT NULL) AS completed_segments`;

/** Unvalidated contract fields; callers pass them through `parseDistillationProgress`. */
export const distillationProgressFields = (row: Record<string, unknown>): Record<string, unknown> => ({
  snapshotDigest: row.source_digest,
  segmentIndex: row.segment_index,
  stage: row.stage,
  completedSegments: row.completed_segments,
});
