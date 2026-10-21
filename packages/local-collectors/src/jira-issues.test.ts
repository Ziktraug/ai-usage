import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  BOUNDED_PROCESS_INHERITED_PREFIXES,
  BOUNDED_PROCESS_INHERITED_VARIABLES,
  type BoundedProcessRunner,
  runBoundedProcess,
} from '@ai-usage/local-machine/bounded-process';
import { parseCanonicalInstant } from '@ai-usage/report-core/canonical-instant';
import { Effect } from 'effect';
import { httpStatusOf, observeJiraIssues, parseJiraIssueView, personLabel } from './jira-issues';

const NOW = new Date('2026-10-21T21:00:00.000Z');
const STDERR_SENTINEL = 'PRIVATE_FAKE_ACLI_STDERR_SENTINEL';
const EMAIL_SENTINEL = 'private.person@example.invalid';
const fixturePath = path.join(import.meta.dir, 'test-fixtures', 'fake-acli.ts');
const temporaryRoots: string[] = [];

afterAll(() => {
  for (const root of temporaryRoots) {
    rmSync(root, { force: true, recursive: true });
  }
});

interface FakeCall {
  args: string[];
  environment: string[];
}

interface FakeAcli {
  readonly calls: () => FakeCall[];
  readonly run: BoundedProcessRunner;
}

/** Installs the fake `acli` on a private PATH that also carries the Bun executable for its shebang. */
const installFakeAcli = (scenario: unknown, install = true): FakeAcli => {
  const binDirectory = mkdtempSync(path.join(tmpdir(), 'ai-usage-fake-acli-'));
  temporaryRoots.push(binDirectory);
  if (install) {
    const acliPath = path.join(binDirectory, 'acli');
    copyFileSync(fixturePath, acliPath);
    chmodSync(acliPath, 0o700);
  }
  writeFileSync(path.join(binDirectory, 'scenario.json'), JSON.stringify(scenario));
  const searchPath = [binDirectory, path.dirname(process.execPath)].join(path.delimiter);
  return {
    calls: () => {
      const logPath = path.join(binDirectory, 'calls.jsonl');
      if (!existsSync(logPath)) {
        return [];
      }
      return readFileSync(logPath, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as FakeCall);
    },
    run: (options) => runBoundedProcess({ ...options, env: { ...options.env, PATH: searchPath } }),
  };
};

/** The assumed REST-shaped body: `fields` nesting, ADF comment bodies, colon-less offsets. */
const view = (key: string, overrides: Record<string, unknown> = {}, fields: Record<string, unknown> = {}) =>
  JSON.stringify({
    expand: 'renderedFields',
    fields: {
      assignee: { accountId: 'acc-1', displayName: 'Alex', emailAddress: EMAIL_SENTINEL },
      comment: {
        comments: [
          {
            author: { displayName: 'Sam', emailAddress: EMAIL_SENTINEL },
            body: 'Older comment.',
            created: '2026-10-20T10:00:00.000+0200',
            id: '10001',
          },
          {
            author: { emailAddress: EMAIL_SENTINEL },
            body: {
              content: [
                { content: [{ text: 'Looks fine,', type: 'text' }], type: 'paragraph' },
                {
                  content: [
                    { text: 'one question for ', type: 'text' },
                    { attrs: { id: 'acc-1', text: '@Alex' }, type: 'mention' },
                  ],
                  type: 'paragraph',
                },
              ],
              type: 'doc',
              version: 1,
            },
            created: '2026-10-21T18:30:00.000+0200',
            id: '10002',
          },
        ],
        maxResults: 50,
        total: 2,
      },
      customfield_10020: 'ignored',
      parent: { key: 'XLB-2000' },
      sprint: [{ name: 'Sprint 41' }, { name: 'Sprint 42' }],
      status: { name: 'In Progress', statusCategory: { key: 'indeterminate', name: 'In Progress' } },
      summary: 'Promo badge',
      updated: '2026-10-21T18:30:00.000+0200',
      ...fields,
    },
    id: '10200',
    key,
    ...overrides,
  });

