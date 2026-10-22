import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonicalInstantFromDate } from '@ai-usage/report-core/canonical-instant';
import {
  CLAUDE_DESKTOP_FIXTURE_PROMPT_SENTINEL,
  type ClaudeDesktopFixtureDocument,
  claudeDesktopFixtureRegistry,
} from '@ai-usage/report-core/test-fixtures/claude-desktop-sessions';
import {
  type CheckoutStatusObservation,
  type ClaudeDesktopSessionObservation,
  type PullRequestObservation,
  WORK_ATTENTION_BOUNDS,
} from '@ai-usage/report-core/work-attention';
import { parseClaudeDesktopSessionFile } from '@ai-usage/report-core/work-attention-native';
import {
  importCheckoutStatusObservations,
  importClaudeDesktopSessions,
  importPullRequestObservations,
  initializeUsageStore,
  recordWorkFactRun,
} from '@ai-usage/usage-store/testing';
import { Effect } from 'effect';
import { assembleWorkAttention, NO_EXTERNAL_FACTS, NO_SERVED_REVISION } from './work-attention-read';
import {
  projectWorkContext,
  queryWorkContext,
  readWorkContext,
  WORK_CONTEXT_BOUNDS,
  WORK_CONTEXT_COVERAGE_NOTES,
  WORK_CONTEXT_DECISION_KINDS,
  type WorkContextDataset,
} from './work-context-read';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const MACHINE = 'machine-work-context';
const OTHER_MACHINE = 'machine-work-context-other';
const EPOCH = new Date('2026-10-20T12:00:00.000Z');
const REPOSITORY = '/fixture/home/work/fixture';
/** A sibling whose path shares the repository's prefix: it is another checkout, never inside it. */
const OTHER_REPOSITORY = '/fixture/home/work/fixture-elsewhere';
const SHARED_WORKTREE = `${REPOSITORY}/.claude/worktrees/checkout-3`;
const hoursBefore = (hours: number) => canonicalInstantFromDate(new Date(EPOCH.getTime() - hours * 3_600_000));

const registryOf = (repository: string, variant: 'minimal' | 'representative') =>
  claudeDesktopFixtureRegistry({
    cliSessionIdWithTranscript: 'cli-fixture-transcript',
    epoch: EPOCH,
    repository,
    variant,
  });

const parse = (entry: ClaudeDesktopFixtureDocument, machineId: string): ClaudeDesktopSessionObservation | null => {
  const result = parseClaudeDesktopSessionFile(entry.document, {
    accountDirectory: entry.account,
    fileModifiedAt: entry.modifiedAt.toISOString(),
    machineId,
    observedAt: entry.modifiedAt.toISOString(),
    organizationDirectory: entry.organization,
    relativeFilePath: `.config/Claude/claude-code-sessions/${entry.account}/${entry.organization}/${entry.fileName}`,
  });
  return result.kind === 'observation' ? result.observation : null;
};

/** One sweep of the registry as the collector would normalize it, imported the way the engine does. */
const sweep = async (
  dbPath: string,
  machineId: string,
  documents: readonly ClaudeDesktopFixtureDocument[],
  at: Date,
): Promise<void> => {
  const observations = documents.flatMap((entry) => {
    const observation = parse(entry, machineId);
    return observation === null ? [] : [observation];
  });
  await Effect.runPromise(
    importClaudeDesktopSessions({
      collectedAt: at,
      completeness: {
        filesParsed: observations.length,
        filesSeen: documents.length,
        rejected: 0,
        truncated: false,
        unsupported: documents.length - observations.length,
      },
      dbPath,
      machineId,
      observations,
    }),
  );
};

const pullRequestObservation = (number: number, overrides: Partial<PullRequestObservation> = {}) =>
  ({
    accountLabel: null,
    baseRef: 'fixture-main',
    checksRollup: 'pending',
    draft: false,
    headRef: `fixture/pr-${String(number)}`,
    host: 'github.com',
    machineId: MACHINE,
    mergedAt: null,
    number,
    observedAt: hoursBefore(2),
    outcome: 'observed',
    outcomeMessage: null,
    repository: 'fixture/ai-usage',
    reviewDecision: null,
    state: 'OPEN',
    title: `Fixture pull request ${String(number)}`,
    updatedAt: hoursBefore(3),
    url: `https://github.com/fixture/ai-usage/pull/${String(number)}`,
    ...overrides,
  }) satisfies PullRequestObservation;

