import path from 'node:path';
import type { LocalSessionAnalysis } from '@ai-usage/report-core/session-detail';
import { Effect } from 'effect';
import { parseClaudeSessionFacts } from './claude-session-facts';
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
    const initial = parseClaudeSessionFacts({ isAgentFile, records, repository: null, sourceSessionId });
    if (!initial) {
      return null;
    }
    const repository = readLocalGitRepository(initial.source.sourcePath);
    const facts = repository ? parseClaudeSessionFacts({ isAgentFile, records, repository, sourceSessionId }) : initial;
    return facts ? { detail: facts.detailFacts, projection: facts.projection } : null;
  });
