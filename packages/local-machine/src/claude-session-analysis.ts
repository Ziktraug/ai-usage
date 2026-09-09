import path from 'node:path';
import type { LocalSessionAnalysis } from '@ai-usage/report-core/session-detail';
import { Effect } from 'effect';
import { type ClaudeAgentMeta, parseClaudeSessionFacts } from './claude-session-facts';
import { LocalHistoryError } from './errors';
import {
  HISTORY_JSONL_MAX_BYTES,
  HISTORY_LINE_MAX_BYTES,
  HISTORY_SCAN_MAX_DEPTH,
  HISTORY_SCAN_MAX_FILES,
} from './history-budgets';
import { readLocalGitRepository } from './local-git';
import { LocalHistoryStorage, type LocalHistoryStorage as LocalHistoryStorageService } from './local-history';
import { resolvePaths } from './platform-paths';
import { safeJSON } from './text';

const SAFE_CLAUDE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,511}$/;

const findClaudeTranscript = (
  storage: LocalHistoryStorageService,
  sourceSessionId: string,
): Effect.Effect<string | null, LocalHistoryError> =>
  Effect.gen(function* () {
    const root = resolvePaths(storage).claude.projectsDir;
    if (!(yield* storage.exists(root))) {
      return null;
    }
    const targetName = `${sourceSessionId}.jsonl`;
    const pending = [{ depth: 0, directory: root }];
    const matches: string[] = [];
    let visited = 0;
    while (pending.length > 0) {
      const current = pending.pop();
      if (!current) {
        break;
      }
      if (current.depth > HISTORY_SCAN_MAX_DEPTH) {
        return yield* Effect.fail(
          new LocalHistoryError({
            operation: 'readClaudeSessionAnalysis.depthLimit',
            path: current.directory,
            cause: new Error('Claude history exceeds its scan depth budget'),
          }),
        );
      }
      const entries = yield* storage.readDir(current.directory);
      for (const entry of entries) {
        visited += 1;
        if (visited > HISTORY_SCAN_MAX_FILES) {
          return yield* Effect.fail(
            new LocalHistoryError({
              operation: 'readClaudeSessionAnalysis.fileLimit',
              path: root,
              cause: new Error('Claude history exceeds its file budget'),
            }),
          );
        }
        const candidate = path.join(current.directory, entry.name);
        if (entry.name === targetName) {
          if (!entry.isRegularFile) {
            return yield* Effect.fail(
              new LocalHistoryError({
                operation: 'readClaudeSessionAnalysis.unsafeFile',
                path: candidate,
                cause: new Error('Claude transcript is not a regular no-follow file'),
              }),
            );
          }
          matches.push(candidate);
        } else if (entry.isDirectory) {
          pending.push({ depth: current.depth + 1, directory: candidate });
        }
      }
    }
    if (matches.length > 1) {
      return yield* Effect.fail(
        new LocalHistoryError({
          operation: 'readClaudeSessionAnalysis.ambiguous',
          path: root,
          cause: new Error('Claude session identity maps to multiple transcripts'),
        }),
      );
    }
    return matches[0] ?? null;
  });

export const readClaudeSessionAnalysis = (
  sourceSessionId: string,
): Effect.Effect<LocalSessionAnalysis | null, LocalHistoryError, LocalHistoryStorageService> =>
  Effect.gen(function* () {
    if (!SAFE_CLAUDE_SESSION_ID.test(sourceSessionId)) {
      return null;
    }
    const storage = yield* LocalHistoryStorage;
    const transcript = yield* findClaudeTranscript(storage, sourceSessionId);
    if (!transcript) {
      return null;
    }
    const records: unknown[] = [];
    yield* storage.readLines(
      transcript,
      (line) => {
        if (!line) {
          return;
        }
        const parsed = safeJSON(line);
        if (parsed) {
          records.push(parsed);
        }
      },
      { maxBytes: HISTORY_JSONL_MAX_BYTES, maxLineBytes: HISTORY_LINE_MAX_BYTES },
    );
    const isAgentFile = path.basename(transcript).startsWith('agent-');
    const metas = isAgentFile
      ? { agentMetas: [], agentMetasUnreadable: 0 }
      : yield* readClaudeAgentMetas(storage, path.join(path.dirname(transcript), sourceSessionId, 'subagents'));
    const input = { ...metas, isAgentFile, records, sourceSessionId };
    const initial = parseClaudeSessionFacts({ ...input, repository: null });
    if (!initial) {
      return null;
    }
    const repository = readLocalGitRepository(initial.source.sourcePath);
    const facts = repository ? parseClaudeSessionFacts({ ...input, repository }) : initial;
    return facts ? { detail: facts.detailFacts, projection: facts.projection } : null;
  });

