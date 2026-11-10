import fs from 'node:fs';
import path from 'node:path';
import { scheduler } from 'node:timers/promises';
import {
  extractClaudeSkillObservations,
  MAX_CLAUDE_SOURCE_PATHS,
  parseClaudeSessionFacts,
  parseClaudeTranscript,
} from '@ai-usage/local-machine/claude-session-facts';
import type { LocalHistoryError, LocalHistoryWarning } from '@ai-usage/local-machine/errors';
import { readLocalGitRepository } from '@ai-usage/local-machine/local-git';
import { LocalHistoryStorage, readRegularFileText, walkFiles } from '@ai-usage/local-machine/local-history';
import { type HarnessPaths, resolvePaths } from '@ai-usage/local-machine/platform-paths';
import { base, safeJSON, usablePrompt } from '@ai-usage/local-machine/text';
import type { SessionVcsRepository } from '@ai-usage/report-core/session-vcs';
import {
  MAX_SKILL_OBSERVATIONS_PER_SESSION,
  type SkillObservation,
  type SkillObservationCollectionCompleteness,
} from '@ai-usage/report-core/skill-observation';
import { actualCost, approximateApiCost } from '@ai-usage/report-core/usage-row';
import { Effect } from 'effect';
import { type CollectedSession, sessionToUsageRow } from '../collected-session';
import { collectorCachePath, reviveCollectorRowsResult, reviveSkillObservationsResult } from '../collector-cache';
import { COLLECTOR_CACHE_MAX_BYTES, SMALL_HISTORY_JSON_MAX_BYTES } from '../history-budgets';
import {
  metricValidationWarning,
  oversizedHistoryLineWarning,
  parseNonNegativeSafeInteger,
  skillObservationTruncationWarning,
  skillObservationValidationWarning,
} from '../metric-validation';
import { withPerfSpan } from '../perf';
import { readPrivateJson, writePrivateJson } from '../private-storage';
import type { CollectorRow } from '../rtk-enrichment';

interface ClaudeHistoryFallback {
  end: Date;
  project: string | null;
  sessionId: string;
  start: Date;
  turns: number;
}
interface FileFingerprint {
  mtimeMs: number;
  size: number;
}
type ClaudeProvider = 'Claude sub' | 'Claude API';

interface ClaudeFileResult {
  /** Explicit launches only: a SendMessage recipient does not establish parentage. */
  declaredChildSourceSessionIds: string[];
  lineageIncomplete: boolean;
  observations: SkillObservation[];
  observationsTruncated: boolean;
  /** Cached for the same reason as the reject counts: a warm scan must not look complete. */
  oversizedLines: number;
  /**
   * Every line parsed, within budget, and the transcript still holds no usage and no human
   * prompt: the file positively describes a session that is not a usage row. Never set for a
   * missing, unreadable, oversized or budget-refused transcript.
   */
  parsedWithoutUsage: boolean;
  /**
   * The checkout root is filesystem state outside the transcript's size+mtime key, like the
   * repository: a hit re-resolves it for the recorded folders and re-parses when it changed.
   */
  projectRoot: string | null;
  rejectedMetricRecords: number;
  /** Cached so a warm re-scan reports the same partial-data state as a cold one. */
  rejectedObservations: number;
  /**
   * The project's origin repository is outside the transcript's size+mtime key:
   * a hit re-resolves it for this project path and re-parses when it changed.
   */
  repositoryKey: string | null;
  repositorySourcePath: string | null;
  rows: CollectorRow[];
  /** The session's distinct working folders in order of first observation; the first is the launch folder. */
  sourcePaths: string[];
}
interface ClaudeCacheEntry extends FileFingerprint, ClaudeFileResult {}
interface ClaudeCache {
  files: Record<string, unknown>;
  provider: ClaudeProvider;
  version: number;
}
// Bumped to 10 because version 9 silently discarded malformed JSONL records.
// Reusing one could certify invocation absence even though an incomplete final
// record hid a Skill call.
// Bumped to 11 because the per-line byte bound rose to 32 MiB and an oversized
// record is now dropped and counted instead of failing the read. A version 10
// entry was written when a pasted-image record could still abort the transcript,
// so it under-reports both the rows and the loss.
// Rows include calculated costs; invalidate them when newly priced models land.
// Bumped to 13 to retain the maximum streamed output per message/request.
// Version 12 cached only the first valid usage and can undercount output.
// Bumped to 14 to count tool uses streamed in later content-block records of a
// message. Version 13 ignored them and can undercount tools.
// Bumped to 15 for per-transcript stat-keyed entries, including partial-data
// counters and the resolved origin repository, with the pricing provider shared
// by the entire cache.
// Bumped to 16 to retain explicit launch identities for cross-transcript lineage.
// Bumped to 17 so unchanged transcripts gain attested Claude-to-Codex delegations.
// Bumped to 18 because resume arguments now require a non-error correlated result,
// and supported launch wrappers and redirects recover previously omitted attestations.
// Bumped to 19 to reject resume evidence masked by later semicolon commands and
// retain matching native thread evidence when a resumed command ends in error.
// Bumped to 21 to reprice rows after the GPT-5.2/gpt-4.1/o4-mini/Haiku 5.5 pricing update.
// 22: several `cwd` of one clone (subdirectories, worktrees) no longer mark the VCS context partial.
// 23: the project is the checkout root of the launch folder (worktrees and subdirectories fold into
// their repository), `<synthetic>` records no longer count as model attributions or calls, and a
// cleanly parsed transcript without usage is retained as a retirement.
// 24: a retirement needs the parser's explicit empty observation. Version 23 also retired
// transcripts the parser rejected (no timestamped record, malformed or missing usage) and lost
// their rejected usage counts.
// 25: a transcript with a record the parser could not place (a non-object line, an undated
// `user`/`assistant`/untyped record) or a model reply whose `message` is not an object is rejected,
// never observed empty; version 24 entries may hold such a retirement.
const CLAUDE_CACHE_VERSION = 25;
const MAX_DECLARED_CLAUDE_CHILDREN = 512;
const claudeCachePath = (storage: LocalHistoryStorage) => collectorCachePath(storage, 'claude-cache.json');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readClaudeCache = (storage: LocalHistoryStorage): ClaudeCache | null => {
  try {
    if (!fs.existsSync(storage.home)) {
      return null;
    }
    const parsed = readPrivateJson(claudeCachePath(storage), COLLECTOR_CACHE_MAX_BYTES);
    if (
      !(
        isRecord(parsed) &&
        parsed.version === CLAUDE_CACHE_VERSION &&
        (parsed.provider === 'Claude sub' || parsed.provider === 'Claude API') &&
        isRecord(parsed.files)
      )
    ) {
      return null;
    }
    return {
      files: parsed.files,
      provider: parsed.provider,
      version: CLAUDE_CACHE_VERSION,
    };
  } catch {
    return null;
  }
};

