import { mkdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CLAUDE_DESKTOP_FIXTURE_PAIRS,
  type ClaudeDesktopSessionsFixtureVariant,
  claudeDesktopFixtureRegistry,
  type SeededClaudeDesktopSessionIds,
} from '@ai-usage/report-core/test-fixtures/claude-desktop-sessions';

/**
 * Writes the synthetic Claude Desktop registry described by
 * `@ai-usage/report-core/test-fixtures/claude-desktop-sessions` under a fixture home, beside the
 * app's own bookkeeping files (`archived-sessions.idx`, `scheduled-tasks.json`, `backlog/`, a
 * `deleted_*` file). File mtimes are pinned to the document's `modifiedAt` so a re-import of an
 * unchanged registry is `unchanged`.
 */

export {
  CLAUDE_DESKTOP_FIXTURE_DEFAULT_EPOCH,
  CLAUDE_DESKTOP_FIXTURE_MISSING_PARENT_ID,
  CLAUDE_DESKTOP_FIXTURE_PROMPT_SENTINEL,
  type ClaudeDesktopSessionsFixtureVariant,
  type SeededClaudeDesktopSessionIds,
} from '@ai-usage/report-core/test-fixtures/claude-desktop-sessions';

export interface SeededClaudeDesktopSessions {
  readonly childCount: number;
  readonly cliSessionIds: {
    readonly blockedRoot: string;
    readonly noTranscriptRoot: string | null;
  };
  readonly epoch: string;
  readonly ids: SeededClaudeDesktopSessionIds;
  readonly registryDirectory: string;
  readonly rootCount: number;
  readonly variant: ClaudeDesktopSessionsFixtureVariant;
}

export interface ClaudeDesktopSessionsFixtureOptions {
  /** The transcript id the seeded Claude home carries; `blockedRoot` joins to it. */
  readonly cliSessionIdWithTranscript: string;
  readonly epoch?: Date;
  readonly home: string;
  /** The seeded repository checkout; every `cwd` is this path or a worktree under it. */
  readonly repository: string;
  readonly variant: ClaudeDesktopSessionsFixtureVariant;
}

export const seedClaudeDesktopSessions = async (
  options: ClaudeDesktopSessionsFixtureOptions,
): Promise<SeededClaudeDesktopSessions> => {
  const registry = claudeDesktopFixtureRegistry({
    cliSessionIdWithTranscript: options.cliSessionIdWithTranscript,
    ...(options.epoch === undefined ? {} : { epoch: options.epoch }),
    repository: options.repository,
    variant: options.variant,
  });
  const registryDirectory = join(options.home, '.config', 'Claude', 'claude-code-sessions');
  for (const [index, pair] of CLAUDE_DESKTOP_FIXTURE_PAIRS.entries()) {
    const directory = join(registryDirectory, pair.account, pair.organization);
    await mkdir(join(directory, 'backlog'), { recursive: true });
    await writeFile(join(directory, 'backlog', 'tasks.json'), JSON.stringify({ items: [], version: 1 }));
    await writeFile(join(directory, 'scheduled-tasks.json'), JSON.stringify({ tasks: [] }));
    await writeFile(
      join(directory, 'archived-sessions.idx'),
      JSON.stringify({ archived: registry.archivedByPair[index] ?? [], v: 1 }),
    );
  }
  for (const entry of registry.documents) {
    const filePath = join(registryDirectory, entry.account, entry.organization, entry.fileName);
    await writeFile(filePath, JSON.stringify(entry.document));
    await utimes(filePath, entry.modifiedAt, entry.modifiedAt);
  }
  if (options.variant === 'representative') {
    const pair = CLAUDE_DESKTOP_FIXTURE_PAIRS[0];
    await writeFile(
      join(registryDirectory, pair.account, pair.organization, 'deleted_local_fixture-gone.json'),
      JSON.stringify({ sessionId: 'gone' }),
    );
  }
  return {
    childCount: registry.childCount,
    cliSessionIds: registry.cliSessionIds,
    epoch: registry.epoch,
    ids: registry.ids,
    registryDirectory,
    rootCount: registry.rootCount,
    variant: registry.variant,
  };
};