const MAX_CLAUDE_AGENT_META_FILES = 512;
const MAX_CLAUDE_WORKFLOW_RUN_DIRECTORIES = 64;
const MAX_CLAUDE_AGENT_META_BYTES = 64 * 1024;
const CLAUDE_AGENT_META_SUFFIX = '.meta.json';
const CLAUDE_AGENT_FILE_PREFIX = 'agent-';
const CLAUDE_WORKFLOWS_DIRECTORY = 'workflows';
const SAFE_CLAUDE_WORKFLOW_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const optionalString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

/**
 * Read the `agent-<id>.meta.json` sidecars of one session's sub-agents. A
 * missing directory is an ordinary session without sub-agents; a sidecar that
 * cannot be read within budget is counted, never fatal, so the session keeps
 * its rounds and reports the gap through coverage.
 */
const readClaudeAgentMetas = (
  storage: LocalHistoryStorageService,
  directory: string,
): Effect.Effect<{ agentMetas: ClaudeAgentMeta[]; agentMetasUnreadable: number }, LocalHistoryError> =>
  Effect.gen(function* () {
    const agentMetas: ClaudeAgentMeta[] = [];
    let agentMetasUnreadable = 0;
    let attemptedReads = 0;
    if (!(yield* storage.exists(directory))) {
      return { agentMetas, agentMetasUnreadable };
    }
    const collect = function* (target: string, workflowRunId: string | null) {
      const entries = yield* storage.readDir(target);
      const sidecars = entries
        .filter(
          (entry) =>
            entry.isRegularFile &&
            entry.name.startsWith(CLAUDE_AGENT_FILE_PREFIX) &&
            entry.name.endsWith(CLAUDE_AGENT_META_SUFFIX),
        )
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of sidecars) {
        // Every sidecar, readable or not, is charged against one budget.
        attemptedReads += 1;
        if (attemptedReads > MAX_CLAUDE_AGENT_META_FILES) {
          agentMetasUnreadable += 1;
          continue;
        }
        const agentId = entry.name.slice(CLAUDE_AGENT_FILE_PREFIX.length, -CLAUDE_AGENT_META_SUFFIX.length);
        if (!SAFE_CLAUDE_SESSION_ID.test(agentId)) {
          agentMetasUnreadable += 1;
          continue;
        }
        const text = yield* storage
          .readText(path.join(target, entry.name), MAX_CLAUDE_AGENT_META_BYTES)
          .pipe(Effect.catchAll(() => Effect.succeed(null)));
        const parsed = text === null ? null : safeJSON(text);
        if (!(parsed && typeof parsed === 'object' && !Array.isArray(parsed))) {
          agentMetasUnreadable += 1;
          continue;
        }
        const meta = parsed as Record<string, unknown>;
        agentMetas.push({
          agentId,
          agentType: optionalString(meta.agentType),
          description: optionalString(meta.description),
          toolUseId: optionalString(meta.toolUseId),
          workflowRunId,
        });
      }
      return entries;
    };
    const entries = yield* Effect.gen(() => collect(directory, null));
    // Workflow fan-outs keep their agents one level down, under the run id the
    // Workflow tool result named.
    const workflowsDirectory = path.join(directory, CLAUDE_WORKFLOWS_DIRECTORY);
    if (entries.some((entry) => entry.isDirectory && entry.name === CLAUDE_WORKFLOWS_DIRECTORY)) {
      const runs = (yield* storage.readDir(workflowsDirectory))
        .filter((entry) => entry.isDirectory && SAFE_CLAUDE_WORKFLOW_RUN_ID.test(entry.name))
        .sort((left, right) => left.name.localeCompare(right.name));
      agentMetasUnreadable += Math.max(0, runs.length - MAX_CLAUDE_WORKFLOW_RUN_DIRECTORIES);
      for (const run of runs.slice(0, MAX_CLAUDE_WORKFLOW_RUN_DIRECTORIES)) {
        yield* Effect.gen(() => collect(path.join(workflowsDirectory, run.name), run.name));
      }
    }
    return { agentMetas, agentMetasUnreadable };
  });
