import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLocalHistoryStorage, LocalHistoryStorage } from '@ai-usage/local-machine/local-history';
import { Effect } from 'effect';
import { collectClaudeResult, resolveClaudeProjectRoot } from './collectors/claude';
import type { CollectorRow } from './rtk-enrichment';

const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) {
    await rm(home, { force: true, recursive: true });
  }
});

const jsonl = (...records: unknown[]): string => `${records.map((entry) => JSON.stringify(entry)).join('\n')}\n`;

const at = (minute: number) => `2026-04-25T08:${String(minute).padStart(2, '0')}:00.000Z`;

const user = (minute: number, cwd: string, text = `Prompt ${minute}`) => ({
  type: 'user',
  timestamp: at(minute),
  uuid: `user-${minute}`,
  cwd,
  message: { role: 'user', content: text },
});

const assistant = (minute: number, cwd: string, inputTokens = 10) => ({
  type: 'assistant',
  timestamp: at(minute),
  uuid: `assistant-${minute}`,
  parentUuid: `user-${minute}`,
  cwd,
  requestId: `request-${minute}`,
  message: {
    id: `message-${minute}`,
    model: 'claude-sonnet-4-6',
    content: [{ type: 'text', text: 'Done' }],
    usage: { input_tokens: inputTokens, output_tokens: 5 },
  },
});

/** The records Claude Code writes for a session that was opened and closed without a prompt. */
const housekeeping = (sessionId: string) => [
  { type: 'mode', mode: 'normal', sessionId },
  { type: 'permission-mode', permissionMode: 'default', sessionId },
  {
    type: 'system',
    subtype: 'local_command',
    timestamp: at(0),
    uuid: `system-${sessionId}`,
    parentUuid: null,
    isSidechain: false,
    content: '<command-name>/resume</command-name>',
  },
  { type: 'last-prompt', leafUuid: `system-${sessionId}`, sessionId },
];

const gitDirectory = (root: string) => mkdir(path.join(root, '.git'), { recursive: true });

/** `git worktree add`: a `.git` file in the worktree points into the clone's `.git/worktrees/<name>`. */
const linkedWorktree = async (root: string, worktree: string, name: string) => {
  await mkdir(worktree, { recursive: true });
  await mkdir(path.join(root, '.git', 'worktrees', name), { recursive: true });
  await writeFile(path.join(worktree, '.git'), `gitdir: ${path.join(root, '.git', 'worktrees', name)}\n`);
};

const fixture = async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'ai-usage-claude-attribution-'));
  homes.push(home);
  const projects = path.join(home, '.claude', 'projects', 'fixture');
  await mkdir(projects, { recursive: true });
  const baseStorage = createLocalHistoryStorage(home);
  const reads = new Map<string, number>();
  const storage: LocalHistoryStorage = {
    ...baseStorage,
    readLines: (filePath, visit, limits) =>
      Effect.suspend(() => {
        reads.set(filePath, (reads.get(filePath) ?? 0) + 1);
        return baseStorage.readLines(filePath, visit, limits);
      }),
  };
  const run = () => Effect.runPromise(collectClaudeResult.pipe(Effect.provideService(LocalHistoryStorage, storage)));
  const transcript = async (relativePath: string, ...records: unknown[]) => {
    const filePath = path.join(projects, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, jsonl(...records));
    return filePath;
  };
  const rowFor = (rows: CollectorRow[], sourceSessionId: string) =>
    rows.filter((row) => row.source?.sourceSessionId === sourceSessionId);
  return { home, projects, reads, rowFor, run, transcript };
};

describe('resolveClaudeProjectRoot', () => {
  test('resolves the clone root from the root, a package and a deleted folder below it', async () => {
    const { home } = await fixture();
    const clone = path.join(home, 'clone');
    await gitDirectory(clone);
    await mkdir(path.join(clone, 'packages', 'app'), { recursive: true });
    expect(resolveClaudeProjectRoot(clone)).toBe(clone);
    expect(resolveClaudeProjectRoot(path.join(clone, 'packages', 'app'))).toBe(clone);
    expect(resolveClaudeProjectRoot(path.join(clone, '.claude', 'worktrees', 'removed-worktree'))).toBe(clone);
  });

  test('resolves linked worktrees inside and outside the clone to the clone', async () => {
    const { home } = await fixture();
    const clone = path.join(home, 'clone');
    await gitDirectory(clone);
    const inside = path.join(clone, '.claude', 'worktrees', 'brave-hopper-1a2b3c');
    const sibling = path.join(home, 'clone-wt', 'review');
    await linkedWorktree(clone, inside, 'brave-hopper-1a2b3c');
    await linkedWorktree(clone, sibling, 'review');
    await mkdir(path.join(sibling, 'packages', 'web'), { recursive: true });
    expect(resolveClaudeProjectRoot(inside)).toBe(clone);
    expect(resolveClaudeProjectRoot(sibling)).toBe(clone);
    expect(resolveClaudeProjectRoot(path.join(sibling, 'packages', 'web'))).toBe(clone);
  });

  test('keeps a folder whose .git file is not a worktree pointer, and finds nothing outside a checkout', async () => {
    const { home } = await fixture();
    const submodule = path.join(home, 'parent', 'vendor', 'lib');
    await mkdir(submodule, { recursive: true });
    await writeFile(path.join(submodule, '.git'), 'gitdir: ../../.git/modules/vendor/lib\n');
    expect(resolveClaudeProjectRoot(submodule)).toBe(submodule);
    expect(resolveClaudeProjectRoot(path.join(home, 'scratch'))).toBeNull();
    expect(resolveClaudeProjectRoot('relative/folder')).toBeNull();
    expect(resolveClaudeProjectRoot(null)).toBeNull();
  });
});

