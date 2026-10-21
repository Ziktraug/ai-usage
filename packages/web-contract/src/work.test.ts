import { describe, expect, test } from 'bun:test';
import { safeParse } from 'valibot';
import {
  parseWorkAttentionOutput,
  type WorkAttentionDatasetWire,
  type WorkRootWire,
  workAttentionInputSchema,
  workAttentionOutputSchema,
  workContract,
} from './work';

const AT = '2026-10-20T12:00:00.000Z';

const root = (overrides: Partial<WorkRootWire> = {}): WorkRootWire => ({
  age: { createdAt: AT, declaredAt: AT, lastActivityAt: AT, lastObservedAt: AT },
  archived: false,
  attention: 'human-request',
  children: { blocked: 0, completed: 1, count: 2, reviewReady: 1, titles: ['Enquête', 'Fixture: child'] },
  declared: { at: AT, detail: 'Stopped on a question.', needsAction: 'Decide.', status: 'blocked' },
  desktopSessionId: 'local_root',
  facts: [
    {
      declaredAt: AT,
      desktopSessionId: 'local_root',
      detail: 'Stopped on a question.',
      id: 'local_root:declared-turn',
      kind: 'declared-turn',
      needsAction: 'Decide.',
      provenance: { coverage: 'complete', machineId: 'machine-a', observedAt: AT, source: 'claude-desktop' },
      status: 'blocked',
    },
    {
      branch: 'fixture/pr',
      host: 'github.com',
      id: 'local_child:pr:github.com/fixture/project#117',
      kind: 'declared-pull-request',
      number: 117,
      provenance: { coverage: 'complete', machineId: 'machine-a', observedAt: AT, source: 'claude-desktop' },
      repository: 'fixture/project',
      state: 'OPEN',
      url: null,
    },
    {
      commentCount: 3,
      id: 'local_root:jira:XLB-2090@2026-10-20T12:00:00.000Z',
      key: 'XLB-2090',
      kind: 'jira-issue',
      newCommentsSince: 1,
      newestCommentAt: AT,
      outcome: 'observed',
      provenance: { coverage: 'complete', machineId: 'machine-a', observedAt: AT, source: 'jira' },
      status: 'In Progress',
      statusCategory: 'in-progress',
      updatedAt: AT,
      url: null,
    },
    {
      createdAt: null,
      id: 'local_root:proposal:task_1',
      kind: 'proposal',
      provenance: { coverage: 'complete', machineId: 'machine-a', observedAt: AT, source: 'claude-desktop' },
      resolution: 'dismissed',
      suggestionId: 'task_1',
      title: 'task_1',
      tldr: null,
    },
  ],
  interpretations: [
    {
      evidence: ['local_root:declared-turn'],
      kind: 'request-open',
      text: 'The session stopped on a question: Decide.',
      uncertainty: 'This is the session’s own last declaration.',
    },
  ],
  key: { harness: 'claude', machineId: 'machine-a', sourceSessionId: 'cli-root' },
  project: {
    branch: 'fixture/branch',
    checkoutPath: '/home/fixture/work/project',
    label: 'project',
    worktreeName: null,
  },
  session: { campaignKey: null, rowId: 'row-1' },
  title: 'Fixture: root',
  titleSource: 'auto',
  ...overrides,
});

const dataset = (roots: readonly WorkRootWire[] = [root()]): WorkAttentionDatasetWire => ({
  coverage: {
    checkouts: { failed: 0, lastRunAt: null, observed: 0 },
    desktopSessions: {
      collectedAt: AT,
      filesParsed: 3,
      filesSeen: 4,
      refusedRows: 0,
      truncated: false,
      unsupported: 1,
    },
    jira: { disabled: true, failed: 0, lastRunAt: AT, observed: 0, reason: 'acli not installed' },
    pullRequests: { disabled: true, failed: 0, lastRunAt: null, observed: 0 },
    sessions: { joined: 1, revision: 'revision-1', unmatched: 0 },
  },
  generatedAt: AT,
  machineId: 'machine-a',
  roots: [...roots],
  totalRoots: roots.length,
  truncated: false,
});

