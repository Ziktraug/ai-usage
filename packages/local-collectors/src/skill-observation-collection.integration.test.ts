import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalHistoryStorage, LocalHistoryStorage } from '@ai-usage/local-machine/local-history';
import { FIXTURE_SKILL_NAMES, seedHarnessHome } from '@ai-usage/local-machine/testing/harness-home';
import { Effect } from 'effect';
import { collectSelectedHarnessResults } from './collectors';

const temporaryHomes: string[] = [];

afterEach(async () => {
  for (const home of temporaryHomes.splice(0)) {
    await rm(home, { force: true, recursive: true });
  }
});

const makeHome = async (): Promise<string> => {
  const home = await mkdtemp(join(tmpdir(), 'ai-usage-skill-observations-'));
  temporaryHomes.push(home);
  return home;
};

const jsonl = (...events: readonly unknown[]) => `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;

const CLAUDE_SESSION = 'claude-skill-fixture-099';
const CODEX_SESSION = 'codex-skill-fixture-099';
const OPENCODE_SESSION = 'opencode-skill-fixture-099';

/** A transcript that invokes one managed skill and one harness-bundled skill. */
const seedClaude = async (home: string): Promise<void> => {
  const dir = join(home, '.claude', 'projects', '-home-alex-Projects-report');
  await mkdir(dir, { recursive: true });
  const cwd = '/home/alex/Projects/report';
  await writeFile(
    join(dir, `${CLAUDE_SESSION}.jsonl`),
    jsonl(
      {
        cwd,
        message: { content: [{ text: 'audit the release', type: 'text' }], role: 'user' },
        sessionId: CLAUDE_SESSION,
        timestamp: '2026-08-01T09:00:00.000Z',
        type: 'user',
        uuid: 'user-1',
      },
      {
        cwd,
        message: {
          content: [
            { id: 'toolu_managed', input: { args: 'pre-release', skill: 'improve' }, name: 'Skill', type: 'tool_use' },
          ],
          id: 'message-1',
          model: 'claude-sonnet-4-6',
          role: 'assistant',
          usage: { cache_read_input_tokens: 3, input_tokens: 10, output_tokens: 4 },
        },
        parentUuid: 'user-1',
        requestId: 'request-1',
        sessionId: CLAUDE_SESSION,
        timestamp: '2026-08-01T09:01:00.000Z',
        type: 'assistant',
        uuid: 'assistant-1',
      },
      {
        cwd,
        message: {
          content: [{ content: 'Launching skill', tool_use_id: 'toolu_managed', type: 'tool_result' }],
          role: 'user',
        },
        sessionId: CLAUDE_SESSION,
        timestamp: '2026-08-01T09:01:01.000Z',
        toolUseResult: { commandName: 'improve', success: true },
        type: 'user',
        uuid: 'result-1',
      },
      {
        cwd,
        isMeta: true,
        message: {
          content: [{ text: 'Base directory for this skill: /home/alex/.claude/skills/improve', type: 'text' }],
          role: 'user',
        },
        sessionId: CLAUDE_SESSION,
        sourceToolUseID: 'toolu_managed',
        timestamp: '2026-08-01T09:01:02.000Z',
        type: 'user',
        uuid: 'meta-1',
      },
      {
        cwd,
        message: {
          content: [{ id: 'toolu_bundled', input: { skill: 'artifact-design' }, name: 'Skill', type: 'tool_use' }],
          id: 'message-2',
          model: 'claude-sonnet-4-6',
          role: 'assistant',
          usage: { input_tokens: 5, output_tokens: 2 },
        },
        parentUuid: 'user-1',
        requestId: 'request-2',
        sessionId: CLAUDE_SESSION,
        timestamp: '2026-08-01T09:02:00.000Z',
        type: 'assistant',
        uuid: 'assistant-2',
      },
    ),
  );
};

/** A rollout carrying both a catalogue (exposed) and an exec read (inferred). */
const seedCodex = async (home: string): Promise<void> => {
  const dir = join(home, '.codex', 'sessions', '2026', '08', '01');
  await mkdir(dir, { recursive: true });
  const catalogue = [
    'You have skills.',
    '### Available skills',
    '- pr-review: Review a pull request end to end. (file: /home/alex/.agents/skills/pr-review/SKILL.md)',
    '- imagegen: Generate images. (file: /home/alex/.codex/skills/.system/imagegen/SKILL.md)',
  ].join('\n');
  await writeFile(
    join(dir, `rollout-2026-08-01T09-00-00-${CODEX_SESSION}.jsonl`),
    jsonl(
      {
        payload: {
          cwd: '/home/alex/Projects/report',
          id: CODEX_SESSION,
          originator: 'codex_cli_rs',
          timestamp: '2026-08-01T09:00:00.000Z',
        },
        timestamp: '2026-08-01T09:00:00.000Z',
        type: 'session_meta',
      },
      // Key order matches a real rollout: Codex writes type/id/role before the
      // (very large) content, which is what keeps "role":"developer" inside the
      // 300-byte prefix the parser gates on.
      {
        payload: {
          type: 'message',
          id: 'msg_developer_1',
          role: 'developer',
          content: [{ type: 'input_text', text: catalogue }],
        },
        timestamp: '2026-08-01T09:00:01.000Z',
        type: 'response_item',
      },
      {
        payload: {
          type: 'message',
          id: 'msg_user_1',
          role: 'user',
          content: [{ type: 'input_text', text: 'review the pr' }],
        },
        timestamp: '2026-08-01T09:00:02.000Z',
        type: 'response_item',
      },
      {
        payload: {
          call_id: 'call_exec_1',
          input: "sed -n '1,240p' /home/alex/.agents/skills/pr-review/SKILL.md",
          name: 'exec',
          type: 'custom_tool_call',
        },
        timestamp: '2026-08-01T09:00:03.000Z',
        type: 'response_item',
      },
      {
        payload: {
          info: {
            total_token_usage: {
              cached_input_tokens: 3,
              input_tokens: 20,
              output_tokens: 8,
              reasoning_output_tokens: 0,
            },
          },
          type: 'token_count',
        },
        timestamp: '2026-08-01T09:00:04.000Z',
        type: 'event_msg',
      },
    ),
  );
};

/** One resolvable skill part and one whose directory the harness did not record. */
const seedOpenCode = async (home: string): Promise<void> => {
  const dir = join(home, '.local', 'share', 'opencode');
  await mkdir(dir, { recursive: true });
  const db = new Database(join(dir, 'opencode.db'), { create: true });
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, directory TEXT,
      summary_additions INTEGER, summary_deletions INTEGER
    );
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part (
      id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT,
      time_created INTEGER, time_updated INTEGER, data TEXT
    );
  `);
  db.query('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)').run(
    OPENCODE_SESSION,
    null,
    'Skill session',
    '/home/alex/Projects/report',
    0,
    0,
  );
  db.query('INSERT INTO message VALUES (?, ?, ?, ?)').run(
    'msg-1',
    OPENCODE_SESSION,
    1_771_069_566_000,
    JSON.stringify({
      cost: 0.01,
      id: 'msg-1',
      modelID: 'gpt-5',
      providerID: 'openai',
      role: 'assistant',
      time: { completed: 1_771_069_567_000, created: 1_771_069_566_000 },
      tokens: { cache: { read: 3, write: 1 }, input: 10, output: 4, reasoning: 0 },
    }),
  );
  const part = (id: string, data: unknown, at: number) =>
    db
      .query('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, 'msg-1', OPENCODE_SESSION, at, at, JSON.stringify(data));
  part(
    'part-resolved',
    {
      callID: 'call_resolved',
      state: {
        input: { name: 'web-design-guidelines' },
        metadata: { dir: '/home/alex/Projects/report/.agents/skills/web-design-guidelines' },
        status: 'completed',
        time: { end: 1_771_069_566_100, start: 1_771_069_566_050 },
      },
      tool: 'skill',
      type: 'tool',
    },
    1_771_069_566_050,
  );
  part(
    'part-unresolved',
    {
      callID: 'call_unresolved',
      state: { input: { name: 'deleted-skill' }, status: 'completed' },
      tool: 'skill',
      type: 'tool',
    },
    1_771_069_566_200,
  );
  part(
    'part-other-tool',
    { callID: 'call_bash', state: { input: {}, status: 'completed' }, tool: 'bash', type: 'tool' },
    1_771_069_566_300,
  );
  db.close(true);
};