const reviveClaudeCacheEntry = (value: unknown, provider: ClaudeProvider): ClaudeCacheEntry | null => {
  if (!isRecord(value)) {
    return null;
  }
  const revived = reviveCollectorRowsResult(value.rows);
  const observations = reviveSkillObservationsResult(value.observations);
  const size = parseNonNegativeSafeInteger(value.size);
  const oversizedLines = parseNonNegativeSafeInteger(value.oversizedLines);
  const rejectedMetricRecords = parseNonNegativeSafeInteger(value.rejectedMetricRecords);
  const rejectedObservations = parseNonNegativeSafeInteger(value.rejectedObservations);
  const { projectRoot, repositoryKey, repositorySourcePath, sourcePaths } = value;
  if (
    !(
      size.ok &&
      Array.isArray(sourcePaths) &&
      sourcePaths.length <= MAX_CLAUDE_SOURCE_PATHS &&
      sourcePaths.every((folder: unknown) => typeof folder === 'string' && folder.length > 0) &&
      typeof value.parsedWithoutUsage === 'boolean' &&
      (projectRoot === null || typeof projectRoot === 'string') &&
      typeof value.mtimeMs === 'number' &&
      Number.isFinite(value.mtimeMs) &&
      oversizedLines.ok &&
      rejectedMetricRecords.ok &&
      rejectedObservations.ok &&
      revived.valid &&
      revived.rejectedMetricRecords === 0 &&
      revived.rows.length <= 1 &&
      revived.rows.every((row) => row.provider === provider) &&
      Array.isArray(value.declaredChildSourceSessionIds) &&
      value.declaredChildSourceSessionIds.length <= MAX_DECLARED_CLAUDE_CHILDREN &&
      value.declaredChildSourceSessionIds.every((id: unknown) => typeof id === 'string' && id.length > 0) &&
      typeof value.lineageIncomplete === 'boolean' &&
      observations.valid &&
      typeof value.observationsTruncated === 'boolean' &&
      (repositoryKey === null || typeof repositoryKey === 'string') &&
      (repositorySourcePath === null || typeof repositorySourcePath === 'string')
    )
  ) {
    return null;
  }
  return {
    mtimeMs: value.mtimeMs,
    size: size.value,
    declaredChildSourceSessionIds: value.declaredChildSourceSessionIds,
    lineageIncomplete: value.lineageIncomplete,
    observations: observations.observations,
    observationsTruncated: value.observationsTruncated,
    oversizedLines: oversizedLines.value,
    parsedWithoutUsage: value.parsedWithoutUsage,
    projectRoot,
    rejectedMetricRecords: rejectedMetricRecords.value,
    rejectedObservations: rejectedObservations.value,
    repositoryKey,
    repositorySourcePath,
    rows: revived.rows,
    sourcePaths,
  };
};

type ClaudeRepositoryResolver = (sourcePath: string | null) => SessionVcsRepository | null;