const dirtyWorktree: CheckoutStatusObservation = {
  ahead: 1,
  behind: 0,
  branch: 'fixture/checkout-3',
  checkoutPath: SHARED_WORKTREE,
  dirty: true,
  headSha: 'e'.repeat(40),
  lastCommitAt: hoursBefore(5),
  machineId: MACHINE,
  modifiedCount: 2,
  observedAt: hoursBefore(0.5),
  outcome: 'observed',
  stagedCount: 0,
  untrackedCount: 1,
  upstream: null,
};

/**
 * The representative registry (two sweeps, so earlier questions are recorded, ADR 0056) on one
 * machine, a minimal registry of another project on a second machine, one GitHub observation of
 * a declared pull request, one checkout status, and the two producers' run states.
 */
const createStore = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'work-context-read-'));
  temporaryRoots.push(root);
  const dbPath = path.join(root, 'usage-store.sqlite');
  await Effect.runPromise(initializeUsageStore({ dbPath }));
  const registry = registryOf(REPOSITORY, 'representative');
  await sweep(dbPath, MACHINE, registry.history, new Date(EPOCH.getTime() - 2.4 * 3_600_000));
  await sweep(dbPath, MACHINE, registry.documents, EPOCH);
  await sweep(dbPath, OTHER_MACHINE, registryOf(OTHER_REPOSITORY, 'minimal').documents, EPOCH);
  await Effect.runPromise(importPullRequestObservations({ dbPath, observations: [pullRequestObservation(118)] }));
  await Effect.runPromise(importCheckoutStatusObservations({ dbPath, observations: [dirtyWorktree] }));
  for (const sourceId of ['github.pull-requests', 'checkouts.status'] as const) {
    await Effect.runPromise(
      recordWorkFactRun({
        dbPath,
        disabled: false,
        failed: 0,
        machineId: MACHINE,
        message: null,
        observed: 1,
        ranAt: hoursBefore(0.5),
        sourceId,
      }),
    );
  }
  return dbPath;
};

const read = async (dbPath: string, scope: Parameters<typeof queryWorkContext>[0]['scope']) =>
  await Effect.runPromise(queryWorkContext({ dbPath, now: EPOCH, scope }));

const titles = (items: readonly { readonly root: { readonly title: string } }[]) => items.map(({ root }) => root.title);