const observe = (fake: FakeAcli, options: Partial<Parameters<typeof observeJiraIssues>[0]> = {}) =>
  Effect.runPromise(
    observeJiraIssues({
      keys: ['XLB-2090'],
      machineId: 'machine-a',
      now: () => NOW,
      run: fake.run,
      timeoutMs: 5000,
      ...options,
    }),
  );

describe('personLabel', () => {
  test('keeps a display name, keeps only the local part of an address, and falls back to someone', () => {
    expect(personLabel({ displayName: 'Alex', emailAddress: EMAIL_SENTINEL })).toBe('Alex');
    expect(personLabel({ emailAddress: EMAIL_SENTINEL })).toBe('private.person');
    expect(personLabel('sam@example.invalid')).toBe('sam');
    expect(personLabel('@example.invalid')).toBe('someone');
    expect(personLabel(null)).toBe('someone');
    expect(personLabel('x'.repeat(80))).toHaveLength(64);
  });
});

describe('parseJiraIssueView', () => {
  test('maps the assumed shape, ignores unknown keys, keeps the newest comments first without addresses', () => {
    const parsed = parseJiraIssueView(view('XLB-2090'), 'XLB-2090');
    expect(parsed).toEqual({
      assigneeLabel: 'Alex',
      commentCount: 2,
      comments: [
        {
          authorLabel: 'private.person',
          createdAt: parseCanonicalInstant('2026-10-21T16:30:00.000Z'),
          excerpt: 'Looks fine, one question for @Alex',
          id: '10002',
        },
        {
          authorLabel: 'Sam',
          createdAt: parseCanonicalInstant('2026-10-20T08:00:00.000Z'),
          excerpt: 'Older comment.',
          id: '10001',
        },
      ],
      parentKey: 'XLB-2000',
      sprint: 'Sprint 42',
      status: 'In Progress',
      statusCategory: 'in-progress',
      summary: 'Promo badge',
      updatedAt: parseCanonicalInstant('2026-10-21T16:30:00.000Z'),
    });
    expect(JSON.stringify(parsed)).not.toContain(EMAIL_SENTINEL);
  });
  test('accepts a flat shape and absent families, and maps the three status categories', () => {
    expect(
      parseJiraIssueView(JSON.stringify({ status: { name: 'Done', statusCategory: { key: 'done' } } }), 'XLB-1'),
    ).toMatchObject({
      commentCount: null,
      comments: [],
      parentKey: null,
      sprint: null,
      status: 'Done',
      statusCategory: 'done',
      summary: null,
      updatedAt: null,
    });
    expect(
      parseJiraIssueView(JSON.stringify({ status: { name: 'Backlog', statusCategory: { name: 'To Do' } } }), 'XLB-1')
        ?.statusCategory,
    ).toBe('todo');
    expect(parseJiraIssueView(JSON.stringify({ status: 'Weird' }), 'XLB-1')?.statusCategory).toBe('unknown');
  });
  test('refuses another key, mistyped used fields and unreadable bodies', () => {
    expect(parseJiraIssueView(view('XLB-2091'), 'XLB-2090')).toBeNull();
    expect(parseJiraIssueView(view('XLB-2090', {}, { summary: 42 }), 'XLB-2090')).toBeNull();
    expect(parseJiraIssueView(view('XLB-2090', {}, { status: { statusCategory: {} } }), 'XLB-2090')).toBeNull();
    expect(parseJiraIssueView(view('XLB-2090', {}, { updated: 'yesterday' }), 'XLB-2090')).toBeNull();
    expect(
      parseJiraIssueView(view('XLB-2090', {}, { comment: { comments: [{ body: 'no date' }] } }), 'XLB-2090'),
    ).toBeNull();
    expect(parseJiraIssueView('not json', 'XLB-2090')).toBeNull();
    expect(parseJiraIssueView('[]', 'XLB-2090')).toBeNull();
  });
  test('bounds the excerpt and the kept comments', () => {
    const comments = Array.from({ length: 14 }, (_value, index) => ({
      author: 'Sam',
      body: 'y'.repeat(600),
      created: `2026-10-${String(index + 1).padStart(2, '0')}T10:00:00.000Z`,
      id: index,
    }));
    const parsed = parseJiraIssueView(view('XLB-2090', {}, { comment: { comments, total: 14 } }), 'XLB-2090');
    expect(parsed?.commentCount).toBe(14);
    expect(parsed?.comments).toHaveLength(10);
    expect(parsed?.comments[0]?.id).toBe('13');
    expect(parsed?.comments[0]?.excerpt).toHaveLength(280);
  });
});