const repositoryCacheKey = (repository: SessionVcsRepository | null): string | null =>
  repository ? JSON.stringify([repository.host, repository.ownerPath, repository.provenance, repository.webUrl]) : null;

/** Memoised per scan: transcripts of one project share a single `.git/config` read. */
const createClaudeRepositoryResolver = (): ClaudeRepositoryResolver => {
  const resolved = new Map<string, SessionVcsRepository | null>();
  return (sourcePath) => {
    if (sourcePath === null) {
      return null;
    }
    if (!resolved.has(sourcePath)) {
      resolved.set(sourcePath, readLocalGitRepository(sourcePath));
    }
    return resolved.get(sourcePath) ?? null;
  };
};

const MAX_PROJECT_ROOT_SEARCH_DEPTH = 32;
const MAX_GIT_POINTER_BYTES = 4096;
const GIT_POINTER = /^gitdir:\s*(.+?)\s*$/m;
const LINKED_WORKTREE_GIT_DIR = /^(.*)[/\\]\.git[/\\]worktrees[/\\][^/\\]+$/;

/**
 * The checkout root a folder belongs to: the directory holding `.git`. A linked worktree (`git
 * worktree add`, including Claude Code's `.claude/worktrees/<name>` and sibling folders outside the
 * clone) carries a `.git` file pointing into `<root>/.git/worktrees/<name>`; it resolves to that
 * main root so every worktree of one repository is the same project. A deleted worktree inside the
 * clone still walks up to the clone. `null` when no checkout encloses the folder.
 */
export const resolveClaudeProjectRoot = (folder: string | null): string | null => {
  if (!(folder && path.isAbsolute(folder) && !folder.includes('\0'))) {
    return null;
  }
  let current = path.resolve(folder);
  for (let depth = 0; depth <= MAX_PROJECT_ROOT_SEARCH_DEPTH; depth += 1) {
    const gitPath = path.join(current, '.git');
    try {
      const gitStat = fs.lstatSync(gitPath);
      if (gitStat.isDirectory()) {
        return current;
      }
      if (gitStat.isFile()) {
        const pointer = GIT_POINTER.exec(readRegularFileText(gitPath, MAX_GIT_POINTER_BYTES))?.[1];
        const gitDirectory = pointer ? path.resolve(current, pointer) : null;
        const linked = gitDirectory ? LINKED_WORKTREE_GIT_DIR.exec(gitDirectory)?.[1] : undefined;
        return linked ? linked : current;
      }
    } catch {
      // Missing or unsafe checkout metadata is absence, never session failure.
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return null;
};

type ClaudeProjectRootResolver = (folder: string) => string | null;

/** Memoised per scan: transcripts launched in one folder share a single lookup. */
const createClaudeProjectRootResolver = (): ClaudeProjectRootResolver => {
  const resolved = new Map<string, string | null>();
  return (folder) => {
    if (!resolved.has(folder)) {
      resolved.set(folder, resolveClaudeProjectRoot(folder));
    }
    return resolved.get(folder) ?? null;
  };
};

/**
 * The session's project is the checkout of the first recorded folder that lies in one. The launch
 * folder is the operator's stated intent and stays fixed for the session's lifetime, unlike the
 * last `cd`; skipping folders outside any checkout covers sessions launched from a scratch
 * workspace or a parent folder before moving into the repository.
 */
const claudeProjectRootFor = (sourcePaths: readonly string[], resolveProjectRoot: ClaudeProjectRootResolver) => {
  for (const folder of sourcePaths) {
    const root = resolveProjectRoot(folder);
    if (root !== null) {
      return root;
    }
  }
  return null;
};

const writeClaudeCache = (
  storage: LocalHistoryStorage,
  provider: ClaudeProvider,
  files: Record<string, ClaudeCacheEntry>,
): boolean => {
  if (!fs.existsSync(storage.home)) {
    return false;
  }
  const cachePath = claudeCachePath(storage);
  const value = {
    files,
    provider,
    version: CLAUDE_CACHE_VERSION,
  };
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > COLLECTOR_CACHE_MAX_BYTES) {
    return false;
  }
  writePrivateJson(cachePath, value);
  return true;
};

const fileFingerprint = (filePath: string): FileFingerprint | null => {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return null;
    }
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
};

const HOUSEKEEPING_COMMANDS = new Set(['/clear', '/model', '/effort', '/usage', '/rate-limit-options', '/resume']);

const isUsageBearingHistoryEntry = (text: string | null) => {
  if (!text) {
    return false;
  }
  const cleaned = text.trim();
  return cleaned.length > 0 && !HOUSEKEEPING_COMMANDS.has(cleaned);
};