describe('queryWorkContext', () => {
  test('answers what waits, what was decided and what is linked for one checkout, with coverage', async () => {
    const dbPath = await createStore();
    const context = await read(dbPath, { checkoutPath: REPOSITORY, kind: 'checkout' });

    expect(context.schemaVersion).toBe(1);
    expect(context.generatedAt).toBe(canonicalInstantFromDate(EPOCH));
    expect(context.scope).toEqual({ checkoutPath: REPOSITORY, kind: 'checkout', match: 'same-or-inside' });
    // The other project's roots are read but out of scope; the stale request is kept at any age.
    expect(context.coverage.roots.inScope).toBeLessThan(context.coverage.roots.read);
    expect(context.waiting.every(({ root }) => root.project.label === 'fixture')).toBe(true);
    expect(titles(context.waiting)).toContain('Fixture: stale declaration');
    expect(titles(context.waiting)).not.toContain('Fixture: export column wording');

    // A current request carries its own declaration, dated, with the registry file as provenance.
    const blocked = context.waiting.find(({ root }) => root.title === 'Fixture: investigate checkout 3');
    expect(blocked?.attention).toBe('human-request');
    expect(blocked?.declared?.needsAction).toBe('Confirm whether the fixture should keep checkout 3 or delete it.');
    expect(blocked?.declaredProvenance).toMatchObject({ machineId: MACHINE, source: 'claude-desktop' });
    expect(blocked?.readings[0]?.kind).toBe('request-open');
    expect(blocked?.root.project.checkoutPath).toBe(SHARED_WORKTREE);
    // An open pull request GitHub shows awaiting review is an external wait; an open proposal is
    // an optional lead and never listed as waiting.
    const shipping = context.waiting.find(({ root }) => root.title === 'Fixture: ship the collector');
    expect(shipping?.attention).toBe('external-wait');
    expect(shipping?.readings.map(({ kind }) => kind)).toContain('external-review-pending');
    expect(titles(context.waiting)).not.toContain('Fixture: proposals pending');
    expect(context.waiting.map(({ attention }) => attention as string)).not.toContain('optional-lead');

    // Settled decisions: an answered earlier question with dated evidence, an answered request,
    // a request handled in a session started from it. None of them is listed as waiting.
    const kinds = new Set(context.decisions.map(({ kind }) => kind));
    expect(kinds.has('earlier-request-answered')).toBe(true);
    expect(kinds.has('request-answered')).toBe(true);
    expect(kinds.has('request-handled-elsewhere')).toBe(true);
    expect(
      context.decisions.every(({ kind }) => (WORK_CONTEXT_DECISION_KINDS as readonly string[]).includes(kind)),
    ).toBe(true);
    const earlier = context.decisions.find(({ kind }) => kind === 'earlier-request-answered');
    expect(earlier?.root.title).toBe('Fixture: settle the layout');
    expect(earlier?.text).toContain('Keep the compact layout or the airy one?');
    expect(earlier?.evidence.length).toBeGreaterThan(0);
    expect(earlier?.evidence.every(({ kind, provenance }) => kind !== null && provenance !== null)).toBe(true);
    expect(earlier?.evidence.map(({ at }) => at)).toContain(hoursBefore(5));
    const sortedActivity = context.decisions.map(({ root }) => root.title);
    expect(sortedActivity.indexOf('Fixture: export column wording')).toBeLessThan(
      sortedActivity.indexOf('Fixture: settle the layout'),
    );
    for (const wait of context.waiting) {
      expect(wait.readings.some(({ kind }) => (WORK_CONTEXT_DECISION_KINDS as readonly string[]).includes(kind))).toBe(
        false,
      );
    }

    // Linked facts: the observed pull request and its declarations, the dirty worktree, newest first.
    const observed = context.linked.pullRequests.find(({ fact }) => fact.kind === 'pull-request');
    expect(observed?.fact).toMatchObject({ number: 118, outcome: 'observed', state: 'OPEN' });
    expect(observed?.roots).toEqual(['local_fixture-completed-root']);
    const declaredNumbers = context.linked.pullRequests
      .filter(({ fact }) => fact.kind === 'declared-pull-request')
      .map(({ fact }) => fact.number);
    expect(new Set(declaredNumbers)).toEqual(new Set([90, 117, 118, 131]));
    expect(context.linked.checkouts).toHaveLength(1);
    expect(context.linked.checkouts[0]?.fact).toMatchObject({ checkoutPath: SHARED_WORKTREE, dirty: true });
    expect(context.linked.checkouts[0]?.roots.length).toBeGreaterThan(1);
    expect(context.linked.jiraIssues).toEqual([]);

    // Coverage says what was scanned and what is out of scope.
    expect(context.coverage.notes).toEqual(WORK_CONTEXT_COVERAGE_NOTES);
    expect(context.coverage.notes.map(({ code }) => code)).toContain('claude-desktop-only');
    expect(context.coverage.attention.pullRequests).toMatchObject({ lastRunAt: hoursBefore(0.5), observed: 1 });
    expect(context.coverage.attention.desktopSessions.sessionsStored).toBeGreaterThan(0);
    expect(context.coverage.attention.window.sinceDays).toBe(30);
    expect(context.truncated).toBe(false);
    expect(context.truncation).toEqual({
      bytes: false,
      dataset: false,
      omitted: { checkouts: 0, decisions: 0, jiraIssues: 0, pullRequests: 0, waits: 0 },
    });

    // Bounded and private: within the byte ceiling; no proposal brief, report or note text copied.
    const encoded = JSON.stringify(context);
    expect(new TextEncoder().encode(encoded).byteLength).toBeLessThanOrEqual(WORK_CONTEXT_BOUNDS.maxOutputBytes);
    expect(encoded).not.toContain(CLAUDE_DESKTOP_FIXTURE_PROMPT_SENTINEL);
    expect(encoded).not.toContain('Fixture child report');
    // Proposals are cited by id and date only, never by title (ADR 0058).
    for (const proposalTitle of [
      'Fixture: offer before your message',
      'Fixture: expired offer',
      'Fixture: latest offer',
    ]) {
      expect(encoded).not.toContain(proposalTitle);
    }
    expect(encoded).not.toContain(OTHER_REPOSITORY);
  });

  test('a worktree path scopes to the roots that worked in it, a sibling path to nothing', async () => {
    const dbPath = await createStore();
    const worktree = await read(dbPath, { checkoutPath: `${SHARED_WORKTREE}/`, kind: 'checkout' });
    expect(worktree.scope).toMatchObject({ checkoutPath: SHARED_WORKTREE });
    expect(worktree.coverage.roots.inScope).toBeGreaterThan(0);
    expect(titles(worktree.waiting)).toContain('Fixture: investigate checkout 3');
    expect(titles(worktree.waiting)).not.toContain('Fixture: collector branch awaiting a pull request');

    // `fixture-other` shares a prefix with `fixture` but is not inside it.
    const sibling = await read(dbPath, { checkoutPath: `${REPOSITORY}-other`, kind: 'checkout' });
    expect(sibling.coverage.roots.inScope).toBe(0);
    expect(sibling.waiting).toEqual([]);
    expect(sibling.decisions).toEqual([]);
    expect(sibling.linked).toEqual({ checkouts: [], jiraIssues: [], pullRequests: [] });
    expect(sibling.coverage.notes).toEqual(WORK_CONTEXT_COVERAGE_NOTES);
  });

  test('a project label matches the project directory name exactly, worktrees included', async () => {
    const dbPath = await createStore();
    const byLabel = await read(dbPath, { kind: 'project-label', projectLabel: 'fixture' });
    const byCheckout = await read(dbPath, { checkoutPath: REPOSITORY, kind: 'checkout' });
    expect(byLabel.scope).toEqual({ kind: 'project-label', match: 'exact', projectLabel: 'fixture' });
    expect(titles(byLabel.waiting)).toEqual(titles(byCheckout.waiting));
    expect(byLabel.decisions.length).toBe(byCheckout.decisions.length);

    const other = await read(dbPath, { kind: 'project-label', projectLabel: 'fixture-elsewhere' });
    expect(titles(other.waiting)).toEqual(['Fixture: investigate checkout 3']);
    expect(other.waiting[0]?.root.key.machineId).toBe(OTHER_MACHINE);
    expect((await read(dbPath, { kind: 'project-label', projectLabel: 'fix' })).coverage.roots.inScope).toBe(0);
  });

  test('refuses a relative path or a label that is a path, as invalid input', async () => {
    const dbPath = await createStore();
    for (const scope of [
      { checkoutPath: 'work/fixture', kind: 'checkout' as const },
      { checkoutPath: '', kind: 'checkout' as const },
      { kind: 'project-label' as const, projectLabel: '   ' },
      { kind: 'project-label' as const, projectLabel: 'work/fixture' },
    ]) {
      const result = await Effect.runPromise(Effect.either(queryWorkContext({ dbPath, now: EPOCH, scope })));
      expect(result._tag).toBe('Left');
      if (result._tag === 'Left') {
        expect(result.left.reason).toBe('invalid-input');
      }
    }
  });
});

