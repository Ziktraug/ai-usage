import { describe, expect, test } from 'bun:test';
import { type CanonicalInstant, canonicalInstantFromDate } from '@ai-usage/report-core/canonical-instant';
import {
  CLAUDE_DESKTOP_FIXTURE_PROMPT_SENTINEL,
  claudeDesktopFixtureRegistry,
} from '@ai-usage/report-core/test-fixtures/claude-desktop-sessions';
import type { WorkRoot } from '@ai-usage/report-core/work-attention';
import { parseWorkAttentionOutput } from '@ai-usage/web-contract/work';
import {
  readE2EWorkAttention,
  WORK_ATTENTION_E2E_CODEX_ORPHAN_TITLE,
  WORK_ATTENTION_E2E_CODEX_REVISION,
  WORK_ATTENTION_E2E_CODEX_ROOT_TITLE,
  WORK_ATTENTION_E2E_CODEX_WORKTREE_TITLE,
  WORK_ATTENTION_E2E_JIRA_REPLY_KEY,
  WORK_ATTENTION_E2E_JIRA_TODO_KEY,
  WORK_ATTENTION_E2E_JIRA_UNREADABLE_KEY,
  WORK_ATTENTION_E2E_MACHINE_ID,
  WORK_ATTENTION_E2E_NOW,
  WORK_ATTENTION_E2E_REPOSITORY,
  WORK_ATTENTION_E2E_WORKTREE,
} from './work-attention-e2e-fixture.server';

const hoursBefore = (hours: number): CanonicalInstant =>
  canonicalInstantFromDate(new Date(WORK_ATTENTION_E2E_NOW.getTime() - hours * 3_600_000));

const { ids } = claudeDesktopFixtureRegistry({
  cliSessionIdWithTranscript: 'claude-fixture-025',
  epoch: WORK_ATTENTION_E2E_NOW,
  repository: WORK_ATTENTION_E2E_REPOSITORY,
  variant: 'representative',
});

const readFixture = async () => {
  const result = await readE2EWorkAttention({ machineId: WORK_ATTENTION_E2E_MACHINE_ID });
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result;
};

const kindsOf = (root: WorkRoot | undefined): string[] | undefined => root?.interpretations.map(({ kind }) => kind);

