import path from 'node:path';
import { LocalHistoryError, type LocalHistoryWarning } from '@ai-usage/local-machine/errors';
import {
  LocalHistoryStorage,
  type LocalHistoryStorage as LocalHistoryStorageService,
} from '@ai-usage/local-machine/local-history';
import { firstExisting, resolvePathCandidates } from '@ai-usage/local-machine/platform-paths';
import { normalizeIsoTimestamp } from '@ai-usage/report-core/provider-status';
import type {
  ClaudeDesktopCollectionCompleteness,
  ClaudeDesktopSessionObservation,
} from '@ai-usage/report-core/work-attention';
import { parseClaudeDesktopSessionFile } from '@ai-usage/report-core/work-attention-native';
import { Effect } from 'effect';

/**
 * Reads Claude Desktop's per-session registry read-only and hands each file to the pure
 * normalizer in `@ai-usage/report-core/work-attention-native`, which owns the attested shape and
 * every clamp. This module owns only the walk: which files are read, in what bounds, and how
 * every file that was not read or not understood is counted.
 */

export {
  CLAUDE_DESKTOP_SESSION_FORMAT_V1,
  type ClaudeDesktopSessionParseContext,
  type ClaudeDesktopSessionParseResult,
  parseClaudeDesktopSessionFile,
} from '@ai-usage/report-core/work-attention-native';

export const CLAUDE_DESKTOP_SESSIONS_MAX_FILES = 2000;
export const CLAUDE_DESKTOP_SESSION_FILE_MAX_BYTES = 256 * 1024;

const SESSION_FILE_PATTERN = /^local_[^/\\]+\.json$/u;

export interface CollectClaudeDesktopSessionsOptions {
  readonly machineId: string;
  /** Per-file byte ceiling; a larger file is rejected and counted, never partially read. */
  readonly maximumFileBytes?: number;
  /** Files read per sweep; the rest leave `truncated` set and a warning. */
  readonly maximumFiles?: number;
  readonly now?: () => Date;
}

export interface ClaudeDesktopSessionCollection {
  readonly completeness: ClaudeDesktopCollectionCompleteness;
  readonly observations: readonly ClaudeDesktopSessionObservation[];
  readonly warnings: readonly LocalHistoryWarning[];
}

const OPERATIONS = {
  clamped: 'claudeDesktopSessions.clamped',
  invalidJson: 'claudeDesktopSessions.invalidJson',
  notRegular: 'claudeDesktopSessions.notRegularFile',
  oversized: 'claudeDesktopSessions.oversized',
  rejected: 'claudeDesktopSessions.rejectedFormat',
  truncated: 'claudeDesktopSessions.truncated',
  unreadable: 'claudeDesktopSessions.unreadable',
} as const;

const emptyCollection = (): ClaudeDesktopSessionCollection => ({
  completeness: { filesParsed: 0, filesSeen: 0, rejected: 0, truncated: false, unsupported: 0 },
  observations: [],
  warnings: [],
});

const countWarning = (operation: string, message: string, count: number, root: string): LocalHistoryWarning => ({
  harness: 'claude',
  message,
  operation,
  path: root,
  rejectedRecords: count,
});

const directoryNames = (
  storage: LocalHistoryStorageService,
  directory: string,
): Effect.Effect<readonly string[] | null, never> =>
  storage.readDir(directory).pipe(
    Effect.map((entries) =>
      entries
        .filter((entry) => entry.isDirectory)
        .map((entry) => entry.name)
        .sort(),
    ),
    Effect.catchAll(() => Effect.succeed(null)),
  );

/**
 * One bounded, read-only sweep of the Desktop registry on this machine. Only regular files named
 * `local_*.json` at exactly `<account>/<org>/` depth are read; `archived-sessions.idx`,
 * `scheduled-tasks.json`, `deleted_*` and the `backlog/` directory are the app's own bookkeeping
 * and are ignored by name. A missing registry is an empty, complete collection: detection is the
 * source adapter's job.
 */
