import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonicalInstantFromDate } from '@ai-usage/report-core/canonical-instant';
import type { FocusedReportSupport } from '@ai-usage/report-core/focused-report-query';
import { sessionRowIdentity } from '@ai-usage/report-core/session-query';
import type { CollectedUsageRow } from '@ai-usage/report-core/types';
import {
  type CheckoutStatusObservation,
  type ClaudeDesktopSessionObservation,
  parseClaudeDesktopSessionObservation,
  WORK_ATTENTION_BOUNDS,
  type WorkRoot,
} from '@ai-usage/report-core/work-attention';
import {
  MAX_WORK_HARNESS_SESSION_FAMILIES,
  MAX_WORK_HARNESS_SESSION_MEMBERS,
  queryRecentServedHarnessSessions,
} from '@ai-usage/usage-store/reader';
import {
  importCheckoutStatusObservations,
  importClaudeDesktopSessions,
  initializeUsageStore,
  publishServedReportRevision,
  recordWorkFactRun,
  updateUsageMachineLabel,
} from '@ai-usage/usage-store/testing';
import { Effect } from 'effect';
import { assembleReport } from './report-assembly';
import {
  assembleWorkAttention,
  NO_EXTERNAL_FACTS,
  NO_SERVED_REVISION,
  queryWorkAttention,
  WORK_UNDECLARED_HARNESS,
} from './work-attention-read';
import { queryWorkContext } from './work-context-read';

/**
 * Codex sessions on the Work read (ADR 0059): the served revision's recent `codex` campaigns
 * become roots of their own whose attention is `not-observable`. They carry the checkout, branch,
 * activity and children Codex recorded, the checkout observation named by their exact path, and
 * never a request, a wait or a fold under a Desktop root, whatever they share with one.
 */

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const MACHINE = 'machine-work';
const SECOND_MACHINE = 'machine-two';
const NOW = new Date('2026-10-20T12:00:00.000Z');
const HOUR_MS = 3_600_000;
const dateBefore = (hours: number) => new Date(NOW.getTime() - hours * HOUR_MS);
const hoursAgo = (hours: number) => canonicalInstantFromDate(dateBefore(hours));
const PROJECT = '/home/fixture/work/project';
const OTHER_PROJECT = '/home/fixture/work/other';
const SHARED_BRANCH = 'fixture/topic';

const desktopSession = (spec: {
  readonly id: string;
  readonly lastActivityHoursAgo: number;
  readonly needsAction?: string;
  readonly status: 'blocked' | 'completed';
  readonly title: string;
}): ClaudeDesktopSessionObservation => {
  const lastActivityAt = hoursAgo(spec.lastActivityHoursAgo);
  const parsed = parseClaudeDesktopSessionObservation({
    accountDirectory: 'account',
    archived: false,
    branch: SHARED_BRANCH,
    cliSessionId: `cli-${spec.id}`,
    completedTurns: 1,
    createdAt: hoursAgo(spec.lastActivityHoursAgo + 1),
    cwd: PROJECT,
    declaredPullRequests: [],
    desktopSessionId: `local_${spec.id}`,
    effort: null,
    fileModifiedAt: lastActivityAt,
    filePath: `.config/Claude/claude-code-sessions/account/org/local_${spec.id}.json`,
    format: 'claude-desktop-session-v1',
    lastActivityAt,
    lastTurnReport: null,
    machineId: MACHINE,
    model: null,
    observedAt: NOW.toISOString(),
    openSuggestions: [],
    organizationDirectory: 'org',
    originCwd: PROJECT,
    priorCliSessionIds: [],
    resolvedSuggestions: {},
    sideSessionNotes: [],
    sourceBranch: null,
    spawnedFrom: null,
    title: spec.title,
    titleSource: 'auto',
    turnSummary: {
      detail: `Declared ${spec.status}.`,
      needsAction: spec.needsAction ?? null,
      status: spec.status,
      summarizesUuid: null,
    },
    unsupportedReason: null,
    worktreePath: null,
    wrapUpDescription: null,
    writtenBranches: [SHARED_BRANCH],
  });
  if (parsed === null) {
    throw new Error(`fixture desktop session ${spec.id} must satisfy the contract`);
  }
  return parsed;
};