describe('readWorkContext', () => {
  test('returns the dataset, or a typed path-free failure for a missing store and an invalid scope', async () => {
    const dbPath = await createStore();
    const success = await readWorkContext({
      dbPath,
      now: EPOCH,
      scope: { checkoutPath: REPOSITORY, kind: 'checkout' },
    });
    expect(success.kind).toBe('success');

    const missingPath = path.join(path.dirname(dbPath), 'never-created', 'usage-store.sqlite');
    const missing = await readWorkContext({
      dbPath: missingPath,
      scope: { checkoutPath: REPOSITORY, kind: 'checkout' },
    });
    expect(missing).toEqual({
      failure: {
        code: 'store-missing',
        message: 'No usage store exists yet; the usage engine creates it on its first run.',
      },
      kind: 'error',
    });
    expect(await Bun.file(missingPath).exists()).toBe(false);

    const invalid = await readWorkContext({ dbPath, scope: { checkoutPath: 'relative', kind: 'checkout' } });
    expect(invalid.kind === 'error' && invalid.failure.code).toBe('invalid-input');
    expect(JSON.stringify(invalid)).not.toContain(dbPath);

    const controller = new AbortController();
    controller.abort();
    const cancelled = await readWorkContext({
      dbPath,
      scope: { checkoutPath: REPOSITORY, kind: 'checkout' },
      signal: controller.signal,
    });
    expect(cancelled.kind === 'error' && cancelled.failure.code).toBe('cancelled');
  });
});