const readClaudeHistoryFallbacks = (
  storage: LocalHistoryStorage,
  existingSessionIds: Set<string>,
  paths: import('@ai-usage/local-machine/platform-paths').HarnessPaths,
): Effect.Effect<ClaudeHistoryFallback[], LocalHistoryError> =>
  Effect.gen(function* () {
    const historyFile = paths.claude.historyFile;
    if (!(yield* storage.exists(historyFile))) {
      return [];
    }

    const sessions = new Map<string, ClaudeHistoryFallback>();
    yield* storage.readLines(historyFile, (line) => {
      if (!line) {
        return;
      }
      const event = safeJSON(line);
      if (!event) {
        return;
      }
      const sessionId = typeof event?.sessionId === 'string' ? event.sessionId : null;
      if (!sessionId || existingSessionIds.has(sessionId)) {
        return;
      }
      const timestamp = Number(event.timestamp);
      const date = new Date(timestamp);
      if (!Number.isFinite(date.getTime())) {
        return;
      }

      const display = typeof event.display === 'string' ? event.display : null;
      const prompt = usablePrompt(display);
      const usageBearing = isUsageBearingHistoryEntry(prompt);
      const current = sessions.get(sessionId) ?? {
        sessionId,
        start: date,
        end: date,
        project: typeof event.project === 'string' ? event.project : null,
        turns: 0,
      };

      if (date < current.start) {
        current.start = date;
      }
      if (date > current.end) {
        current.end = date;
      }
      if (!current.project && typeof event.project === 'string') {
        current.project = event.project;
      }
      if (usageBearing) {
        current.turns++;
      }
      sessions.set(sessionId, current);
    });

    return [...sessions.values()].filter((session) => session.turns > 0);
  });

// Claude Code prunes chat transcripts whose last activity is older than this many
// days; the default applies when `cleanupPeriodDays` is unset in settings.json.
const CLAUDE_DEFAULT_CLEANUP_DAYS = 30;

// Surface a heads-up when Claude Code is configured to delete transcripts, since
// this report is rebuilt from those transcripts: anything pruned is unrecoverable.
export const collectClaudeRetentionWarnings: Effect.Effect<LocalHistoryWarning[], never, LocalHistoryStorage> =
  Effect.gen(function* () {
    const storage = yield* LocalHistoryStorage;
    const paths: HarnessPaths = resolvePaths(storage);
    const settingsFile = paths.claude.settingsFile;

    const exists = yield* storage.exists(settingsFile).pipe(Effect.catch(() => Effect.succeed(false)));
    // Settings are user-managed config, so read them through the
    // symlink-following path: dotfiles managers commonly install
    // ~/.claude/settings.json as a symlink, which the hardened history read
    // rejects by design.
    const raw = exists
      ? yield* storage
          .readConfigText(settingsFile, SMALL_HISTORY_JSON_MAX_BYTES)
          .pipe(Effect.catch(() => Effect.succeed(null)))
      : '{}';
    const parsed = raw === null ? null : safeJSON(raw);
    if (parsed === null) {
      // The file exists but could not be read or parsed. Retention is unknown
      // here — say so instead of wrongly claiming the lossy default applies.
      return [
        {
          harness: 'claude',
          operation: 'claude.settings',
          path: settingsFile,
          message: `Claude Code transcript retention could not be verified: ${settingsFile} exists but could not be read as JSON. If cleanupPeriodDays is unset there, Claude Code deletes transcripts after ${CLAUDE_DEFAULT_CLEANUP_DAYS} days and that usage can no longer be reported.`,
        },
      ];
    }
    const configured = parsed.cleanupPeriodDays;
    const hasExplicit = typeof configured === 'number' && Number.isFinite(configured);
    const days = hasExplicit ? configured : CLAUDE_DEFAULT_CLEANUP_DAYS;

    // Only warn when retention is at or below the lossy default; raising the value
    // (or disabling cleanup) means history is being kept, so stay quiet.
    if (days > CLAUDE_DEFAULT_CLEANUP_DAYS) {
      return [];
    }

    const detail = hasExplicit
      ? `cleanupPeriodDays is set to ${days}`
      : `cleanupPeriodDays is unset, so the ${CLAUDE_DEFAULT_CLEANUP_DAYS}-day default applies`;
    return [
      {
        harness: 'claude',
        operation: 'claude.settings',
        path: settingsFile,
        message: `Claude Code deletes chat transcripts after ${days} days (${detail}). Usage older than ${days} days is removed permanently and can no longer be reported — raise cleanupPeriodDays in ~/.claude/settings.json to keep your history.`,
      },
    ];
  });

export interface ClaudeCollectionResult {
  observationCompleteness: SkillObservationCollectionCompleteness;
  /**
   * A new fact drawn from the collection source this collector already reads —
   * not a new collection source. The source vocabulary is unchanged.
   */
  observations: SkillObservation[];
  /**
   * Source session ids whose transcript exists, parsed cleanly and holds neither usage nor a human
   * prompt (mode, permission and system records only): positively observed and deliberately not a
   * usage row, so a row stored for them earlier may be retired. Never a session that is merely
   * absent, unreadable, over budget, or only known from the prompt-history fallback.
   */
  retiredSourceSessionIds: string[];
  rows: CollectorRow[];
  warnings: LocalHistoryWarning[];
}