const DESKTOP_SESSIONS = [
  desktopSession({
    id: 'blocked',
    lastActivityHoursAgo: 5,
    needsAction: 'Keep the reader or drop it?',
    status: 'blocked',
    title: 'Desktop: asks a question',
  }),
  // Same checkout, same branch and overlapping time as the Codex root: none of it folds the two.
  desktopSession({ id: 'done', lastActivityHoursAgo: 2, status: 'completed', title: 'Desktop: done here' }),
];

interface CodexRowSpec {
  readonly activeHoursAgo: number;
  readonly branch?: string;
  readonly cwd?: string;
  readonly id: string;
  readonly machineId?: string;
  readonly name: string;
  readonly origin?: 'classifier' | 'human' | 'subagent';
  readonly parent?: string;
  readonly reviewOf?: string;
}

const codexRow = (spec: CodexRowSpec): CollectedUsageRow => {
  const cwd = spec.cwd ?? PROJECT;
  const end = dateBefore(spec.activeHoursAgo);
  const machineId = spec.machineId ?? MACHINE;
  return {
    calls: 1,
    costActual: 0,
    costApprox: 0,
    costKnown: true,
    date: new Date(end.getTime() - 600_000),
    durationMs: 600_000,
    endDate: end,
    harness: 'Codex',
    linesAdded: null,
    linesDeleted: null,
    model: 'gpt-5.6-sol',
    name: spec.name,
    ...(spec.origin === undefined ? { originProvenance: 'origin-absent' as const } : { origin: spec.origin }),
    project: path.basename(cwd),
    provider: 'Codex sub',
    source: {
      harnessKey: 'codex',
      machineId,
      machineLabel: machineId === MACHINE ? 'Work Machine' : 'Second Machine',
      ...(spec.parent === undefined ? {} : { parentSourceSessionId: spec.parent }),
      ...(spec.reviewOf === undefined ? {} : { rootSourceSessionId: spec.reviewOf }),
      sourcePath: cwd,
      sourceSessionId: spec.id,
      ...(spec.branch === undefined
        ? {}
        : {
            vcs: {
              branches: [
                {
                  firstObservedAt: new Date(end.getTime() - 600_000).toISOString(),
                  lastObservedAt: new Date(end.getTime() - 600_000).toISOString(),
                  name: spec.branch,
                  provenance: 'harness-recorded' as const,
                  webUrl: null,
                },
              ],
              headCommit: null,
              partial: false,
              pullRequests: [],
              repository: null,
            },
          }),
    },
    subagent: spec.origin === 'subagent',
    titleSource: 'first-prompt',
    tokCr: 0,
    tokCw: 0,
    tokIn: 10,
    tokOut: 5,
    tools: 0,
    turns: 1,
  };
};

const CODEX_ROWS: readonly CodexRowSpec[] = [
  { activeHoursAgo: 2, branch: SHARED_BRANCH, id: 'codex-root', name: 'Codex: refactor the reader', origin: 'human' },
  { activeHoursAgo: 1, id: 'codex-child', name: 'Codex: delegated slice', origin: 'subagent', parent: 'codex-root' },
  {
    activeHoursAgo: 1.5,
    id: 'codex-review',
    name: 'Codex: automated review',
    origin: 'classifier',
    reviewOf: 'codex-root',
  },
  // Its declared parent was never collected: it stands as its own root, with the gap named.
  {
    activeHoursAgo: 3,
    cwd: OTHER_PROJECT,
    id: 'codex-orphan',
    name: 'Codex: orphaned delegate',
    origin: 'subagent',
    parent: 'codex-gone',
  },
  { activeHoursAgo: 40 * 24, id: 'codex-old', name: 'Codex: outside the window', origin: 'human' },
  {
    activeHoursAgo: 4,
    id: 'codex-elsewhere',
    machineId: SECOND_MACHINE,
    name: 'Codex: other machine',
    origin: 'human',
  },
];