describe('projectWorkContext recorded paths', () => {
  test('a recorded path that is not absolute never matches a checkout scope, and is counted', () => {
    const registry = registryOf(REPOSITORY, 'minimal');
    const template = parse(registry.documents[0] as ClaudeDesktopFixtureDocument, MACHINE);
    if (template === null) {
      throw new Error('the minimal blocked root must parse');
    }
    const dataset = assembleWorkAttention({
      collectionStates: [],
      externalFacts: NO_EXTERNAL_FACTS,
      limit: 200,
      now: EPOCH,
      observations: [template],
      sessions: NO_SERVED_REVISION,
    });
    const [root] = dataset.roots;
    if (root === undefined) {
      throw new Error('the blocked root must be read');
    }
    const recorded = (checkoutPath: string, id: string) => ({
      ...root,
      desktopSessionId: id,
      key: { ...root.key, sourceSessionId: id },
      project: { ...root.project, checkoutPath },
      title: `Fixture: recorded ${id}`,
    });
    const foreign = {
      ...dataset,
      roots: [recorded('work/fixture', 'relative'), recorded('C:\\fixture\\home\\work\\fixture', 'windows')],
    };
    // Resolved against this process's working directory, the relative path would match its scope.
    for (const checkoutPath of [process.cwd(), path.parse(process.cwd()).root]) {
      const context = projectWorkContext(foreign, { checkoutPath, kind: 'checkout' });
      expect(context.waiting).toEqual([]);
      expect(context.coverage.roots).toMatchObject({ inScope: 0, unscopedPaths: 2 });
    }
    // A project label still matches them: the label is not a path.
    const byLabel = projectWorkContext(foreign, { kind: 'project-label', projectLabel: root.project.label });
    expect(byLabel.coverage.roots).toMatchObject({ inScope: 2, unscopedPaths: 0 });
  });
});

describe('projectWorkContext proposals', () => {
  test('a waiting root cites its superseded or expired proposals by id, date and kind, never by title', () => {
    const registry = registryOf(REPOSITORY, 'minimal');
    const template = parse(registry.documents[0] as ClaudeDesktopFixtureDocument, MACHINE);
    if (template === null) {
      throw new Error('the minimal blocked root must parse');
    }
    const secretTitle = 'Fixture proposal title sentinel 7f3c';
    const blocked: ClaudeDesktopSessionObservation = {
      ...template,
      latestUserFrameAt: null,
      openSuggestions: [
        {
          createdAt: hoursBefore(400),
          expiresAt: hoursBefore(200),
          id: 'suggestion-expired',
          title: secretTitle,
          tldr: `Synopsis of ${secretTitle}`,
        },
      ],
    };
    const dataset = assembleWorkAttention({
      collectionStates: [],
      externalFacts: NO_EXTERNAL_FACTS,
      limit: 200,
      now: EPOCH,
      observations: [blocked],
      sessions: NO_SERVED_REVISION,
    });
    // The browser dataset carries the title inside its sentence; the context must not.
    expect(JSON.stringify(dataset)).toContain(secretTitle);
    const context = projectWorkContext(dataset, { checkoutPath: REPOSITORY, kind: 'checkout' });
    const wait = context.waiting.find(({ root }) => root.title === blocked.title);
    const expired = wait?.readings.find(({ kind }) => kind === 'proposal-expired');
    expect(expired?.evidence.map(({ kind }) => kind)).toEqual(['proposal']);
    expect(expired?.evidence[0]?.at).not.toBeNull();
    expect(JSON.stringify(context)).not.toContain(secretTitle);
  });
});