export const collectClaudeDesktopSessions = (
  options: CollectClaudeDesktopSessionsOptions,
): Effect.Effect<ClaudeDesktopSessionCollection, LocalHistoryError, LocalHistoryStorageService> =>
  Effect.gen(function* () {
    const storage = yield* LocalHistoryStorage;
    const maximumFiles = options.maximumFiles ?? CLAUDE_DESKTOP_SESSIONS_MAX_FILES;
    const maximumFileBytes = options.maximumFileBytes ?? CLAUDE_DESKTOP_SESSION_FILE_MAX_BYTES;
    if (
      !(
        Number.isSafeInteger(maximumFiles) &&
        maximumFiles > 0 &&
        Number.isSafeInteger(maximumFileBytes) &&
        maximumFileBytes > 0
      )
    ) {
      return yield* Effect.fail(
        new LocalHistoryError({
          cause: new Error('Claude Desktop session collection bounds must be positive integers.'),
          operation: 'claudeDesktopSessions.bounds',
        }),
      );
    }
    const root = yield* firstExisting(storage, ...resolvePathCandidates(storage).claude.desktopSessionsDir);
    if (root === null) {
      return emptyCollection();
    }
    const readMetadata = storage.readFileMetadata?.bind(storage);
    if (readMetadata === undefined) {
      return yield* Effect.fail(
        new LocalHistoryError({
          cause: new Error('The local history storage does not expose file metadata.'),
          operation: 'readFileMetadata',
          path: root,
        }),
      );
    }
    const observedAt = (options.now ?? (() => new Date()))().toISOString();
    const observations: ClaudeDesktopSessionObservation[] = [];
    const warnings: LocalHistoryWarning[] = [];
    const counts = { clamped: 0, invalidJson: 0, notRegular: 0, oversized: 0, rejected: 0, unreadable: 0 };
    let filesSeen = 0;
    let filesParsed = 0;
    let unsupported = 0;
    let truncated = false;

    const accounts = yield* storage.readDir(root);
    const accountNames = accounts
      .filter((entry) => entry.isDirectory)
      .map((entry) => entry.name)
      .sort();
    scan: for (const account of accountNames) {
      const accountDirectory = path.join(root, account);
      const organizations = yield* directoryNames(storage, accountDirectory);
      if (organizations === null) {
        truncated = true;
        continue;
      }
      for (const organization of organizations) {
        const organizationDirectory = path.join(accountDirectory, organization);
        const entries = yield* storage.readDir(organizationDirectory).pipe(Effect.catchAll(() => Effect.succeed(null)));
        if (entries === null) {
          truncated = true;
          continue;
        }
        const candidates = entries
          .filter((entry) => SESSION_FILE_PATTERN.test(entry.name))
          .sort((left, right) => left.name.localeCompare(right.name, 'en'));
        for (const entry of candidates) {
          if (filesSeen >= maximumFiles) {
            truncated = true;
            break scan;
          }
          filesSeen++;
          const filePath = path.join(organizationDirectory, entry.name);
          if (!entry.isRegularFile) {
            counts.notRegular++;
            counts.rejected++;
            continue;
          }
          if (entry.size > maximumFileBytes) {
            counts.oversized++;
            counts.rejected++;
            continue;
          }
          const read = yield* Effect.all({
            metadata: readMetadata(filePath),
            text: storage.readText(filePath, maximumFileBytes),
          }).pipe(Effect.either);
          if (read._tag === 'Left') {
            // A file listed and then removed or replaced mid-sweep is counted, not fatal: the
            // rest of the registry still answers and the count says one did not.
            counts.unreadable++;
            counts.rejected++;
            continue;
          }
          let raw: unknown;
          try {
            raw = JSON.parse(read.right.text);
          } catch {
            counts.invalidJson++;
            counts.rejected++;
            continue;
          }
          const fileModifiedAt = normalizeIsoTimestamp(read.right.metadata.mtimeMs);
          if (fileModifiedAt === null) {
            counts.unreadable++;
            counts.rejected++;
            continue;
          }
          const result = parseClaudeDesktopSessionFile(raw, {
            accountDirectory: account,
            fileModifiedAt,
            machineId: options.machineId,
            observedAt,
            organizationDirectory: organization,
            relativeFilePath: path.relative(storage.home, filePath),
          });
          switch (result.kind) {
            case 'observation':
              filesParsed++;
              observations.push(result.observation);
              if (result.clampedFields.length > 0) {
                counts.clamped++;
              }
              break;
            case 'unsupported':
              unsupported++;
              if (result.observation !== null) {
                observations.push(result.observation);
              }
              break;
            default:
              counts.rejected++;
              break;
          }
        }
      }
    }

    if (truncated) {
      warnings.push({
        harness: 'claude',
        message: `Claude Desktop session registry exceeds the ${maximumFiles}-file bound or a directory was unreadable; later files were not read.`,
        operation: OPERATIONS.truncated,
        path: root,
      });
    }
    const countWarnings: readonly (readonly [keyof typeof counts, string, string])[] = [
      ['oversized', OPERATIONS.oversized, `Claude Desktop session files over ${maximumFileBytes} bytes were not read.`],
      ['notRegular', OPERATIONS.notRegular, 'Claude Desktop session entries that are not regular files were not read.'],
      ['invalidJson', OPERATIONS.invalidJson, 'Claude Desktop session files that are not valid JSON were rejected.'],
      ['unreadable', OPERATIONS.unreadable, 'Claude Desktop session files could not be read.'],
      ['clamped', OPERATIONS.clamped, 'Claude Desktop session fields were cut to the Work attention bounds.'],
    ];
    for (const [key, operation, message] of countWarnings) {
      if (counts[key] > 0) {
        warnings.push(countWarning(operation, message, counts[key], root));
      }
    }
    const rejectedFormat =
      counts.rejected - counts.oversized - counts.notRegular - counts.invalidJson - counts.unreadable;
    if (rejectedFormat > 0) {
      warnings.push(
        countWarning(
          OPERATIONS.rejected,
          'Claude Desktop session files without the required identity fields were rejected.',
          rejectedFormat,
          root,
        ),
      );
    }
    return {
      completeness: { filesParsed, filesSeen, rejected: counts.rejected, truncated, unsupported },
      observations,
      warnings,
    };
  });