const reportOptions = { limit: null, minTokens: 0, project: null, since: null, sort: 'date' as const };

const createStore = async (desktop: readonly ClaudeDesktopSessionObservation[] = DESKTOP_SESSIONS): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'work-attention-read-harness-'));
  temporaryRoots.push(root);
  const dbPath = path.join(root, 'usage-store.sqlite');
  await Effect.runPromise(initializeUsageStore({ dbPath }));
  if (desktop.length > 0) {
    await Effect.runPromise(
      importClaudeDesktopSessions({
        collectedAt: dateBefore(0.1),
        completeness: {
          filesParsed: desktop.length,
          filesSeen: desktop.length,
          rejected: 0,
          truncated: false,
          unsupported: 0,
        },
        dbPath,
        machineId: MACHINE,
        observations: desktop,
      }),
    );
  }
  return dbPath;
};

const publishCodexRows = async (dbPath: string, specs: readonly CodexRowSpec[]): Promise<void> => {
  for (const machine of [
    { id: MACHINE, label: 'Work Machine' },
    { id: SECOND_MACHINE, label: 'Second Machine' },
  ]) {
    await Effect.runPromise(updateUsageMachineLabel({ dbPath, machine }));
  }
  const { payload } = assembleReport({
    configuredProjectGroups: [],
    generatedAt: dateBefore(0.25),
    options: reportOptions,
    projectGroups: [],
    rows: specs.map(codexRow),
    timeZone: 'UTC',
    warnings: [],
  });
  const { rows, tableRows: _tableRows, ...support } = payload;
  await Effect.runPromise(
    publishServedReportRevision({
      assemble: () => ({
        configFingerprint: 'c'.repeat(64),
        generatedAt: payload.generatedAt,
        projectAliases: [],
        projectGroupConfigs: [],
        rows,
        sourceAuthorities: rows.map(() => 'local-observed' as const),
        support: support as FocusedReportSupport,
      }),
      dbPath,
      now: 1000,
      revision: 'revision-work-codex',
      ttlMs: 300_000,
    }),
  );
};

const dirtyCheckout = (checkoutPath: string): CheckoutStatusObservation => ({
  ahead: 0,
  behind: 0,
  branch: SHARED_BRANCH,
  checkoutPath,
  dirty: true,
  headSha: 'a'.repeat(40),
  lastCommitAt: hoursAgo(6),
  machineId: MACHINE,
  modifiedCount: 3,
  observedAt: hoursAgo(0.5),
  outcome: 'observed',
  stagedCount: 0,
  untrackedCount: 1,
  upstream: null,
});

const observeCheckout = async (dbPath: string): Promise<void> => {
  await Effect.runPromise(importCheckoutStatusObservations({ dbPath, observations: [dirtyCheckout(PROJECT)] }));
  await Effect.runPromise(
    recordWorkFactRun({
      dbPath,
      disabled: false,
      failed: 0,
      machineId: MACHINE,
      message: null,
      observed: 1,
      ranAt: dateBefore(0.5),
      sourceId: 'checkouts.status',
    }),
  );
};

const byTitle = (roots: readonly WorkRoot[], title: string): WorkRoot => {
  const found = roots.find((root) => root.title === title);
  if (found === undefined) {
    throw new Error(`no root titled ${title}`);
  }
  return found;
};