describe('Work contract', () => {
  test('declares one POST procedure', () => {
    expect(workContract.attention['~orpc'].route).toEqual({ method: 'POST', path: '/work/attention' });
  });

  test('accepts the exact dataset envelope and both failure tags', () => {
    const ok = { data: dataset(), ok: true as const };
    expect(parseWorkAttentionOutput(ok)).toEqual(ok);
    for (const tag of ['ForbiddenDemo', 'IncompatibleStore', 'Unavailable'] as const) {
      const failure = { error: { message: 'Work attention is unavailable.', tag }, ok: false as const };
      expect(parseWorkAttentionOutput(failure)).toEqual(failure);
    }
    expect(safeParse(workAttentionOutputSchema, { error: { message: 'x', tag: 'Conflict' }, ok: false }).success).toBe(
      false,
    );
    expect(
      safeParse(workAttentionOutputSchema, { error: { message: '', tag: 'Unavailable' }, ok: false }).success,
    ).toBe(false);
  });

  test('refuses unknown keys, non-canonical instants and out-of-bound collections', () => {
    const accepts = (value: unknown) => safeParse(workAttentionOutputSchema, { data: value, ok: true }).success;
    expect(accepts(dataset())).toBe(true);
    expect(accepts({ ...dataset(), extra: 1 })).toBe(false);
    expect(accepts(dataset([root({ generatedAt: AT } as never)]))).toBe(false);
    expect(accepts({ ...dataset(), generatedAt: '2026-10-20T12:00:00Z' })).toBe(false);
    expect(accepts(dataset([root({ age: { ...root().age, declaredAt: 'yesterday' } })]))).toBe(false);
    const fact = root().facts[0];
    if (fact === undefined) {
      throw new Error('fixture root must carry a fact');
    }
    expect(accepts(dataset([root({ facts: Array.from({ length: 65 }, () => fact) })]))).toBe(false);
    expect(accepts(dataset([root({ facts: Array.from({ length: 64 }, () => fact) })]))).toBe(true);
    expect(accepts(dataset(Array.from({ length: 201 }, () => root())))).toBe(false);
    expect(accepts(dataset([root({ children: { ...root().children, titles: ['a', 'b', 'c', 'd', 'e', 'f'] } })]))).toBe(
      false,
    );
    expect(accepts(dataset([root({ title: 't'.repeat(257) })]))).toBe(false);
    expect(accepts(dataset([root({ declared: { ...root().declared!, needsAction: 'n'.repeat(513) } })]))).toBe(false);
    expect(accepts(dataset([root({ attention: 'urgent' as never })]))).toBe(false);
    expect(
      accepts(
        dataset([root({ facts: [{ ...fact, kind: 'declared-turn', prompt: 'leak' } as unknown as typeof fact] })]),
      ),
    ).toBe(false);
  });

  test('a Jira fact needs an issue key, a known outcome and a null url; coverage needs its jira section', () => {
    const accepts = (value: unknown) => safeParse(workAttentionOutputSchema, { data: value, ok: true }).success;
    const jira = root().facts.find((fact) => fact.kind === 'jira-issue');
    if (jira === undefined || jira.kind !== 'jira-issue') {
      throw new Error('fixture root must carry a Jira fact');
    }
    expect(accepts(dataset([root({ facts: [{ ...jira, key: 'xlb-2090' }] })]))).toBe(false);
    expect(accepts(dataset([root({ facts: [{ ...jira, outcome: 'ok' as never }] })]))).toBe(false);
    expect(accepts(dataset([root({ facts: [{ ...jira, statusCategory: 'open' as never }] })]))).toBe(false);
    expect(accepts(dataset([root({ facts: [{ ...jira, url: 'https://example.atlassian.net' as never }] })]))).toBe(
      false,
    );
    expect(accepts(dataset([root({ facts: [{ ...jira, newCommentsSince: -1 }] })]))).toBe(false);
    const { jira: _jira, ...withoutJira } = dataset().coverage;
    expect(accepts({ ...dataset(), coverage: withoutJira })).toBe(false);
  });

  test('bounds the input and refuses unknown fields', () => {
    expect(safeParse(workAttentionInputSchema, {}).success).toBe(true);
    expect(safeParse(workAttentionInputSchema, { limit: 200, machineId: null }).success).toBe(true);
    expect(safeParse(workAttentionInputSchema, { limit: 1, machineId: 'machine-a' }).success).toBe(true);
    expect(safeParse(workAttentionInputSchema, { limit: 0 }).success).toBe(false);
    expect(safeParse(workAttentionInputSchema, { limit: 201 }).success).toBe(false);
    expect(safeParse(workAttentionInputSchema, { limit: 1.5 }).success).toBe(false);
    expect(safeParse(workAttentionInputSchema, { machineId: '' }).success).toBe(false);
    expect(safeParse(workAttentionInputSchema, { sinceDays: 30 }).success).toBe(false);
  });
});