const claudeObservationCompleteness = (
  rejected: number,
  truncated: boolean,
): SkillObservationCollectionCompleteness => ({
  exposure: { rejected: 0, truncated: false },
  invocation: { rejected, truncated },
});

const parseClaudeFile = (
  storage: LocalHistoryStorage,
  filePath: string,
  provider: ClaudeProvider,
  resolveRepository: ClaudeRepositoryResolver,
  resolveProjectRoot: ClaudeProjectRootResolver,
): Effect.Effect<{ lines: number; result: ClaudeFileResult }, LocalHistoryError> =>
  Effect.gen(function* () {
    const sourceSessionId = path.basename(filePath, '.jsonl');
    const isAgentFile = path.basename(filePath).startsWith('agent-');
    const records: unknown[] = [];
    let lines = 0;
    let rejectedLines = 0;
    const transcriptRead = yield* storage.readLines(filePath, (line) => {
      if (!line) {
        return;
      }
      lines++;
      const event = safeJSON(line);
      if (event) {
        records.push(event);
      } else {
        // A live JSONL file can expose its final record while Claude Code is
        // still appending it. It may be a Skill call, so dropping it cannot
        // support an exact invocation-absence claim.
        rejectedLines++;
      }
    });
    // Extract independently: a transcript can record a skill invocation without
    // producing a usage row, and that invocation remains a fact about the skill.
    const extraction = extractClaudeSkillObservations({ records, sourceSessionId });
    const result: ClaudeFileResult = {
      declaredChildSourceSessionIds: [],
      lineageIncomplete: false,
      observations: extraction.observations,
      observationsTruncated: extraction.truncated,
      oversizedLines: transcriptRead.oversizedLines,
      parsedWithoutUsage: false,
      projectRoot: null,
      rejectedMetricRecords: 0,
      rejectedObservations: rejectedLines + extraction.rejected,
      repositoryKey: null,
      repositorySourcePath: null,
      rows: [],
      sourcePaths: [],
    };
    const parsed = parseClaudeTranscript({ isAgentFile, records, repository: null, sourceSessionId });
    if (parsed.kind !== 'facts') {
      // Only the parser's explicit empty observation retires a session, and only
      // when every line reached it: a line that failed to parse or was dropped for
      // size may be the usage. A rejected transcript (no timestamps, a reply whose
      // usage was malformed or missing, over budget) is not a "no usage" observation,
      // and its rejected usage records are still reported.
      result.parsedWithoutUsage = parsed.kind === 'empty' && rejectedLines === 0 && transcriptRead.oversizedLines === 0;
      if (parsed.kind === 'rejected') {
        result.rejectedMetricRecords = parsed.rejectedMetricRecords;
      }
      return { lines, result };
    }
    const initialFacts = parsed.facts;
    const repository = resolveRepository(initialFacts.source.sourcePath);
    result.repositoryKey = repositoryCacheKey(repository);
    result.repositorySourcePath = initialFacts.source.sourcePath;
    result.sourcePaths = [...initialFacts.source.sourcePaths];
    result.projectRoot = claudeProjectRootFor(result.sourcePaths, resolveProjectRoot);
    const facts = repository
      ? (parseClaudeSessionFacts({
          isAgentFile,
          records,
          repository,
          sourcePathRepository: resolveRepository,
          sourceSessionId,
        }) ?? initialFacts)
      : initialFacts;
    const { projection, report, source } = facts;
    result.declaredChildSourceSessionIds = [
      ...new Set(
        facts.detailFacts.interactions.flatMap((interaction) =>
          interaction.kind === 'spawn' && interaction.childSourceSessionId !== null
            ? [interaction.childSourceSessionId]
            : [],
        ),
      ),
    ];
    result.lineageIncomplete =
      facts.detailFacts.coverage.childDiscovery.status !== 'complete' ||
      facts.detailFacts.coverage.interactionAttribution.reasons.includes('interaction-budget');
    result.rejectedMetricRecords = report.rejectedMetricRecords;
    const session: CollectedSession = {
      source: {
        harnessKey: 'claude',
        sourceSessionId,
        ...(source.delegatedSessions ? { delegatedSessions: source.delegatedSessions } : {}),
        ...(source.parentSourceSessionId === null ? {} : { parentSourceSessionId: source.parentSourceSessionId }),
        sourcePath: source.sourcePath,
        ...(source.vcs ? { vcs: source.vcs } : {}),
      },
      projectPath: source.sourcePath,
      date: report.start,
      endDate: report.end,
      provider,
      name: report.name,
      titleSource: report.titleSource,
      model: report.model,
      models: report.models,
      modelSegments: report.modelSegments,
      origin: report.sidechain ? 'subagent' : 'human',
      // The checkout the session started working in, whatever folder it ended in:
      // a worktree or package of one repository is that repository's work.
      project: base(result.projectRoot ?? source.sourcePaths[0] ?? source.sourcePath),
      tokens: report.tokens,
      cost: provider === 'Claude API' ? approximateApiCost : actualCost(0),
      calls: report.calls,
      durationMs: projection.durationMs,
      partial: projection.partial,
      turns: report.turns,
      tools: report.tools,
      linesAdded: null,
      linesDeleted: null,
      subagent: report.sidechain,
    };
    result.rows.push(sessionToUsageRow(session));
    return { lines, result };
  });