describe('Codex sessions on the Work read', () => {
  test('one root per served Codex campaign, unknown attention, never folded under a Desktop root', async () => {
    const dbPath = await createStore();
    await publishCodexRows(dbPath, CODEX_ROWS);
    await observeCheckout(dbPath);

    const dataset = await Effect.runPromise(queryWorkAttention({ dbPath, machineId: MACHINE, now: NOW }));

    // Desktop roots keep their places; Codex roots follow, most recently active first.
    expect(dataset.roots.map((root) => [root.key.harness, root.title, root.attention])).toEqual([
      ['claude', 'Desktop: asks a question', 'human-request'],
      ['claude', 'Desktop: done here', 'none'],
      ['codex', 'Codex: refactor the reader', 'not-observable'],
      ['codex', 'Codex: orphaned delegate', 'not-observable'],
    ]);
    // The 40-day-old family is outside the window and the other machine's is filtered out.
    expect(dataset.totalRoots).toBe(4);
    expect(dataset.truncated).toBe(false);

    const codex = byTitle(dataset.roots, 'Codex: refactor the reader');
    expect(codex.key).toEqual({ harness: WORK_UNDECLARED_HARNESS, machineId: MACHINE, sourceSessionId: 'codex-root' });
    expect(codex.desktopSessionId).toBeNull();
    expect(codex.declared).toBeNull();
    expect(codex.reconsidered).toBe(false);
    expect(codex.titleSource).toBe('unknown');
    expect(codex.project).toEqual({
      branch: SHARED_BRANCH,
      checkoutPath: PROJECT,
      label: 'project',
      servedLabel: 'project',
      worktreeName: null,
    });
    expect(codex.age.lastActivityAt).toBe(hoursAgo(2));
    expect(codex.age.declaredAt).toBeNull();
    // Its delegated child and its automated review fold under it through their declared links.
    expect(codex.children).toEqual({
      blocked: 0,
      completed: 0,
      count: 2,
      reviewReady: 0,
      titles: ['Codex: delegated slice', 'Codex: automated review'],
    });
    expect(codex.session?.rowId).toBeString();
    expect(codex.session?.campaignKey).toBeString();
    // The served row it is, by construction.
    expect(codex.session?.rowId).toBe(
      sessionRowIdentity(
        assembleReport({
          configuredProjectGroups: [],
          generatedAt: dateBefore(0.25),
          options: reportOptions,
          projectGroups: [],
          rows: CODEX_ROWS.map(codexRow),
          timeZone: 'UTC',
          warnings: [],
        }).payload.rows.find((row) => row.source?.sourceSessionId === 'codex-root') ??
          (() => {
            throw new Error('missing served Codex root');
          })(),
      ),
    );
    // What it says first: unknown, not "nothing pending"; then the checkout seen at its exact path.
    expect(codex.interpretations[0]).toMatchObject({
      evidence: [],
      kind: 'coverage-gap',
      text: 'Codex records no turn status: whether this session waits on you is unknown — not declared by this harness.',
    });
    const local = codex.interpretations.find((entry) => entry.kind === 'local-changes-unvalidated');
    // Both Desktop roots and the Codex root worked in that checkout.
    expect(local?.text).toContain('Checkout shared by 3 roots.');
    expect(codex.facts.map((fact) => [fact.kind, fact.provenance.source])).toEqual([
      ['checkout-status', 'local-checkout'],
    ]);
    expect(local?.evidence).toEqual(codex.facts.map((fact) => fact.id));

    // The Desktop root in the same checkout keeps its own family and learns the checkout is shared.
    const done = byTitle(dataset.roots, 'Desktop: done here');
    expect(done.children.count).toBe(0);
    expect(done.interpretations.find((entry) => entry.kind === 'local-changes-unvalidated')?.text).toContain(
      'Checkout shared by 3 roots.',
    );

    const orphan = byTitle(dataset.roots, 'Codex: orphaned delegate');
    expect(orphan.children.count).toBe(0);
    expect(orphan.facts).toEqual([]);
    expect(orphan.interpretations.map((entry) => entry.text)).toContain(
      'Started from a Codex session that is not in the served report; it stands as its own root.',
    );

    // The Desktop join keeps its own counts; the Codex roots are served Sessions by construction.
    expect(dataset.coverage.sessions).toEqual({ joined: 0, revision: 'revision-work-codex', unmatched: 2 });
    expect(dataset.coverage.window.excludedRoots).toBe(0);
  });

  test('no Codex root ever carries a request or a wait, whatever its checkout shows', async () => {
    const dbPath = await createStore([]);
    await publishCodexRows(dbPath, CODEX_ROWS);
    await observeCheckout(dbPath);

    const dataset = await Effect.runPromise(queryWorkAttention({ dbPath, now: NOW }));

    expect(dataset.roots.map((root) => [root.key.machineId, root.key.sourceSessionId])).toEqual([
      [MACHINE, 'codex-root'],
      [MACHINE, 'codex-orphan'],
      [SECOND_MACHINE, 'codex-elsewhere'],
    ]);
    expect(new Set(dataset.roots.map((root) => root.attention))).toEqual(new Set(['not-observable']));
    // With no Desktop session the revision still names where the Codex rows came from.
    expect(dataset.coverage.sessions).toEqual({ joined: 0, revision: 'revision-work-codex', unmatched: 0 });
  });

  test('the page limit cuts Codex roots before any Desktop root and counts them', async () => {
    const dbPath = await createStore();
    await publishCodexRows(dbPath, CODEX_ROWS);

    const dataset = await Effect.runPromise(queryWorkAttention({ dbPath, limit: 3, machineId: MACHINE, now: NOW }));

    expect(dataset.roots.map((root) => root.key.harness)).toEqual(['claude', 'claude', 'codex']);
    expect(dataset.totalRoots).toBe(4);
    expect(dataset.truncated).toBe(true);
  });

  test('Codex roots have their own budget: the most recent first, never crowding Desktop roots, counted', async () => {
    const dbPath = await createStore();
    const families = WORK_ATTENTION_BOUNDS.maxCodexRoots + 10;
    await publishCodexRows(
      dbPath,
      Array.from({ length: families }, (_value, index) => ({
        activeHoursAgo: 1 + index,
        id: `codex-${String(index).padStart(3, '0')}`,
        name: `Codex family ${String(index)}`,
        origin: 'human' as const,
      })),
    );

    const dataset = await Effect.runPromise(queryWorkAttention({ dbPath, limit: 100, machineId: MACHINE, now: NOW }));

    const codex = dataset.roots.filter((root) => root.key.harness === 'codex');
    expect(codex).toHaveLength(WORK_ATTENTION_BOUNDS.maxCodexRoots);
    expect(codex[0]?.key.sourceSessionId).toBe('codex-000');
    expect(dataset.roots.slice(0, 2).map((root) => root.key.harness)).toEqual(['claude', 'claude']);
    expect(dataset.coverage.codexSessions).toEqual({
      campaignsInWindow: families,
      campaignsRead: WORK_ATTENTION_BOUNDS.maxCodexRoots,
    });
    expect(dataset.totalRoots).toBe(2 + families);
    expect(dataset.truncated).toBe(true);
  });

  test('no served revision, no Codex root', async () => {
    const dbPath = await createStore();

    const dataset = await Effect.runPromise(queryWorkAttention({ dbPath, machineId: MACHINE, now: NOW }));

    expect(dataset.roots.map((root) => root.key.harness)).toEqual(['claude', 'claude']);
    expect(dataset.coverage.sessions.revision).toBeNull();
  });

  test('reads one page of the most recent families and counts the rest', async () => {
    const dbPath = await createStore([]);
    const families = 5;
    const page = 3;
    await publishCodexRows(
      dbPath,
      Array.from({ length: families }, (_value, index) => ({
        activeHoursAgo: 1 + index,
        id: `codex-${String(index).padStart(3, '0')}`,
        name: `Codex family ${String(index)}`,
        origin: 'human' as const,
      })),
    );

    const read = await Effect.runPromise(
      queryRecentServedHarnessSessions({
        activeSince: NOW.getTime() - 30 * 24 * HOUR_MS,
        dbPath,
        harnessKey: 'codex',
        limit: page,
      }),
    );
    expect(read.families).toHaveLength(page);
    expect(read.familiesInWindow).toBe(families);
    expect(read.families[0]?.members[0]?.sourceSessionId).toBe('codex-000');
    expect(read.refusedRows).toBe(0);

    // The Work read asks for one page of families: one beyond it could never rank into the page.
    const dataset = await Effect.runPromise(queryWorkAttention({ dbPath, limit: page, now: NOW }));
    expect(dataset.roots.map((root) => root.key.sourceSessionId)).toEqual(['codex-000', 'codex-001', 'codex-002']);
    expect(dataset.totalRoots).toBe(families);
    expect(dataset.truncated).toBe(true);
  });

  test('reads a family root and its latest members only, and counts every member', async () => {
    const dbPath = await createStore([]);
    const children = MAX_WORK_HARNESS_SESSION_MEMBERS + 3;
    await publishCodexRows(dbPath, [
      { activeHoursAgo: 10, id: 'codex-wide', name: 'Codex: wide family', origin: 'human' },
      ...Array.from({ length: children }, (_value, index) => ({
        activeHoursAgo: 1 + index / 10,
        id: `codex-wide-child-${String(index)}`,
        name: `Child ${String(index)}`,
        origin: 'subagent' as const,
        parent: 'codex-wide',
      })),
    ]);

    const read = await Effect.runPromise(
      queryRecentServedHarnessSessions({ activeSince: NOW.getTime() - 24 * HOUR_MS, dbPath, harnessKey: 'codex' }),
    );
    expect(read.families).toHaveLength(1);
    const family = read.families[0];
    expect(family?.memberCount).toBe(children + 1);
    expect(family?.members).toHaveLength(MAX_WORK_HARNESS_SESSION_MEMBERS + 1);
    expect(family?.members[0]).toMatchObject({ campaignRoot: true, sourceSessionId: 'codex-wide' });
    expect(family?.members.slice(1).map((member) => member.title)).toEqual([
      'Child 0',
      'Child 1',
      'Child 2',
      'Child 3',
      'Child 4',
    ]);

    const dataset = await Effect.runPromise(queryWorkAttention({ dbPath, now: NOW }));
    expect(dataset.roots[0]?.children).toMatchObject({
      count: children,
      titles: ['Child 0', 'Child 1', 'Child 2', 'Child 3', 'Child 4'],
    });
  });

  test('rejects a family read out of its bounds as invalid input', async () => {
    const dbPath = await createStore([]);
    const result = await Effect.runPromise(
      Effect.either(
        queryRecentServedHarnessSessions({
          activeSince: 0,
          dbPath,
          harnessKey: 'codex',
          limit: MAX_WORK_HARNESS_SESSION_FAMILIES + 1,
        }),
      ),
    );
    expect(result._tag).toBe('Left');
  });
});