describe('projectWorkContext with Codex sessions in scope (ADR 0059)', () => {
  const codexFamily = (index: number, checkoutPath: string) => ({
    campaignKey: `codex-campaign-${String(index)}`,
    lastActiveAt: EPOCH.getTime() - index * 3_600_000,
    memberCount: 1,
    members: [
      {
        activeAt: EPOCH.getTime() - index * 3_600_000,
        branch: 'fixture/codex',
        campaignRoot: true,
        checkoutPath,
        machineId: MACHINE,
        origin: 'human',
        parentSourceSessionId: null,
        projectLabel: 'fixture',
        rowId: `row-codex-${String(index)}`,
        sourceSessionId: `codex-${String(index)}`,
        startedAt: hoursBefore(index + 1),
        title: `Fixture Codex: session ${String(index)}`,
      },
    ],
  });

  test('a Codex root is never a wait, and the coverage names per harness what was read', () => {
    const registry = registryOf(REPOSITORY, 'minimal');
    const observations = registry.documents
      .map((document) => parse(document as ClaudeDesktopFixtureDocument, MACHINE))
      .filter((observation): observation is ClaudeDesktopSessionObservation => observation !== null);
    const dataset = assembleWorkAttention({
      collectionStates: [],
      externalFacts: NO_EXTERNAL_FACTS,
      harnessSessions: {
        families: [codexFamily(1, REPOSITORY), codexFamily(2, OTHER_REPOSITORY)],
        familiesInWindow: 5,
        generatedAt: EPOCH.toISOString(),
        harness: 'codex',
        refusedRows: 0,
        revision: 'revision-1',
      },
      limit: 200,
      now: EPOCH,
      observations,
      sessions: NO_SERVED_REVISION,
    });
    expect(dataset.roots.some((root) => root.attention === 'not-observable')).toBe(true);

    const context = projectWorkContext(dataset, { checkoutPath: REPOSITORY, kind: 'checkout' });
    expect(context.waiting.every((wait) => wait.root.title !== 'Fixture Codex: session 1')).toBe(true);
    expect(context.waiting.length).toBeGreaterThan(0);
    expect(context.coverage.harnesses).toEqual({
      claudeDesktop: { inScope: context.coverage.roots.inScope - 1, reads: 'declared-waits' },
      codex: { campaignsInWindow: 5, campaignsRead: 2, cutByPage: 0, inScope: 1, reads: 'sessions-only' },
    });

    // Desktop roots fill the page: the Codex roots are cut before scoping, and the context says so
    // instead of reporting them as absent from the scope.
    const desktopCount = dataset.roots.filter((root) => root.attention !== 'not-observable').length;
    const fullPage = assembleWorkAttention({
      collectionStates: [],
      externalFacts: NO_EXTERNAL_FACTS,
      harnessSessions: {
        families: [codexFamily(1, REPOSITORY), codexFamily(2, OTHER_REPOSITORY)],
        familiesInWindow: 2,
        generatedAt: EPOCH.toISOString(),
        harness: 'codex',
        refusedRows: 0,
        revision: 'revision-1',
      },
      limit: desktopCount,
      now: EPOCH,
      observations,
      sessions: NO_SERVED_REVISION,
    });
    const cut = projectWorkContext(fullPage, { checkoutPath: REPOSITORY, kind: 'checkout' });
    expect(cut.coverage.harnesses.codex).toEqual({
      campaignsInWindow: 2,
      campaignsRead: 2,
      cutByPage: 2,
      inScope: 0,
      reads: 'sessions-only',
    });
    expect(cut.truncation.dataset).toBe(true);
    const notes = context.coverage.notes.map(({ code }) => code);
    expect(notes).toContain('desktop-waits-codex-sessions');
    expect(notes).not.toContain('claude-desktop-only');
    expect(context.coverage.notes.find(({ code }) => code === 'desktop-waits-codex-sessions')?.text).toContain(
      'Codex declares no wait',
    );

    // Without any Codex campaign read, the sentence stays the Claude Desktop one.
    const desktopOnly = projectWorkContext(
      assembleWorkAttention({
        collectionStates: [],
        externalFacts: NO_EXTERNAL_FACTS,
        limit: 200,
        now: EPOCH,
        observations,
        sessions: NO_SERVED_REVISION,
      }),
      { checkoutPath: REPOSITORY, kind: 'checkout' },
    );
    expect(desktopOnly.coverage.notes.map(({ code }) => code)).toContain('claude-desktop-only');
    expect(desktopOnly.coverage.harnesses.codex).toEqual({
      campaignsInWindow: 0,
      campaignsRead: 0,
      cutByPage: 0,
      inScope: 0,
      reads: 'sessions-only',
    });
  });
});