const claudeLineageIdentity = (row: CollectorRow, sessionId = row.source?.sourceSessionId): string | null =>
  row.source?.harnessKey === 'claude' && sessionId ? JSON.stringify([row.source.machineId ?? null, sessionId]) : null;

/** Compose current evidence after the scan; never persist derived parents in per-file caches. */
const reconcileClaudeLineage = (
  rows: CollectorRow[],
  declaredChildren: ReadonlyMap<
    CollectorRow,
    Pick<ClaudeFileResult, 'declaredChildSourceSessionIds' | 'lineageIncomplete'>
  >,
): { rows: CollectorRow[]; warnings: LocalHistoryWarning[] } => {
  const byIdentity = new Map<string, CollectorRow[]>();
  for (const row of rows) {
    const key = claudeLineageIdentity(row);
    if (key !== null) {
      const matching = byIdentity.get(key) ?? [];
      matching.push(row);
      byIdentity.set(key, matching);
    }
  }
  const unresolved = new Set<string>();
  const conflicts = new Set<string>();
  const declarations = new Map<string, Set<string>>();
  const partial = new Set<string>();
  for (const [parent, evidence] of declaredChildren) {
    const parentKey = claudeLineageIdentity(parent);
    if (parentKey === null) {
      continue;
    }
    if (evidence.lineageIncomplete) {
      partial.add(parentKey);
    }
    for (const childId of evidence.declaredChildSourceSessionIds) {
      const childKey = claudeLineageIdentity(parent, childId);
      if (childKey === null) {
        continue;
      }
      if (!byIdentity.has(childKey)) {
        unresolved.add(childKey);
      } else if (byIdentity.get(parentKey)?.length !== 1 || parentKey === childKey) {
        conflicts.add(childKey);
      } else {
        const parents = declarations.get(childKey) ?? new Set<string>();
        parents.add(parentKey);
        declarations.set(childKey, parents);
      }
    }
  }
  const supplements = new Map<string, string>();
  const parentKeys = new Map<string, string>();
  for (const [key, matching] of byIdentity) {
    const row = matching[0];
    if (!row || matching.length !== 1) {
      conflicts.add(key);
      continue;
    }
    const declared = declarations.get(key) ?? new Set<string>();
    const direct = row.source?.parentSourceSessionId;
    const directKey = direct ? claudeLineageIdentity(row, direct) : null;
    if (directKey !== null) {
      parentKeys.set(key, directKey);
      if (!byIdentity.has(directKey)) {
        unresolved.add(key);
      }
      if ([...declared].some((parent) => parent !== directKey)) {
        conflicts.add(key);
      }
    } else if (declared.size > 1) {
      conflicts.add(key);
    } else if (!conflicts.has(key)) {
      const parentKey = [...declared][0];
      const parentId = parentKey === undefined ? undefined : byIdentity.get(parentKey)?.[0]?.source?.sourceSessionId;
      if (parentKey !== undefined && parentId) {
        supplements.set(key, parentId);
        parentKeys.set(key, parentKey);
      }
    }
  }
  // Memoised walks remain linear even for deeply nested launches. Any path into a
  // cycle is unresolved; recorded direct parents remain intact for diagnosis.
  const reachesCycle = new Map<string, boolean>();
  for (const start of supplements.keys()) {
    const visiting = new Set<string>();
    let current: string | undefined = start;
    while (current !== undefined && !visiting.has(current) && !reachesCycle.has(current)) {
      visiting.add(current);
      current = parentKeys.get(current);
    }
    const cycle = current !== undefined && (visiting.has(current) || reachesCycle.get(current) === true);
    for (const key of visiting) {
      reachesCycle.set(key, cycle);
    }
  }
  const linkedRows = rows.map((row) => {
    const key = claudeLineageIdentity(row);
    const parent = key === null ? undefined : supplements.get(key);
    if (!(key !== null && parent && row.source)) {
      return row;
    }
    if (reachesCycle.get(key)) {
      conflicts.add(key);
      return row;
    }
    return { ...row, source: { ...row.source, parentSourceSessionId: parent } };
  });
  const warnings: LocalHistoryWarning[] = [];
  if (partial.size > 0) {
    warnings.push({
      affectedSessions: partial.size,
      harness: 'claude',
      operation: 'claude.lineage-partial',
      message: `${partial.size} Claude sessions have incomplete launch evidence or exceeded a link budget. Additional related sessions may be unlinked.`,
    });
  }
  if (unresolved.size > 0) {
    warnings.push({
      affectedSessions: unresolved.size,
      harness: 'claude',
      operation: 'claude.lineage-unresolved',
      message: `${unresolved.size} Claude session links name a parent or child absent from collected history. Related work may be missing.`,
    });
  }
  if (conflicts.size > 0) {
    warnings.push({
      affectedSessions: conflicts.size,
      harness: 'claude',
      operation: 'claude.lineage-conflict',
      message: `${conflicts.size} Claude sessions have conflicting or ambiguous lineage evidence. Recorded direct parents are preserved; no ambiguous parent is added.`,
    });
  }
  return { rows: linkedRows, warnings };
};