describe('assembleWorkAttention with harness sessions', () => {
  const family = (id: string, machineId: string, activeHoursAgo: number) => ({
    campaignKey: `campaign-${id}`,
    lastActiveAt: dateBefore(activeHoursAgo).getTime(),
    memberCount: 1,
    members: [
      {
        activeAt: dateBefore(activeHoursAgo).getTime(),
        branch: null,
        campaignRoot: true,
        checkoutPath: null,
        machineId,
        origin: null,
        parentSourceSessionId: null,
        projectLabel: '(unknown)',
        rowId: `row-${id}`,
        sourceSessionId: id,
        startedAt: null,
        title: 'x'.repeat(300),
      },
    ],
  });

  test('keeps the machine filter, clamps served text visibly and labels an unknown checkout by the report', () => {
    const dataset = assembleWorkAttention({
      collectionStates: [],
      externalFacts: NO_EXTERNAL_FACTS,
      harnessSessions: {
        families: [family('kept', MACHINE, 1), family('other', SECOND_MACHINE, 2)],
        familiesInWindow: 2,
        generatedAt: dateBefore(0.25).toISOString(),
        harness: WORK_UNDECLARED_HARNESS,
        refusedRows: 0,
        revision: 'revision-x',
      },
      machineId: MACHINE,
      now: NOW,
      observations: [],
      sessions: NO_SERVED_REVISION,
    });

    expect(dataset.roots.map((root) => root.key.sourceSessionId)).toEqual(['kept']);
    const [root] = dataset.roots;
    expect(root?.title).toHaveLength(256);
    expect(root?.title.endsWith('…')).toBe(true);
    expect(root?.project.label).toBe('(unknown)');
    expect(root?.project.checkoutPath).toBeNull();
    expect(root?.age.lastObservedAt).toBe(hoursAgo(0.25));
    expect(dataset.coverage.sessions.revision).toBe('revision-x');
  });
});

