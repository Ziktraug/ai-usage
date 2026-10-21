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

    // A dirty checkout observed forty minutes ago, shared by the blocked root and three others.
    const blocked = byId.get(ids.blockedRoot);
    expect(blocked?.attention).toBe('human-request');
    expect(kindsOf(blocked)).toEqual(['request-open', 'local-changes-unvalidated']);
    expect(blocked?.interpretations[1]?.text).toBe(
      `2 modified, 1 untracked observed at ${hoursBefore(40 / 60)} on fixture/checkout-3 in checkout-3; since when is unknown; validation and delivery unobserved. Checkout shared by 4 roots.`,
    );
    const sharing = [...byId.values()].filter((root) =>
      root.facts.some((fact) => fact.kind === 'checkout-status' && fact.checkoutPath === WORK_ATTENTION_E2E_WORKTREE),
    );
    expect(sharing).toHaveLength(4);
    expect(sharing.every((root) => root.project.worktreeName === 'checkout-3')).toBe(true);

    // An unauthenticated read with an older successful one: two coverage gaps, the dated state kept.
    const satisfied = byId.get(ids.satisfiedRoot);
    expect(satisfied?.attention).toBe('human-request');
    expect(satisfied?.reconsidered).toBe(true);
    expect(kindsOf(satisfied)).toEqual(['request-open', 'request-satisfied-elsewhere', 'coverage-gap', 'coverage-gap']);
    expect(satisfied?.interpretations[1]?.text).toContain('declared by a child session');
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
    expect(withPullRequests).toEqual([ids.completedRoot, ids.mergedBeforeRoot, ids.satisfiedRoot].sort());
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
      observed: 3,
    });
    expect(result.data.coverage.checkouts).toEqual({ failed: 0, lastRunAt: hoursBefore(40 / 60), observed: 1 });
    expect(result.data.coverage.sessions).toEqual({ joined: 0, revision: null, unmatched: 0 });
    expect(result.data.coverage.window.sinceDays).toBe(30);
    expect(result.data.totalRoots).toBe(result.data.roots.length + result.data.coverage.window.excludedRoots);
    expect(JSON.stringify(result)).not.toContain(CLAUDE_DESKTOP_FIXTURE_PROMPT_SENTINEL);
    // Every first-level group the Work view renders is present at least once.
    const attentions = new Set(result.data.roots.map((root) => root.attention));
    expect([...attentions].sort()).toEqual(['external-wait', 'human-request', 'none', 'optional-lead']);
  });
});