interface ClaudeParsedFile {
  filePath: string;
  result: ClaudeFileResult;
}

const rowTokenTotal = (row: CollectorRow): number => row.tokIn + row.tokOut + row.tokCr + row.tokCw;
const rowEndTime = (row: CollectorRow): number => (row.endDate ?? row.date)?.getTime() ?? 0;

/** Negative when `left` is the more complete copy of one session; the path breaks exact ties. */
const compareClaudeCopies = (left: ClaudeParsedFile, right: ClaudeParsedFile): number => {
  const leftRow = left.result.rows[0];
  const rightRow = right.result.rows[0];
  if (!(leftRow && rightRow)) {
    return (
      Number(rightRow !== undefined) - Number(leftRow !== undefined) || left.filePath.localeCompare(right.filePath)
    );
  }
  return (
    rowTokenTotal(rightRow) - rowTokenTotal(leftRow) ||
    rowEndTime(rightRow) - rowEndTime(leftRow) ||
    left.filePath.localeCompare(right.filePath)
  );
};

/**
 * One transcript per session. A sub-agent transcript is copied under every parent that forked or
 * resumed the conversation, so the same session id can appear in two `subagents/` folders; the
 * copies are identical or one is a prefix of the other. Keeping the most complete copy (most
 * deduplicated usage, then the later last event, then the path) makes the result independent of
 * the walk order instead of letting the store keep whichever copy it saw last. A session is
 * retired only when every copy positively parsed without usage.
 */
const selectClaudeTranscripts = (
  files: readonly ClaudeParsedFile[],
): { duplicates: number; retained: ClaudeParsedFile[]; retiredSourceSessionIds: string[] } => {
  const copiesBySession = new Map<string, ClaudeParsedFile[]>();
  for (const file of files) {
    const sourceSessionId = path.basename(file.filePath, '.jsonl');
    const copies = copiesBySession.get(sourceSessionId) ?? [];
    copies.push(file);
    copiesBySession.set(sourceSessionId, copies);
  }
  const retained: ClaudeParsedFile[] = [];
  const retiredSourceSessionIds: string[] = [];
  let duplicates = 0;
  for (const [sourceSessionId, copies] of copiesBySession) {
    const winner = [...copies].sort(compareClaudeCopies)[0];
    if (!winner) {
      continue;
    }
    retained.push(winner);
    duplicates += copies.length - 1;
    if (winner.result.rows.length === 0 && copies.every((copy) => copy.result.parsedWithoutUsage)) {
      retiredSourceSessionIds.push(sourceSessionId);
    }
  }
  return { duplicates, retained, retiredSourceSessionIds: retiredSourceSessionIds.sort() };
};