describe('httpStatusOf', () => {
  test('reads a status at the top level or under error/response, as a number or a numeric string', () => {
    expect(httpStatusOf({ status: 401 })).toBe(401);
    expect(httpStatusOf({ error: { statusCode: '404' } })).toBe(404);
    expect(httpStatusOf({ response: { code: 403 } })).toBe(403);
    expect(httpStatusOf({ message: 'boom' })).toBeNull();
    expect(httpStatusOf({ status: 'unauthorized' })).toBeNull();
  });
});

describe('observeJiraIssues through a fake acli on PATH', () => {
  test('observes issues with the assumed command, deduplicates keys, rejects placeholders and bounds the batch', async () => {
    const fake = installFakeAcli({
      issues: { 'XLB-2090': { stdout: view('XLB-2090') }, 'XLB-2091': { stdout: view('XLB-2091') } },
    });
    const batch = await observe(fake, {
      keys: ['XLB-2090', 'xlb-2090 ', 'XLB-0', 'not-a-key', '2090', 'XLB-2091', 'XLB-2092'],
      maxKeys: 2,
    });
    expect(batch.rejected).toBe(3);
    expect(batch.truncated).toBe(true);
    expect(batch.observations.map(({ key, outcome }) => [key, outcome])).toEqual([
      ['XLB-2090', 'observed'],
      ['XLB-2091', 'observed'],
    ]);
    expect(batch.observations[0]).toMatchObject({
      assigneeLabel: 'Alex',
      commentCount: 2,
      machineId: 'machine-a',
      observedAt: '2026-10-21T21:00:00.000Z',
      outcomeMessage: null,
      status: 'In Progress',
      statusCategory: 'in-progress',
    });
    expect(fake.calls().map(({ args }) => args)).toEqual([
      ['jira', 'workitem', 'view', 'XLB-2090', '--json'],
      ['jira', 'workitem', 'view', 'XLB-2091', '--json'],
    ]);
    const serialized = JSON.stringify(batch);
    expect(serialized).not.toContain(STDERR_SENTINEL);
    expect(serialized).not.toContain(EMAIL_SENTINEL);
  });

  test('classifies 401/403 as unauthenticated and halts, 404 as not found, other bodies as network', async () => {
    const forbidden = installFakeAcli({
      issues: {
        'XLB-1': { exitCode: 1, stdout: JSON.stringify({ errorMessages: ['Forbidden'], status: 403 }) },
        'XLB-2': { stdout: view('XLB-2') },
      },
    });
    const halted = await observe(forbidden, { keys: ['XLB-1', 'XLB-2'] });
    expect(halted.observations.map(({ outcome, outcomeMessage }) => [outcome, outcomeMessage])).toEqual([
      ['unauthenticated', 'Jira rejected the credentials (HTTP 403); sign in to Jira (acli jira auth login)'],
      [
        'unauthenticated',
        'not attempted: Jira rejected the credentials (HTTP 403); sign in to Jira (acli jira auth login)',
      ],
    ]);
    expect(forbidden.calls()).toHaveLength(1);

    const mixed = installFakeAcli({
      issues: {
        'XLB-1': { exitCode: 1, stdout: JSON.stringify({ error: { status: '401' } }) },
      },
    });
    expect((await observe(mixed, { keys: ['XLB-1'] })).observations[0]?.outcome).toBe('unauthenticated');

    const notFound = installFakeAcli({
      issues: {
        'XLB-1': { exitCode: 1, stdout: JSON.stringify({ errorMessages: ['Issue does not exist'], status: 404 }) },
        'XLB-2': { exitCode: 2, stdout: JSON.stringify({ status: 500 }) },
        'XLB-3': { exitCode: 1, stdout: 'plain text error' },
        'XLB-4': { stdout: view('XLB-4') },
      },
    });
    const perKey = await observe(notFound, { keys: ['XLB-1', 'XLB-2', 'XLB-3', 'XLB-4'] });
    expect(perKey.observations.map(({ outcome }) => outcome)).toEqual(['not-found', 'network', 'invalid', 'observed']);
    expect(perKey.observations[1]?.outcomeMessage).toBe('Jira returned HTTP 500');
  });

  test('a silent failure is network and halts the run; a timeout halts it too', async () => {
    const silent = installFakeAcli({ issues: { 'XLB-1': { exitCode: 1 }, 'XLB-2': { stdout: view('XLB-2') } } });
    const offline = await observe(silent, { keys: ['XLB-1', 'XLB-2'] });
    expect(offline.observations.map(({ outcome }) => outcome)).toEqual(['network', 'network']);
    expect(offline.observations[0]?.outcomeMessage).toContain('without output');
    expect(silent.calls()).toHaveLength(1);

    const slow = installFakeAcli({
      issues: { 'XLB-1': { delayMs: 2000, stdout: view('XLB-1') }, 'XLB-2': { stdout: view('XLB-2') } },
    });
    const timedOut = await observe(slow, { keys: ['XLB-1', 'XLB-2'], timeoutMs: 150 });
    expect(timedOut.observations.map(({ outcome }) => outcome)).toEqual(['timeout', 'timeout']);
    expect(slow.calls()).toHaveLength(1);
  });

  test('a missing acli records every key as disabled after one lookup', async () => {
    const absent = installFakeAcli({}, false);
    const batch = await observe(absent, { keys: ['XLB-1', 'XLB-2'] });
    expect(batch.observations.map(({ outcome, outcomeMessage }) => [outcome, outcomeMessage])).toEqual([
      ['disabled', 'acli not installed'],
      ['disabled', 'not attempted: acli not installed'],
    ]);
    expect(absent.calls()).toEqual([]);
  });

  test('an unexpected success body or another key is invalid, not a fact', async () => {
    const fake = installFakeAcli({
      issues: { 'XLB-1': { stdout: 'ok' }, 'XLB-2': { stdout: view('XLB-9') } },
    });
    const batch = await observe(fake, { keys: ['XLB-1', 'XLB-2'] });
    expect(batch.observations.map(({ outcome }) => outcome)).toEqual(['invalid', 'invalid']);
    expect(batch.observations.every(({ status, comments }) => status === null && comments.length === 0)).toBe(true);
  });

  test('acli receives only the allow-listed environment: no token variable reaches it', async () => {
    const fake = installFakeAcli({ issues: { 'XLB-1': { stdout: view('XLB-1') } } });
    const previous = process.env.JIRA_API_TOKEN;
    process.env.JIRA_API_TOKEN = 'PRIVATE_JIRA_TOKEN_SENTINEL_0042';
    try {
      await observe(fake, { keys: ['XLB-1'] });
    } finally {
      if (previous === undefined) {
        delete process.env.JIRA_API_TOKEN;
      } else {
        process.env.JIRA_API_TOKEN = previous;
      }
    }
    const [call] = fake.calls();
    expect(call).toBeDefined();
    const allowed = (name: string) =>
      BOUNDED_PROCESS_INHERITED_VARIABLES.includes(name) ||
      BOUNDED_PROCESS_INHERITED_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
      ['CI', 'NO_COLOR', 'PAGER'].includes(name) ||
      // Bun adds its own runtime markers to any child it starts.
      name.startsWith('BUN_') ||
      name === '_';
    expect(call?.environment.filter((name) => !allowed(name))).toEqual([]);
    expect(call?.environment).not.toContain('JIRA_API_TOKEN');
  });
});