describe('projectWorkContext bounds', () => {
  /** Thirty blocked roots in one checkout, each declaring the longest question and detail the contract admits. */
  const crowdedDataset = () => {
    const registry = registryOf(REPOSITORY, 'minimal');
    const template = parse(registry.documents[0] as ClaudeDesktopFixtureDocument, MACHINE);
    if (template === null) {
      throw new Error('the minimal blocked root must parse');
    }
    const observations: ClaudeDesktopSessionObservation[] = Array.from({ length: 30 }, (_value, index) => ({
      ...template,
      cliSessionId: `cli-crowded-${String(index)}`,
      desktopSessionId: `local_crowded-${String(index)}`,
      lastActivityAt: hoursBefore(1 + index),
      // No message after the question: each one is still a request.
      latestUserFrameAt: null,
      sideSessionNotes: [],
      spawnedFrom: null,
      title: `Fixture: crowded ${String(index)}`,
      turnSummary: {
        detail: 'd'.repeat(WORK_ATTENTION_BOUNDS.maxDetailText),
        needsAction: `${String(index)} ${'q'.repeat(WORK_ATTENTION_BOUNDS.maxDetailText - 4)}`,
        status: 'blocked',
        summarizesUuid: null,
      },
    }));
    return assembleWorkAttention({
      collectionStates: [],
      externalFacts: NO_EXTERNAL_FACTS,
      limit: 200,
      now: EPOCH,
      observations,
      sessions: NO_SERVED_REVISION,
    });
  };

  test('cuts each list at its count bound and the whole answer at its byte ceiling, and says so', () => {
    const dataset = crowdedDataset();
    expect(dataset.roots).toHaveLength(30);
    const context: WorkContextDataset = projectWorkContext(dataset, { checkoutPath: REPOSITORY, kind: 'checkout' });
    expect(context.coverage.roots.inScope).toBe(30);
    expect(context.waiting.length).toBeLessThanOrEqual(WORK_CONTEXT_BOUNDS.maxWaits);
    expect(context.waiting.length + context.truncation.omitted.waits).toBe(30);
    expect(context.truncated).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(context)).byteLength).toBeLessThanOrEqual(
      WORK_CONTEXT_BOUNDS.maxOutputBytes,
    );
    // The most recent requests are the ones kept.
    expect(context.waiting[0]?.root.title).toBe('Fixture: crowded 0');
  });

  test('drops the least urgent items first when the encoding is over the ceiling', () => {
    const dataset = crowdedDataset();
    // Inflate every root's interpretation texts so twenty waits no longer fit.
    const inflated = {
      ...dataset,
      roots: dataset.roots.map((root) => ({
        ...root,
        interpretations: root.interpretations.map((interpretation) => ({
          ...interpretation,
          text: `${interpretation.text} ${'x'.repeat(2000)}`,
        })),
      })),
    };
    const context = projectWorkContext(inflated, { checkoutPath: REPOSITORY, kind: 'checkout' });
    expect(context.truncation.bytes).toBe(true);
    expect(context.waiting.length).toBeLessThan(WORK_CONTEXT_BOUNDS.maxWaits);
    expect(context.waiting.length + context.truncation.omitted.waits).toBe(30);
    expect(new TextEncoder().encode(JSON.stringify(context)).byteLength).toBeLessThanOrEqual(
      WORK_CONTEXT_BOUNDS.maxOutputBytes,
    );
  });

  test('throws a RangeError for a scope it cannot apply', () => {
    expect(() => projectWorkContext(crowdedDataset(), { checkoutPath: 'relative/path', kind: 'checkout' })).toThrow(
      RangeError,
    );
  });
});