describe('work attention e2e fixture', () => {
  test('confronts the representative registry with synthetic external facts', async () => {
    const result = await readFixture();
    // The fixture must cross the wire contract exactly as a live dataset would.
    expect(parseWorkAttentionOutput(result)).toEqual(JSON.parse(JSON.stringify(result)));
    const byId = new Map(result.data.roots.map((root) => [root.desktopSessionId, root]));

    // An open pull request awaiting review, observed two hours ago: an external wait.
    const completed = byId.get(ids.completedRoot);
    expect(completed?.attention).toBe('external-wait');
    expect(kindsOf(completed)).toEqual(['external-review-pending']);
    expect(completed?.facts.filter(({ kind }) => kind === 'pull-request')).toMatchObject([
      { number: 118, outcome: 'observed', state: 'OPEN', provenance: { observedAt: hoursBefore(2) } },
    ]);

    // A request to merge, declared after the child's declared merge but before GitHub's merge:
    // reconsidered by the observation, not by the declaration, and still a human request.
    const merged = byId.get(ids.mergedBeforeRoot);
    expect(merged?.attention).toBe('human-request');
    expect(merged?.reconsidered).toBe(true);
    expect(kindsOf(merged)).toEqual([
      'request-open',
      'request-satisfied-elsewhere',
      'pull-request-merged',
      'jira-status-differs',
    ]);
    expect(merged?.interpretations[1]?.text).toContain('observed on GitHub');
    expect(merged?.interpretations[1]?.uncertainty).toContain('the question stays yours until you confirm');
    expect(merged?.interpretations[2]?.text).toContain('merge does not prove deployment');

    // A dirty checkout observed forty minutes ago, shared by the blocked root, three other Desktop
    // roots and the Codex session recorded in that worktree.
    const blocked = byId.get(ids.blockedRoot);
    expect(blocked?.attention).toBe('human-request');
    expect(kindsOf(blocked)).toEqual(['request-open', 'local-changes-unvalidated']);
    expect(blocked?.interpretations[1]?.text).toBe(
      `2 modified · 1 untracked · 1 ahead, observed at ${hoursBefore(40 / 60)} on fixture/checkout-3 in checkout-3; since when is unknown; validation and delivery unobserved. Checkout shared by 5 roots.`,
    );
    const sharing = result.data.roots.filter((root) =>
      root.facts.some((fact) => fact.kind === 'checkout-status' && fact.checkoutPath === WORK_ATTENTION_E2E_WORKTREE),
    );
    expect(sharing.map((root) => root.key.harness).sort()).toEqual(['claude', 'claude', 'claude', 'claude', 'codex']);
    // Desktop declares the worktree; Codex records the directory only, and no worktree is inferred for it.
    expect(
      sharing.map((root) => [root.key.harness, root.project.worktreeName]).filter(([harness]) => harness === 'codex'),
    ).toEqual([['codex', null]]);
    expect(
      sharing
        .filter((root) => root.key.harness === 'claude')
        .every((root) => root.project.worktreeName === 'checkout-3'),
    ).toBe(true);

    // An unauthenticated read with an older successful one: two coverage gaps, the dated state kept.
    const satisfied = byId.get(ids.satisfiedRoot);
    expect(satisfied?.attention).toBe('human-request');
    expect(satisfied?.reconsidered).toBe(true);
    expect(kindsOf(satisfied)).toEqual(['request-open', 'request-satisfied-elsewhere', 'coverage-gap', 'coverage-gap']);
    expect(satisfied?.interpretations[1]?.text).toContain('listed by a child session');
    expect(
      satisfied?.facts
        .filter((fact) => fact.kind === 'pull-request')
        .map((fact) => [fact.outcome, fact.state, fact.provenance.observedAt]),
    ).toEqual([
      ['observed', 'OPEN', hoursBefore(26)],
      ['unauthenticated', null, hoursBefore(0.5)],
    ]);
    expect(satisfied?.interpretations[2]?.text).toContain(`was OPEN when last observed at ${hoursBefore(26)}`);
    expect(satisfied?.interpretations[3]?.uncertainty).toContain('sign in gh for github.com');

    // No other root carries a pull request fact: attachment follows declarations only.
    const withPullRequests = [...byId.values()]
      .filter((root) => root.facts.some(({ kind }) => kind === 'pull-request'))
      .map((root) => root.desktopSessionId)
      .sort();
    expect(withPullRequests).toEqual(
      [ids.completedRoot, ids.mergedBeforeRoot, ids.satisfiedRoot, ids.unrelatedPullRequestRoot].sort(),
    );
  });

  test('confronts three explicitly linked Jira tickets: a reply arrived, a status that differs, a refused read', async () => {
    const result = await readFixture();
    const byId = new Map(result.data.roots.map((root) => [root.desktopSessionId, root]));
    const jiraFactsOf = (root: WorkRoot | undefined) =>
      (root?.facts ?? []).flatMap((fact) => (fact.kind === 'jira-issue' ? [fact] : []));

    // A reply six hours ago on the ticket the review-ready root wrote in a branch; the family
    // was last active eleven hours ago: a request for the operator, without claiming it is unread.
    const reviewReady = byId.get(ids.reviewReadyRoot);
    expect(reviewReady?.attention).toBe('human-request');
    expect(kindsOf(reviewReady)).toEqual(['review-ready', 'jira-reply-arrived']);
    expect(jiraFactsOf(reviewReady)).toMatchObject([
      {
        key: WORK_ATTENTION_E2E_JIRA_REPLY_KEY,
        newCommentsSince: 1,
        newestCommentAt: hoursBefore(6),
        outcome: 'observed',
      },
    ]);
    expect(reviewReady?.interpretations[1]?.text).toBe(
      `1 comment arrived on ${WORK_ATTENTION_E2E_JIRA_REPLY_KEY} after this session family's last activity (${hoursBefore(11)}); no resumption observed.`,
    );
    expect(reviewReady?.interpretations[1]?.uncertainty).toContain(
      'You may have read them in Jira; this view cannot tell.',
    );

    // The ticket named in the merged child's pull request branch is still To Do: a difference, not an error.
    const merged = byId.get(ids.mergedBeforeRoot);
    expect(jiraFactsOf(merged)).toMatchObject([{ key: WORK_ATTENTION_E2E_JIRA_TODO_KEY, statusCategory: 'todo' }]);
    // After the open request, its reconsideration and the merge statement.
    expect(merged?.interpretations[3]?.text).toContain(`${WORK_ATTENTION_E2E_JIRA_TODO_KEY} is still To Do`);
    expect(merged?.interpretations[3]?.text).toContain('fixture/ai-usage#90 is MERGED');
    expect(merged?.interpretations[3]?.text).toContain('a different status is not automatically an error');

    // Jira refused the read half an hour ago; the day-old success stays as the last known state.
    const proposal = byId.get(ids.proposalRoot);
    expect(proposal?.attention).toBe('optional-lead');
    expect(jiraFactsOf(proposal).map((fact) => [fact.outcome, fact.status, fact.provenance.observedAt])).toEqual([
      ['observed', 'In Progress', hoursBefore(26)],
      ['unauthenticated', null, hoursBefore(0.5)],
    ]);
    const gaps = proposal?.interpretations.filter(({ kind }) => kind === 'coverage-gap') ?? [];
    expect(gaps).toHaveLength(2);
    expect(gaps[0]?.text).toContain(
      `${WORK_ATTENTION_E2E_JIRA_UNREADABLE_KEY} was In Progress when last observed at ${hoursBefore(26)}`,
    );
    expect(gaps[1]?.uncertainty).toContain('sign in to Jira (acli jira auth login)');

    // No other root carries a Jira fact, and no fact carries a browse address.
    const withJira = [...byId.values()]
      .filter((root) => jiraFactsOf(root).length > 0)
      .map((root) => root.desktopSessionId);
    expect(withJira.sort()).toEqual([ids.mergedBeforeRoot, ids.proposalRoot, ids.reviewReadyRoot].sort());
    expect(result.data.roots.flatMap(jiraFactsOf).every((fact) => fact.url === null)).toBe(true);
    expect(result.data.coverage.jira).toEqual({
      disabled: false,
      failed: 1,
      lastRunAt: hoursBefore(0.5),
      observed: 2,
      reason: null,
    });
  });

  test('reports the producers’ runs in coverage and keeps the registry’s private text out', async () => {
    const result = await readFixture();
    expect(result.data.coverage.pullRequests).toEqual({
      disabled: false,
      failed: 1,
      lastRunAt: hoursBefore(0.5),
      observed: 4,
    });
    expect(result.data.coverage.checkouts).toEqual({ failed: 0, lastRunAt: hoursBefore(40 / 60), observed: 1 });
    // The Desktop join is absent here; the revision named is the one the Codex families came from.
    expect(result.data.coverage.sessions).toEqual({
      joined: 0,
      revision: WORK_ATTENTION_E2E_CODEX_REVISION,
      unmatched: 0,
    });
    expect(result.data.coverage.window.sinceDays).toBe(30);
    expect(result.data.totalRoots).toBe(result.data.roots.length + result.data.coverage.window.excludedRoots);
    expect(JSON.stringify(result)).not.toContain(CLAUDE_DESKTOP_FIXTURE_PROMPT_SENTINEL);
    // Every first-level group the Work view renders is present at least once.
    const attentions = new Set(result.data.roots.map((root) => root.attention));
    expect([...attentions].sort()).toEqual([
      'external-wait',
      'human-request',
      'none',
      'not-observable',
      'optional-lead',
    ]);
  });

  test('shows the served Codex families as their own roots, wait unknown, never folded or promoted (ADR 0059)', async () => {
    const result = await readFixture();
    const codex = result.data.roots.filter((root) => root.key.harness === 'codex');
    // After every Desktop root, most recently active first.
    expect(result.data.roots.slice(-3)).toEqual(codex);
    expect(codex.map((root) => [root.title, root.attention, root.desktopSessionId, root.declared])).toEqual([
      [WORK_ATTENTION_E2E_CODEX_WORKTREE_TITLE, 'not-observable', null, null],
      [WORK_ATTENTION_E2E_CODEX_ROOT_TITLE, 'not-observable', null, null],
      [WORK_ATTENTION_E2E_CODEX_ORPHAN_TITLE, 'not-observable', null, null],
    ]);
    const [worktree, root, orphan] = codex;
    // The dirty worktree is interpreted, and still asks nothing of anyone.
    expect(kindsOf(worktree)).toEqual(['coverage-gap', 'local-changes-unvalidated']);
    expect(worktree?.interpretations[1]?.text).toContain('Checkout shared by 5 roots.');
    expect(worktree?.project).toMatchObject({
      branch: 'fixture/checkout-3',
      checkoutPath: WORK_ATTENTION_E2E_WORKTREE,
    });
    // Its delegated child and its review fold under the root through their declared links only.
    expect(root?.children).toMatchObject({
      count: 2,
      titles: ['Fixture Codex: delegated slice', 'Fixture Codex: review'],
    });
    expect(root?.session).toEqual({
      campaignKey: `${WORK_ATTENTION_E2E_MACHINE_ID}:codex:codex-e2e-root`,
      rowId: 'e2e-codex-row-codex-e2e-root',
    });
    expect(orphan?.interpretations.map(({ text }) => text)).toContain(
      'Started from a Codex session that is not in the served report; it stands as its own root.',
    );
    // No Desktop root gained a child from a Codex session that shares its checkout and branch.
    expect(
      result.data.roots
        .filter((candidate) => candidate.key.harness === 'claude')
        .flatMap((candidate) => candidate.children.titles)
        .some((title) => title.startsWith('Fixture Codex')),
    ).toBe(false);
  });
});