describe('Codex context scope before family bounds', () => {
  test('retrieves an old project behind unrelated campaigns without increasing the default budget', async () => {
    const dbPath = await createStore([]);
    await publishCodexRows(dbPath, [
      ...Array.from(
        { length: WORK_ATTENTION_BOUNDS.maxCodexRoots + 10 },
        (_, index): CodexRowSpec => ({
          id: `other-${index}`,
          name: `Other ${index}`,
          cwd: OTHER_PROJECT,
          activeHoursAgo: 1,
          origin: 'human',
        }),
      ),
      {
        id: 'old-investigation',
        name: 'Existing investigation with a result',
        cwd: PROJECT,
        activeHoursAgo: 120 * 24,
        origin: 'human',
      },
    ]);
    const scope = { checkoutPath: PROJECT, kind: 'checkout' as const };
    const recent = await Effect.runPromise(queryWorkContext({ dbPath, now: NOW, scope }));
    expect(recent.sessions).toEqual([]);
    const context = await Effect.runPromise(queryWorkContext({ dbPath, now: NOW, scope, sinceDays: 180 }));
    expect(context.sessions.map(({ root }) => root.key.sourceSessionId)).toEqual(['old-investigation']);
    expect(context.sessions[0]?.session?.rowId).toBeString();
    expect(context.coverage.harnesses.codex).toMatchObject({ campaignsInWindow: 1, campaignsRead: 1, inScope: 1 });
    expect(context.truncation.dataset).toBe(false);
  });

  test('keeps the native root when an explicitly scoped child is older than the member preview', async () => {
    const dbPath = await createStore([]);
    const worktree = '/fixture/explicit-linked-worktree';
    await publishCodexRows(dbPath, [
      { id: 'native-root', name: 'Native investigation root', cwd: PROJECT, activeHoursAgo: 2, origin: 'human' },
      ...Array.from(
        { length: 8 },
        (_, index): CodexRowSpec => ({
          id: `native-child-${index}`,
          name: `Child ${index}`,
          cwd: OTHER_PROJECT,
          activeHoursAgo: 1,
          origin: 'subagent',
          parent: 'native-root',
        }),
      ),
      {
        id: 'scoped-child',
        name: 'Existing scoped analysis',
        cwd: worktree,
        activeHoursAgo: 3,
        origin: 'subagent',
        parent: 'native-root',
      },
      {
        id: 'unrelated',
        name: 'Unrelated sibling path',
        cwd: `${worktree}-sibling`,
        activeHoursAgo: 1,
        origin: 'human',
      },
    ]);
    const context = await Effect.runPromise(
      queryWorkContext({ dbPath, now: NOW, scope: { kind: 'checkouts', checkoutPaths: [worktree] } }),
    );
    expect(context.sessions.map(({ root }) => root.key.sourceSessionId)).toEqual(['native-root']);
    expect(context.sessions[0]?.root.project.checkoutPath).toBe(PROJECT);
    expect(context.coverage.roots).toMatchObject({ inScope: 1, read: 1, total: 1 });
    expect(context.truncated).toBe(false);
    const scoped = await Effect.runPromise(
      queryRecentServedHarnessSessions({
        dbPath,
        harnessKey: 'codex',
        activeSince: NOW.getTime() - 86_400_000,
        scope: { kind: 'checkouts', checkoutPaths: [worktree] },
      }),
    );
    expect(scoped.families[0]?.memberCount).toBe(10);
    expect(scoped.families[0]?.members.some((member) => member.sourceSessionId === 'scoped-child')).toBe(false);
  });
});