interface CountingStorage {
  counts: { openDatabase: number; readLines: number };
  storage: LocalHistoryStorage;
}

/**
 * Counts the reads that actually parse local history. A cache hit must leave
 * both counters at zero; a directory walk or a stat does not parse and is not
 * counted.
 */
const countingStorage = (home: string): CountingStorage => {
  const inner = createLocalHistoryStorage(home);
  const counts = { openDatabase: 0, readLines: 0 };
  return {
    counts,
    storage: {
      ...inner,
      openDatabase: (dbPath) => {
        counts.openDatabase += 1;
        return inner.openDatabase(dbPath);
      },
      readLines: (filePath, visit, limits) => {
        counts.readLines += 1;
        return inner.readLines(filePath, visit, limits);
      },
    },
  };
};

const collectAtHome = (storage: LocalHistoryStorage) =>
  Effect.runPromise(
    collectSelectedHarnessResults({ harness: null, includeCursor: false }).pipe(
      Effect.provideService(LocalHistoryStorage, storage),
    ),
  );

describe('skill observation collection', () => {
  test('collects declared, inferred, and exposed observations from one synthetic home', async () => {
    const home = await makeHome();
    await seedClaude(home);
    await seedCodex(home);
    await seedOpenCode(home);

    const result = await collectAtHome(createLocalHistoryStorage(home));
    const byHarness = new Map(result.harnesses.map((harness) => [harness.harness, harness.observations]));

    const claude = byHarness.get('claude') ?? [];
    expect(claude.map(({ skillName }) => skillName).sort()).toEqual(['artifact-design', 'improve']);
    expect(claude.every(({ tier }) => tier === 'declared')).toBe(true);
    // The bundled skill resolves to nothing. That is a state, not a drop.
    expect(claude.find(({ skillName }) => skillName === 'artifact-design')?.resolvedPath).toBeNull();
    expect(claude.find(({ skillName }) => skillName === 'improve')?.resolvedPath).toBe(
      '/home/alex/.claude/skills/improve',
    );
    // The argument text was 'pre-release'; only its presence may survive.
    expect(JSON.stringify(claude)).not.toContain('pre-release');
    expect(claude.find(({ skillName }) => skillName === 'improve')?.argsPresent).toBe(true);

    const opencode = byHarness.get('opencode') ?? [];
    expect(opencode.map(({ skillName }) => skillName).sort()).toEqual(['deleted-skill', 'web-design-guidelines']);
    expect(opencode.every(({ tier }) => tier === 'declared')).toBe(true);
    expect(opencode.find(({ skillName }) => skillName === 'deleted-skill')?.resolvedPath).toBeNull();

    const codex = byHarness.get('codex') ?? [];
    const exposed = codex.filter(({ tier }) => tier === 'exposed');
    const inferred = codex.filter(({ tier }) => tier === 'inferred');
    expect(exposed.map(({ skillName }) => skillName).sort()).toEqual(['imagegen', 'pr-review']);
    expect(inferred.map(({ skillName }) => skillName)).toEqual(['pr-review']);
    // pr-review is both offered and read. The two facts stay separate.
    expect(codex.filter(({ skillName }) => skillName === 'pr-review')).toHaveLength(2);

    expect(result.observations).toHaveLength(claude.length + opencode.length + codex.length);
  });

  test('a harness with no skill signal reports an empty observation list rather than failing', async () => {
    const home = await makeHome();
    await seedOpenCode(home);

    const result = await collectAtHome(createLocalHistoryStorage(home));
    const claude = result.harnesses.find((harness) => harness.harness === 'claude');

    expect(claude?.observations).toEqual([]);
    expect(result.observations.length).toBeGreaterThan(0);
  });

  test('Cursor reports as not observable rather than as a harness that observed nothing', async () => {
    const home = await makeHome();
    await seedClaude(home);
    await seedOpenCode(home);

    const result = await Effect.runPromise(
      collectSelectedHarnessResults({ harness: null, includeCursor: true }).pipe(
        Effect.provideService(LocalHistoryStorage, createLocalHistoryStorage(home)),
      ),
    );
    const cursor = result.harnesses.find((harness) => harness.harness === 'cursor');
    const codex = result.harnesses.find((harness) => harness.harness === 'codex');

    // Codex has a collector and this home has no Codex history, so it genuinely
    // observed nothing. Cursor cannot observe at all. Both carry an empty list,
    // and the marker is the only thing that tells them apart (ADR 0022).
    expect(cursor?.observations).toEqual([]);
    expect(codex?.observations).toEqual([]);
    expect(cursor?.observability).toBe('not-observable');
    expect(codex?.observability).toBe('observable');
    expect(cursor?.observability).not.toBe(codex?.observability);
  });

  test('the shared synthetic home yields every tier, and Cursor stays not observable', async () => {
    const home = await makeHome();
    await seedHarnessHome(home, { harnesses: ['claude', 'codex', 'cursor', 'opencode'], skillSignals: true });

    const result = await Effect.runPromise(
      collectSelectedHarnessResults({ harness: null, includeCursor: true }).pipe(
        Effect.provideService(LocalHistoryStorage, createLocalHistoryStorage(home)),
      ),
    );
    const observability = new Map(result.harnesses.map((harness) => [harness.harness, harness.observability]));
    const tiers = new Map<string, Set<string>>();
    for (const harness of result.harnesses) {
      tiers.set(harness.harness, new Set(harness.observations.map(({ tier }) => tier)));
    }
    const names = (harness: string) =>
      new Set(result.harnesses.find((entry) => entry.harness === harness)?.observations.map((o) => o.skillName) ?? []);

    expect(tiers.get('claude')).toEqual(new Set(['declared']));
    expect(tiers.get('opencode')).toEqual(new Set(['declared']));
    expect(tiers.get('codex')).toEqual(new Set(['exposed', 'inferred']));
    expect(names('claude')).toEqual(
      new Set([FIXTURE_SKILL_NAMES.claudeDeclared, FIXTURE_SKILL_NAMES.claudeUnresolved]),
    );
    expect(names('opencode')).toEqual(new Set([FIXTURE_SKILL_NAMES.openCodeDeclared]));
    expect(names('codex')).toEqual(new Set([FIXTURE_SKILL_NAMES.codexExposed, FIXTURE_SKILL_NAMES.codexUnread]));

    expect(observability.get('cursor')).toBe('not-observable');
    expect(result.harnesses.find((harness) => harness.harness === 'cursor')?.observations).toEqual([]);

    // The bundled Claude skill and the unread Codex skill are the two states the
    // surface exists to show: invoked-but-unmanaged, and offered-but-unused.
    const claude = result.harnesses.find((harness) => harness.harness === 'claude')?.observations ?? [];
    expect(claude.find(({ skillName }) => skillName === FIXTURE_SKILL_NAMES.claudeUnresolved)?.resolvedPath).toBeNull();
    const codex = result.harnesses.find((harness) => harness.harness === 'codex')?.observations ?? [];
    expect(codex.filter(({ skillName }) => skillName === FIXTURE_SKILL_NAMES.codexUnread).map((o) => o.tier)).toEqual([
      'exposed',
    ]);
  });

  test('a second collection pass reuses the cache and re-parses nothing', async () => {
    const home = await makeHome();
    await seedClaude(home);
    await seedCodex(home);
    await seedOpenCode(home);

    const first = countingStorage(home);
    const firstResult = await collectAtHome(first.storage);
    expect(first.counts.readLines).toBeGreaterThan(0);
    expect(first.counts.openDatabase).toBeGreaterThan(0);

    const second = countingStorage(home);
    const secondResult = await collectAtHome(second.storage);

    // The whole point of carrying observations inside the existing cache
    // entries: a warm re-scan must not re-read a single transcript.
    expect(second.counts.readLines).toBe(0);
    expect(second.counts.openDatabase).toBe(0);
    expect(secondResult.observations).toEqual(firstResult.observations);
    expect(secondResult.observations.length).toBeGreaterThan(0);
  });
});