describe('work attention e2e fixture against what Claude Desktop recorded after a request (ADR 0056)', () => {
  test('replays dated messages and declaration replacements without inferring answers or settled parent work', async () => {
    const result = await readFixture();
    const byId = new Map(result.data.roots.map((root) => [root.desktopSessionId, root]));

    const answered = byId.get(ids.answeredRoot);
    expect(answered?.attention).toBe('human-request');
    expect(answered?.declared?.needsAction).toBe('Delete the superseded layout branch now?');
    expect(kindsOf(answered)).toEqual(['request-open', 'earlier-request-superseded']);
    expect(answered?.interpretations[1]?.text).toBe(
      `Declaration replaced: the question “Keep the compact layout or the airy one?” (asked ${hoursBefore(5)}) was replaced by the session’s declaration at ${hoursBefore(3)}.`,
    );

    expect(answered?.interpretations[1]?.uncertainty).toContain(`A message from you was observed at ${hoursBefore(4)}`);
    expect(kindsOf(answered)).not.toContain('earlier-request-answered');

    const replied = byId.get(ids.repliedRoot);
    expect(replied?.attention).toBe('human-request');
    expect(kindsOf(replied)).toEqual(['request-open', 'request-message-observed']);
    expect(replied?.interpretations[1]?.uncertainty).toContain('Whether it answers this question is unknown');
    expect(kindsOf(replied)).not.toContain('request-answered');

    // GitHub shows #131 merged after the question; the question asks for no pull request.
    const unrelated = byId.get(ids.unrelatedPullRequestRoot);
    expect(unrelated?.attention).toBe('human-request');
    expect(unrelated?.reconsidered).toBe(false);
    expect(kindsOf(unrelated)).toEqual(['request-open', 'pull-request-merged']);

    const offers = byId.get(ids.laterOfferRoot);
    expect(offers?.attention).toBe('optional-lead');
    expect(kindsOf(offers)).toEqual(['proposal-open', 'proposal-expired']);

    expect(kindsOf(byId.get(ids.handledRoot))).toEqual(['request-open', 'request-continued-elsewhere']);
    expect(byId.get(ids.handledRoot)?.attention).toBe('human-request');
    expect(byId.get(ids.handledRoot)?.reconsidered).toBe(true);
    expect(kindsOf(byId.get(ids.handledRoot))).not.toContain('request-handled-elsewhere');
    expect(byId.get(ids.continuedRoot)?.reconsidered).toBe(true);
    expect(kindsOf(byId.get(ids.continuedRoot))).toEqual(['request-open', 'request-continued-elsewhere']);
    // The new interpretation kinds cross the wire contract.
    expect(parseWorkAttentionOutput(result)).toEqual(JSON.parse(JSON.stringify(result)));
  });
});