describe('Claude project attribution', () => {
  test('attributes a session to the checkout it started in, whatever folder it ended in', async () => {
    const { home, run, rowFor, transcript } = await fixture();
    const clone = path.join(home, 'clone');
    await gitDirectory(clone);
    const worktree = path.join(home, 'clone-wt', 'codex');
    await linkedWorktree(clone, worktree, 'codex');
    const elsewhere = path.join(home, 'Downloads', 'notes');
    await transcript(
      'package-then-away.jsonl',
      user(0, path.join(clone, 'packages', 'app')),
      assistant(1, path.join(clone, 'packages', 'app')),
      user(2, elsewhere),
      assistant(3, elsewhere),
    );
    await transcript('worktree.jsonl', user(0, worktree), assistant(1, worktree));
    await transcript('inside-worktree/subagents/agent-child.jsonl', {
      ...assistant(1, path.join(clone, '.claude', 'worktrees', 'gone-worktree')),
      sessionId: 'inside-worktree',
      isSidechain: true,
    });
    const result = await run();
    const [packageRow] = rowFor(result.rows, 'package-then-away');
    expect(packageRow).toMatchObject({ project: 'clone', projectPath: elsewhere });
    expect(packageRow?.source?.sourcePath).toBe(elsewhere);
    expect(rowFor(result.rows, 'worktree')[0]).toMatchObject({ project: 'clone' });
    expect(rowFor(result.rows, 'agent-child')[0]).toMatchObject({ project: 'clone', subagent: true });
  });

  test('skips folders outside any checkout before the first checkout, and names the launch folder otherwise', async () => {
    const { home, run, rowFor, transcript } = await fixture();
    const clone = path.join(home, 'clone');
    await gitDirectory(clone);
    const scratch = path.join(home, '.config', 'Desktop', 'scratch-workspaces', 'scratch-2026-10-07');
    await transcript(
      'scratch-then-clone.jsonl',
      user(0, scratch),
      assistant(1, scratch),
      user(2, clone),
      assistant(3, clone),
    );
    await transcript('scratch-only.jsonl', user(0, scratch), assistant(1, scratch));
    await transcript('no-cwd.jsonl', { ...assistant(1, scratch), cwd: undefined });
    const result = await run();
    expect(rowFor(result.rows, 'scratch-then-clone')[0]).toMatchObject({ project: 'clone' });
    expect(rowFor(result.rows, 'scratch-only')[0]).toMatchObject({ project: 'scratch-2026-10-07' });
    expect(rowFor(result.rows, 'no-cwd')[0]).toMatchObject({ project: '' });
  });

  test('re-parses a cached transcript when the checkout enclosing its folders changes', async () => {
    const { home, reads, run, rowFor, transcript } = await fixture();
    const folder = path.join(home, 'work', 'notes');
    const other = await transcript(
      'other.jsonl',
      user(0, path.join(home, 'elsewhere')),
      assistant(1, path.join(home, 'elsewhere')),
    );
    const session = await transcript('session.jsonl', user(0, folder), assistant(1, folder));
    const cold = await run();
    expect(rowFor(cold.rows, 'session')[0]).toMatchObject({ project: 'notes' });
    reads.clear();
    expect(await run()).toEqual(cold);
    expect(reads.size).toBe(0);
    await gitDirectory(path.join(home, 'work'));
    const warm = await run();
    expect(rowFor(warm.rows, 'session')[0]).toMatchObject({ project: 'work' });
    expect(rowFor(warm.rows, 'other')).toEqual(rowFor(cold.rows, 'other'));
    expect(reads).toEqual(new Map([[session, 1]]));
    expect(reads.has(other)).toBe(false);
    reads.clear();
    expect(await run()).toEqual(warm);
    expect(reads.size).toBe(0);
  });
});