export const collectClaudeResult = Effect.gen(function* () {
  const storage = yield* LocalHistoryStorage;
  const paths = resolvePaths(storage);
  const dir = paths.claude.projectsDir;
  const files = yield* withPerfSpan(
    'aiUsage.collect.claude.walkFiles',
    walkFiles(storage, dir, (fileName) => fileName.endsWith('.jsonl')),
    (value) => ({ files: value.length }),
  );
  const cache = yield* withPerfSpan(
    'aiUsage.collect.claude.cache.read',
    Effect.sync(() => readClaudeCache(storage)),
    (value) => ({ entries: Object.keys(value?.files ?? {}).length }),
  );

  let provider: ClaudeProvider = 'Claude sub';
  const cfg = paths.claude.configFile;
  if (yield* storage.exists(cfg).pipe(Effect.catch(() => Effect.succeed(false)))) {
    const json = safeJSON(
      yield* storage.readConfigText(cfg, SMALL_HISTORY_JSON_MAX_BYTES).pipe(Effect.catch(() => Effect.succeed(''))),
    );
    if (json?.hasApiKey) {
      provider = 'Claude API';
    }
  }

  const rows: CollectorRow[] = [];
  const declaredChildren = new Map<CollectorRow, ClaudeFileResult>();
  const nextFiles: Record<string, ClaudeCacheEntry> = {};
  const observations: SkillObservation[] = [];
  const retiredSourceSessionIds: string[] = [];
  const existingSessionIds = new Set(files.map((filePath) => path.basename(filePath, '.jsonl')));
  let rejectedMetricRecords = 0;
  let rejectedObservations = 0;
  let observationsTruncated = false;
  let oversizedLines = 0;

  const parsedFiles = yield* withPerfSpan(
    'aiUsage.collect.claude.parseFiles',
    Effect.gen(function* () {
      let lines = 0;
      let parsed = 0;
      let hits = 0;
      const resolveRepository = createClaudeRepositoryResolver();
      const resolveProjectRoot = createClaudeProjectRootResolver();
      const transcripts: ClaudeParsedFile[] = [];
      for (const filePath of files) {
        const fingerprint = fileFingerprint(filePath);
        const cached =
          fingerprint && cache?.provider === provider ? reviveClaudeCacheEntry(cache.files[filePath], provider) : null;
        let result: ClaudeFileResult;
        if (
          cached &&
          fingerprint &&
          cached.size === fingerprint.size &&
          cached.mtimeMs === fingerprint.mtimeMs &&
          cached.repositoryKey === repositoryCacheKey(resolveRepository(cached.repositorySourcePath)) &&
          cached.projectRoot === claudeProjectRootFor(cached.sourcePaths, resolveProjectRoot)
        ) {
          result = cached;
          nextFiles[filePath] = cached;
          hits++;
        } else {
          if (parsed > 0) {
            yield* Effect.promise(() => scheduler.yield());
          }
          const collected = yield* parseClaudeFile(storage, filePath, provider, resolveRepository, resolveProjectRoot);
          parsed++;
          lines += collected.lines;
          result = collected.result;
          if (fingerprint) {
            nextFiles[filePath] = { ...fingerprint, ...result };
          }
        }
        transcripts.push({ filePath, result });
      }
      const selected = selectClaudeTranscripts(transcripts);
      for (const { result } of selected.retained) {
        rows.push(...result.rows);
        for (const row of result.rows) {
          declaredChildren.set(row, result);
        }
        observations.push(...result.observations);
        rejectedMetricRecords += result.rejectedMetricRecords;
        rejectedObservations += result.rejectedObservations;
        observationsTruncated ||= result.observationsTruncated;
        oversizedLines += result.oversizedLines;
      }
      retiredSourceSessionIds.push(...selected.retiredSourceSessionIds);
      const pruned = Object.keys(cache?.files ?? {}).filter((filePath) => !Object.hasOwn(nextFiles, filePath)).length;
      return {
        files: files.length,
        parsed,
        hits,
        pruned,
        duplicates: selected.duplicates,
        lines,
        observations: observations.length,
        retired: retiredSourceSessionIds.length,
        sessions: rows.length,
      };
    }),
    (result) => result,
  );

  for (const session of yield* readClaudeHistoryFallbacks(storage, existingSessionIds, paths)) {
    rows.push(
      sessionToUsageRow({
        source: { harnessKey: 'claude', sourceSessionId: session.sessionId, sourcePath: session.project },
        projectPath: session.project,
        date: session.start,
        endDate: session.end,
        provider,
        name: `claude ${session.sessionId.slice(0, 8)}`,
        titleSource: 'id',
        originProvenance: 'origin-degraded',
        model: 'usage unavailable',
        project: base(session.project),
        tokens: { in: 0, out: 0, cr: 0, cw: 0 },
        cost: actualCost(null),
        calls: 0,
        turns: session.turns,
        tools: 0,
        linesAdded: null,
        linesDeleted: null,
        usageUnavailable: true,
      }),
    );
  }

  if (parsedFiles.parsed > 0 || parsedFiles.pruned > 0) {
    yield* withPerfSpan(
      'aiUsage.collect.claude.cache.write',
      Effect.sync(() => writeClaudeCache(storage, provider, nextFiles)),
      (wrote) => ({ wrote }),
    );
  }
  const warning = metricValidationWarning('claude', rejectedMetricRecords);
  const observationWarning = skillObservationValidationWarning('claude', rejectedObservations);
  const oversizedWarning = oversizedHistoryLineWarning('claude', oversizedLines);
  const truncationWarning = observationsTruncated
    ? skillObservationTruncationWarning('claude', MAX_SKILL_OBSERVATIONS_PER_SESSION)
    : null;
  const lineage = reconcileClaudeLineage(rows, declaredChildren);
  return {
    observationCompleteness: claudeObservationCompleteness(rejectedObservations, observationsTruncated),
    observations,
    retiredSourceSessionIds,
    rows: lineage.rows,
    warnings: [warning, observationWarning, oversizedWarning, truncationWarning, ...lineage.warnings].filter(
      (value) => value !== null,
    ),
  };
});

export const collectClaude = collectClaudeResult.pipe(Effect.map((result) => result.rows));