describe('Claude duplicate transcripts', () => {
  const copies = ['first-parent', 'second-parent'] as const;

  test.each([0, 1])(
    'keeps the most complete copy of a sub-agent transcript when the longer one is copy %i',
    async (longer) => {
      const { run, rowFor, transcript } = await fixture();
      for (const [index, parent] of copies.entries()) {
        const records = [user(0, '/clone'), assistant(1, '/clone', 100)];
        if (index === longer) {
          records.push(user(2, '/clone'), assistant(3, '/clone', 1000));
        }
        await transcript(
          `${parent}/subagents/agent-shared.jsonl`,
          ...records.map((record) => ({ ...record, sessionId: parent })),
        );
      }
      const result = await run();
      const rows = rowFor(result.rows, 'agent-shared');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ calls: 2, tokIn: 1100 });
      expect(rows[0]?.source?.parentSourceSessionId).toBe(copies[longer]);
      expect(result.warnings.map(({ operation }) => operation)).not.toContain('claude.lineage-conflict');
      expect(result.retiredSourceSessionIds).toEqual([]);
    },
  );

  test('keeps exactly one of two identical copies and one of two empty copies', async () => {
    const { run, rowFor, transcript } = await fixture();
    for (const parent of copies) {
      await transcript(`${parent}/subagents/agent-same.jsonl`, user(0, '/clone'), assistant(1, '/clone'));
      await transcript(`${parent}/subagents/agent-idle.jsonl`, ...housekeeping('agent-idle'));
    }
    const result = await run();
    expect(rowFor(result.rows, 'agent-same')).toHaveLength(1);
    expect(rowFor(result.rows, 'agent-idle')).toHaveLength(0);
    expect(result.retiredSourceSessionIds).toEqual(['agent-idle']);
    expect(result.warnings.map(({ operation }) => operation)).not.toContain('claude.lineage-conflict');
  });
});

describe('Claude retired sessions', () => {
  test('retires a cleanly parsed transcript without usage or prompt, on cold and warm scans', async () => {
    const { reads, run, rowFor, transcript } = await fixture();
    await transcript('idle.jsonl', ...housekeeping('idle'));
    await transcript('active.jsonl', user(0, '/clone'), assistant(1, '/clone'));
    const cold = await run();
    expect(cold.retiredSourceSessionIds).toEqual(['idle']);
    expect(rowFor(cold.rows, 'idle')).toHaveLength(0);
    reads.clear();
    const warm = await run();
    expect(reads.size).toBe(0);
    expect(warm.retiredSourceSessionIds).toEqual(['idle']);
  });

  test('never retires a transcript with a malformed or dropped line, an empty file, or a prompt-history session', async () => {
    const { home, run, rowFor, transcript } = await fixture();
    const malformed = path.join(home, '.claude', 'projects', 'fixture', 'malformed.jsonl');
    await writeFile(malformed, `${jsonl(...housekeeping('malformed'))}{"type":"assistant","message":`);
    await transcript('empty.jsonl');
    await writeFile(
      path.join(home, '.claude', 'history.jsonl'),
      jsonl({ sessionId: 'history-only', display: 'Build the report', timestamp: 1_750_000_000_000 }),
    );
    const result = await run();
    expect(result.retiredSourceSessionIds).toEqual([]);
    expect(rowFor(result.rows, 'history-only')).toHaveLength(1);
  });

  test('never retires a transcript it rejected: no timestamps, malformed usage, or a reply without usage', async () => {
    const { reads, run, rowFor, transcript } = await fixture();
    await transcript('bridge-only.jsonl', { type: 'bridge-session', sessionId: 'bridge-only' }, { type: 'mode' });
    await transcript('bad-usage.jsonl', {
      ...assistant(1, '/clone'),
      message: { ...assistant(1, '/clone').message, usage: { input_tokens: -1, output_tokens: 'many' } },
    });
    await transcript('no-usage.jsonl', {
      ...assistant(1, '/clone'),
      message: { id: 'message-1', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'Done' }] },
    });
    await transcript('idle.jsonl', ...housekeeping('idle'));
    const cold = await run();
    expect(cold.retiredSourceSessionIds).toEqual(['idle']);
    for (const sourceSessionId of ['bridge-only', 'bad-usage', 'no-usage']) {
      expect(rowFor(cold.rows, sourceSessionId)).toHaveLength(0);
    }
    expect(cold.warnings.filter(({ operation }) => operation === 'metricValidation')).toHaveLength(1);
    reads.clear();
    const warm = await run();
    expect(reads.size).toBe(0);
    expect(warm).toEqual(cold);
  });

  test('stops retiring a session once its transcript gains usage', async () => {
    const { run, rowFor, transcript } = await fixture();
    const filePath = await transcript('late.jsonl', ...housekeeping('late'));
    expect((await run()).retiredSourceSessionIds).toEqual(['late']);
    await writeFile(filePath, jsonl(...housekeeping('late'), user(1, '/clone'), assistant(2, '/clone')));
    const result = await run();
    expect(result.retiredSourceSessionIds).toEqual([]);
    expect(rowFor(result.rows, 'late')).toHaveLength(1);
  });
});
