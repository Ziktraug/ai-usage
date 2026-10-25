import { describe, expect, test } from 'bun:test';
import { canonicalInstantFromDate } from '@ai-usage/report-core/canonical-instant';
import type { WorkRoot } from '@ai-usage/report-core/work-attention';
import {
  EMPTY_WORK_ATTENTION_SEARCH,
  filterWorkRoots,
  formatRelativeAge,
  groupWorkFactsBySource,
  groupWorkRoots,
  hasWorkAttentionFilters,
  matchesWorkAttentionSearch,
  nextWorkRowIndex,
  parseWorkAttentionSearch,
  sortWorkRoots,
  toggleListValue,
  WORK_ATTENTION_SECTIONS,
  workCheckoutUnreadSummary,
  workCodexCoverage,
  workFactSummary,
  workFilterOptions,
  workRootDormantNote,
  workRootFactChips,
  workRootId,
  workRootLastDecision,
  workRootNextAction,
  workRootPastProposalIds,
  workRootRowTitle,
  workRootStanding,
  workSearchCoverage,
  workUndeclaredSituation,
  writeWorkAttentionSearch,
} from './work-attention-model';
import { syntheticWorkAttentionDataset } from './work-attention-synthetic';
import { WORK_DEMO_TIME } from './work-synthetic';

const dataset = syntheticWorkAttentionDataset();
const roots = dataset.roots;
const rootNamed = (title: string): WorkRoot => {
  const root = roots.find((candidate) => candidate.title === title);
  if (!root) {
    throw new Error(`Synthetic root ${title} is missing`);
  }
  return root;
};

describe('Work attention grouping and ordering', () => {
  test('groups every root under exactly one first-level section, most recent first', () => {
    const groups = groupWorkRoots(roots);
    expect(groups.map((group) => group.section.kind)).toEqual([
      'human-request',
      'external-wait',
      'optional-lead',
      'none',
      'not-observable',
    ]);
    expect(groups.reduce((total, group) => total + group.roots.length, 0)).toBe(roots.length);
    for (const group of groups) {
      // Most recent first, except that reconsidered requests follow every unreconsidered one.
      const firstReconsidered = group.roots.findIndex((root) => root.reconsidered);
      const leading = firstReconsidered < 0 ? group.roots : group.roots.slice(0, firstReconsidered);
      expect(group.roots.slice(leading.length).every((root) => root.reconsidered)).toBe(true);
      const instants = leading.map((root) => Date.parse(root.age.declaredAt ?? root.age.lastActivityAt ?? ''));
      expect([...instants].sort((left, right) => right - left)).toEqual(instants);
      expect(group.roots.every((root) => root.attention === group.section.kind)).toBe(true);
    }
    expect(groups[0]?.roots[0]?.title).toBe('Recover Claude history');
  });
  test('a reconsidered request stays a human request, ranks last in Needs you and names the pull request', () => {
    const reconsidered = rootNamed('Scan resource optimization');
    expect(reconsidered.declared?.needsAction).not.toBeNull();
    expect(reconsidered.attention).toBe('human-request');
    expect(reconsidered.reconsidered).toBe(true);
    expect(reconsidered.interpretations.map((entry) => entry.kind)).toEqual([
      'request-open',
      'request-satisfied-elsewhere',
    ]);
    const needsYou = groupWorkRoots(roots)[0]!.roots;
    // The older declarations to reconsider close the section, after every current block, most
    // recent first: a later link, then a week without activity.
    expect(needsYou.slice(-3).map((root) => root.title)).toEqual([
      'Toolbar refresh',
      'Scan resource optimization',
      'Session distillation worker redaction',
    ]);
    expect(needsYou.slice(0, -3).every((root) => !root.reconsidered)).toBe(true);
    // Older than every other request, it would rank first by date alone; the flag sorts it last.
    expect(workRootFactChips(reconsidered).map((chip) => chip.label)).toEqual([
      'possibly answered · PR #61',
      'PR #61 merged',
      'children 1',
    ]);
  });
  test('sorting is stable for undated roots and ties on title', () => {
    const [first, second] = roots;
    const undated = {
      ...first!,
      age: { createdAt: null, declaredAt: null, lastActivityAt: null, lastObservedAt: null },
      title: 'zzz',
    };
    const sorted = sortWorkRoots([undated, second!, first!]);
    expect(sorted.at(-1)?.title).toBe('zzz');
  });
  test('the recent and the Codex sections are the only ones that collapse, beyond ten rows', () => {
    expect(WORK_ATTENTION_SECTIONS.map((section) => section.collapseBeyond)).toEqual([null, null, null, 10, 10]);
  });
  test('the recent section claims only what was read, never that nothing is pending', () => {
    expect(WORK_ATTENTION_SECTIONS[3]).toEqual({
      collapseBeyond: 10,
      kind: 'none',
      note: 'Completed, undeclared or unsupported outcomes. Nothing pending was read here; that is not proof that nothing is pending.',
      title: 'Recent · no pending declaration read',
    });
    expect(WORK_ATTENTION_SECTIONS.map((section) => section.title)).toEqual([
      'Needs you',
      'Waiting on others',
      'Leads',
      'Recent · no pending declaration read',
      'Codex · no declared wait read',
    ]);
  });
  test('the Codex section says its wait is unknown, apart from nothing pending (ADR 0059)', () => {
    expect(WORK_ATTENTION_SECTIONS[4]).toEqual({
      collapseBeyond: 10,
      kind: 'not-observable',
      note: 'Codex records no turn status: these sessions show their checkout, branch and last activity only. Whether one waits on you is unknown — not declared by this harness, which is not the same as nothing pending.',
      title: 'Codex · no declared wait read',
    });
    const codex = rootNamed('Build report UI');
    expect(codex.attention).toBe('not-observable');
    expect(groupWorkRoots(roots)[4]?.roots).toEqual([codex]);
    expect(groupWorkRoots(roots)[3]?.roots.some((root) => root.key.harness === 'codex')).toBe(false);
  });
});

describe('Work attention for a harness that declares no wait (ADR 0059)', () => {
  const codex = rootNamed('Build report UI');
  test('reads as unknown, never as nothing asked, with the harness named', () => {
    expect(workRootStanding(codex)).toBe('not-declared');
    expect(workUndeclaredSituation(codex)).toBe('wait unknown · not declared by Codex');
    expect(workRootNextAction(codex)).toBe(
      'Check the session in Codex; this view cannot tell whether it waits on you.',
    );
    expect(workRootLastDecision(codex)).toBeNull();
    // A Claude root without a declaration and a bare activity row keep their own words.
    expect(workUndeclaredSituation(rootNamed('Headless Chrome CDP driving'))).toBe('no declaration');
    expect(workUndeclaredSituation({ ...codex, attention: 'none' })).toBe('activity only');
  });
  test('a Codex row reads a plain title: no markdown marks, one line, the first sentence or about 90 characters', () => {
    const titled = (title: string) => workRootRowTitle({ ...codex, title });
    expect(titled('**Fix** the `parseRollout` reader')).toBe('Fix the parseRollout reader');
    expect(titled('Review   the\n\n__collector__  and *its* tests')).toBe('Review the collector and its tests');
    expect(titled('# Plan\n- run `bun test`\n- read [the ADR](https://example.test/adr)')).toBe(
      'Plan run bun test read the ADR',
    );
    // The first sentence, when it ends early; the rest is in the detail.
    expect(titled('Investigate the collector failure. Then rerun the scan and report the counts.')).toBe(
      'Investigate the collector failure…',
    );
    expect(titled('Can you check the quota window? It looks stale since yesterday.')).toBe(
      'Can you check the quota window?…',
    );
    // A long first sentence is cut near 90 characters, at a word, with an ellipsis.
    const long = titled(
      'Refactor the history line emitter so that every chunk boundary is handled in linear work without re-flattening the rope',
    );
    expect(long).toBe('Refactor the history line emitter so that every chunk boundary is handled in linear work…');
    expect(long.length).toBeLessThanOrEqual(91);
    // Long local paths keep their last two segments; identifiers and addresses are left as written.
    expect(titled('Read /home/fixture/Projects/ai-usage/packages/local-collectors/src/codex-history.ts first')).toBe(
      'Read …/src/codex-history.ts first',
    );
    expect(titled('Check ~/Projects/ai-usage/apps/web and https://github.com/fixture/project/pull/66')).toBe(
      'Check …/apps/web and https://github.com/fixture/project/pull/66',
    );
    expect(titled('Keep snake_case_names and v1.2.3 intact')).toBe('Keep snake_case_names and v1.2.3 intact');
    // Nothing but marks: the title as written, whitespace collapsed.
    expect(titled('```')).toBe('```');
    // The detail keeps the full text; Claude Desktop titles are the app's own and stay as written.
    const desktop = rootNamed('Fix mobile navigation label overlap');
    expect(workRootRowTitle({ ...desktop, title: '**Kept** as written. Really.' })).toBe(
      '**Kept** as written. Really.',
    );
  });
  test('the coverage line says what Codex contributed: sessions shown, or why none were', () => {
    expect(workCodexCoverage(dataset)).toBe('1 of 1 Codex campaign shown, active in the last 30 days (served report)');
    // The Codex budget and the page limit both leave campaigns out: the line counts them.
    expect(
      workCodexCoverage({
        ...dataset,
        coverage: { ...dataset.coverage, codexSessions: { campaignsInWindow: 204, campaignsRead: 20 } },
      }),
    ).toBe('1 of 204 Codex campaigns shown, active in the last 30 days (served report)');
    const withoutCodex = {
      coverage: { ...dataset.coverage, codexSessions: { campaignsInWindow: 0, campaignsRead: 0 } },
      roots: roots.filter((root) => root.key.harness !== 'codex'),
    };
    expect(workCodexCoverage(withoutCodex)).toBe('no session active in the last 30 days');
    // Desktop roots filled the page: the campaigns exist, none is shown, and the line says so.
    expect(
      workCodexCoverage({
        coverage: { ...dataset.coverage, codexSessions: { campaignsInWindow: 20, campaignsRead: 20 } },
        roots: withoutCodex.roots,
      }),
    ).toBe('0 of 20 Codex campaigns shown: the page limit left them out (active in the last 30 days, served report)');
    expect(
      workCodexCoverage({
        ...withoutCodex,
        coverage: { ...dataset.coverage, sessions: { ...dataset.coverage.sessions, revision: null } },
      }),
    ).toBe('not read: no served report revision yet');
  });
});

describe('Work attention search and filters', () => {
  test('text search matches title, project, question, branch and pull request number as AND tokens', () => {
    const search = (query: string) => filterWorkRoots(roots, { ...EMPTY_WORK_ATTENTION_SEARCH, query });
    expect(search('mobile navigation').map((root) => root.title)).toEqual(['Fix mobile navigation label overlap']);
    expect(search('#71').map((root) => root.title)).toEqual(['Fix mobile navigation label overlap']);
    expect(search('quota-last-confirmation').map((root) => root.title)).toEqual(['Recover Claude history']);
    expect(search('MacBook snapshot').map((root) => root.titleSource)).toEqual(['auto']);
    expect(search('docs-site').length).toBe(1);
    expect(search('mobile zzz-no-such-token')).toEqual([]);
  });
  test('attention, harness, machine and project chips narrow the list independently', () => {
    const blocked = filterWorkRoots(roots, { ...EMPTY_WORK_ATTENTION_SEARCH, attention: ['human-request'] });
    expect(blocked.length).toBe(8);
    expect(blocked.every((root) => root.attention === 'human-request')).toBe(true);
    const codex = filterWorkRoots(roots, { ...EMPTY_WORK_ATTENTION_SEARCH, harness: ['codex'] });
    expect(codex.map((root) => root.title)).toEqual(['Build report UI']);
    expect(codex.every((root) => root.declared === null && root.attention === 'not-observable')).toBe(true);
    const secondary = filterWorkRoots(roots, {
      ...EMPTY_WORK_ATTENTION_SEARCH,
      machine: ['fixture-machine-secondary'],
    });
    expect(secondary.map((root) => root.title)).toEqual(['Headless Chrome CDP driving']);
    const docs = filterWorkRoots(roots, { ...EMPTY_WORK_ATTENTION_SEARCH, project: ['docs-site', 'mobile-app'] });
    expect(docs.length).toBe(2);
  });
  test('filter options count every root once per dimension', () => {
    const options = workFilterOptions(roots);
    expect(options.attention.map((option) => option.value)).toEqual([
      'human-request',
      'external-wait',
      'optional-lead',
      'none',
      'not-observable',
    ]);
    expect(options.harness.reduce((total, option) => total + option.count, 0)).toBe(roots.length);
    expect(options.machine.map((option) => option.value)).toEqual(['fixture-machine', 'fixture-machine-secondary']);
    expect(options.project[0]?.value).toBe('ai-usage');
  });
  test('the selected root never participates in matching', () => {
    const root = rootNamed('Build report UI');
    expect(matchesWorkAttentionSearch(root, { ...EMPTY_WORK_ATTENTION_SEARCH, root: 'something-else' })).toBe(true);
  });
  test('toggling a chip adds then removes its value', () => {
    expect(toggleListValue([], 'codex')).toEqual(['codex']);
    expect(toggleListValue(['codex', 'claude'], 'codex')).toEqual(['claude']);
  });
});

describe('Work attention URL state', () => {
  test('round-trips filters and selection through search params and drops defaults', () => {
    const search = parseWorkAttentionSearch(
      new URLSearchParams(
        'q=mobile+nav&attention=human-request,bogus&harness=claude&machine=m1&project=ai-usage&root=desk-mobile-nav',
      ),
    );
    expect(search).toEqual({
      attention: ['human-request'],
      harness: ['claude'],
      machine: ['m1'],
      project: ['ai-usage'],
      query: 'mobile nav',
      root: 'desk-mobile-nav',
    });
    const written = writeWorkAttentionSearch(new URL('http://work.invalid/work?other=1#hash'), search);
    expect(written.searchParams.get('other')).toBe('1');
    expect(written.hash).toBe('');
    expect(parseWorkAttentionSearch(written.searchParams)).toEqual(search);
    const cleared = writeWorkAttentionSearch(written, EMPTY_WORK_ATTENTION_SEARCH);
    expect([...cleared.searchParams.keys()]).toEqual(['other']);
    expect(hasWorkAttentionFilters(search)).toBe(true);
    expect(hasWorkAttentionFilters({ ...EMPTY_WORK_ATTENTION_SEARCH, root: 'x' })).toBe(false);
  });
  test('a root address is the desktop session id, or the full session key for other harnesses', () => {
    expect(workRootId(rootNamed('Recover Claude history'))).toBe('desk-claude-history-fallback');
    expect(workRootId(rootNamed('Build report UI'))).toBe(
      JSON.stringify(['fixture-machine', 'codex', 'campaign-root']),
    );
  });
});

describe('Work attention keyboard movement', () => {
  test('arrows clamp at the edges, Home/End jump, other keys are ignored', () => {
    expect(nextWorkRowIndex(-1, 'ArrowDown', 5)).toBe(0);
    expect(nextWorkRowIndex(0, 'ArrowUp', 5)).toBe(0);
    expect(nextWorkRowIndex(4, 'ArrowDown', 5)).toBe(4);
    expect(nextWorkRowIndex(2, 'ArrowDown', 5)).toBe(3);
    expect(nextWorkRowIndex(2, 'Home', 5)).toBe(0);
    expect(nextWorkRowIndex(2, 'End', 5)).toBe(4);
    expect(nextWorkRowIndex(2, 'Enter', 5)).toBeNull();
    expect(nextWorkRowIndex(0, 'ArrowDown', 0)).toBeNull();
  });
});

describe('Work attention dates and fact chips', () => {
  test('relative ages are coarse and relative to the dataset instant, never to the wall clock', () => {
    const minutes = new Date(Date.parse(WORK_DEMO_TIME) - 25 * 60_000).toISOString();
    const hours = new Date(Date.parse(WORK_DEMO_TIME) - 3 * 3_600_000).toISOString();
    const days = new Date(Date.parse(WORK_DEMO_TIME) - 40 * 86_400_000).toISOString();
    expect(formatRelativeAge(minutes, WORK_DEMO_TIME)).toBe('25 min ago');
    expect(formatRelativeAge(hours, WORK_DEMO_TIME)).toBe('3 h ago');
    expect(formatRelativeAge(days, WORK_DEMO_TIME)).toBe('40 d ago');
    expect(formatRelativeAge(WORK_DEMO_TIME, WORK_DEMO_TIME)).toBe('just now');
    expect(formatRelativeAge(null, WORK_DEMO_TIME)).toBe('undated');
  });
  test('chips merge a declared and an observed pull request into one line dated by the observation', () => {
    const mobile = rootNamed('Fix mobile navigation label overlap');
    const chips = workRootFactChips(mobile);
    expect(chips.map((chip) => chip.label)).toEqual(['PR #71 checks pending', 'children 1']);
    const observed = mobile.facts.find((fact) => fact.kind === 'pull-request');
    expect(chips[0]).toMatchObject({ instant: observed?.provenance.observedAt, instantLabel: 'observed' });
    const dirty = workRootFactChips(rootNamed('Recover Claude history'));
    expect(dirty.map((chip) => chip.label)).toEqual([
      'checkout 3 modified · 1 untracked · 2 ahead',
      'children 2 · 1 blocked',
    ]);
    expect(dirty.map((chip) => chip.tone)).toEqual(['warn', 'warn']);
    expect(dirty[0]?.instantLabel).toBe('observed');
    const failed = workRootFactChips(rootNamed('Platform runtime review follow-ups'));
    expect(failed.map((chip) => chip.label)).toEqual(['PR #53 read failed (unauthenticated)']);
    const leads = workRootFactChips(rootNamed('Overview composition pass'));
    expect(leads.map((chip) => chip.label)).toEqual(['proposals 2 open / 1 resolved']);
  });
  test('a checkout chip and its detail line name every count git reported, the same words in both', () => {
    const base = rootNamed('Recover Claude history');
    const fact = base.facts.find((candidate) => candidate.kind === 'checkout-status');
    if (fact?.kind !== 'checkout-status') {
      throw new Error('Synthetic root must carry a checkout fact');
    }
    const withCheckout = (counts: Partial<typeof fact>) => {
      const changed = { ...fact, ...counts };
      return {
        chips: workRootFactChips({ ...base, children: { ...base.children, count: 0 }, facts: [changed] }),
        summary: workFactSummary(changed, base),
      };
    };
    const where = `Checkout ${fact.checkoutPath} on ${fact.branch}`;
    // Staged work with one untracked file: never "0 modified".
    const staged = withCheckout({ ahead: 2, modifiedCount: 0, stagedCount: 28, untrackedCount: 1 });
    expect(staged.chips.map(({ label, tone }) => [label, tone])).toEqual([
      ['checkout 28 staged · 1 untracked · 2 ahead', 'warn'],
    ]);
    expect(staged.summary).toBe(`${where}: 28 staged · 1 untracked · 2 ahead`);
    const untracked = withCheckout({ ahead: 0, modifiedCount: 0, stagedCount: 0, untrackedCount: 2 });
    expect(untracked.chips.map((chip) => chip.label)).toEqual(['checkout 2 untracked']);
    expect(untracked.summary).toBe(`${where}: 2 untracked`);
    // Clean: no chip in the row, "clean" in the detail; commits not pushed still show, neutrally.
    const clean = withCheckout({ ahead: 0, dirty: false, modifiedCount: 0, stagedCount: 0, untrackedCount: 0 });
    expect(clean.chips).toEqual([]);
    expect(clean.summary).toBe(`${where}: clean`);
    const ahead = withCheckout({ ahead: 2, dirty: false, modifiedCount: 0, stagedCount: 0, untrackedCount: 0 });
    expect(ahead.chips.map(({ label, tone }) => [label, tone])).toEqual([['checkout clean · 2 ahead', 'neutral']]);
    expect(ahead.summary).toBe(`${where}: clean · 2 ahead`);
  });
  test('a checkout without a git status names why, and only a failed read is a warning', () => {
    const base = rootNamed('Recover Claude history');
    const fact = base.facts.find((candidate) => candidate.kind === 'checkout-status');
    if (fact?.kind !== 'checkout-status') {
      throw new Error('Synthetic root must carry a checkout fact');
    }
    const unread = (outcome: typeof fact.outcome) => ({
      ...fact,
      ahead: null,
      behind: null,
      dirty: null,
      modifiedCount: null,
      outcome,
      stagedCount: null,
      untrackedCount: null,
    });
    const chipsOf = (outcome: typeof fact.outcome) =>
      workRootFactChips({ ...base, children: { ...base.children, count: 0 }, facts: [unread(outcome)] }).map(
        ({ label, tone }) => [label, tone],
      );
    // A worktree removed after its session is a fact about the past session, not an alarm.
    expect(chipsOf('missing')).toEqual([['checkout no longer on disk (removed since the session)', 'neutral']]);
    expect(chipsOf('not-a-repository')).toEqual([['checkout not a git repository', 'neutral']]);
    expect(chipsOf('timeout')).toEqual([['checkout not read (git timed out)', 'warn']]);
    expect(workFactSummary(unread('missing'))).toBe(
      `Checkout ${fact.checkoutPath}: no longer on disk (removed since the session)`,
    );
    expect(workFactSummary(unread('denied'))).toBe(`Checkout ${fact.checkoutPath}: not read, permission denied`);
  });
  test('the coverage line counts why the checkouts of the shown roots were not read, once per checkout', () => {
    const base = rootNamed('Recover Claude history');
    const fact = base.facts.find((candidate) => candidate.kind === 'checkout-status');
    if (fact?.kind !== 'checkout-status') {
      throw new Error('Synthetic root must carry a checkout fact');
    }
    const at = (outcome: typeof fact.outcome, checkoutPath: string, observedAt = fact.provenance.observedAt) => ({
      ...fact,
      checkoutPath,
      id: `${checkoutPath}@${observedAt}`,
      outcome,
      provenance: { ...fact.provenance, observedAt },
    });
    const earlier = canonicalInstantFromDate(new Date(Date.parse(fact.provenance.observedAt) - 86_400_000));
    const withFacts = (facts: WorkRoot['facts']) => ({ ...base, facts });
    expect(workCheckoutUnreadSummary(roots)).toBeNull();
    expect(
      workCheckoutUnreadSummary([
        withFacts([at('missing', '/wt/a'), at('missing', '/wt/b'), at('not-a-repository', '/home')]),
        // The same checkout under a second root counts once; its latest observation decides.
        withFacts([at('missing', '/wt/a'), at('observed', '/wt/c', earlier), at('timeout', '/wt/c')]),
        withFacts([at('missing', '/wt/d', earlier), at('observed', '/wt/d')]),
      ]),
    ).toBe(
      'of the checkouts the roots shown name: 2 no longer on disk (removed since the session), 1 not a git repository, 1 not read (git timed out)',
    );
  });
  test('a declared-only pull request chip is dated by the session file that listed it', () => {
    const mobile = rootNamed('Fix mobile navigation label overlap');
    const declaredOnly = { ...mobile, facts: mobile.facts.filter((fact) => fact.kind !== 'pull-request') };
    const [chip] = workRootFactChips(declaredOnly);
    const declared = declaredOnly.facts.find((fact) => fact.kind === 'declared-pull-request');
    expect(chip).toMatchObject({
      instant: declared?.provenance.observedAt,
      instantLabel: 'listed',
      label: 'PR #71 open (declared)',
      tone: 'neutral',
    });
  });
  test('a blocked declaration without a question carries a chip saying so', () => {
    const base = rootNamed('Recover Claude history');
    const silent = {
      ...base,
      attention: 'none' as const,
      declared: { ...base.declared!, needsAction: '   ' },
      facts: [],
      interpretations: [],
      reconsidered: false,
    };
    expect(workRootFactChips(silent)).toEqual([
      {
        id: `${workRootId(silent)}:blocked-no-question`,
        instant: null,
        instantLabel: null,
        label: 'blocked · no question recorded',
        tone: 'warn',
      },
      {
        id: `${workRootId(silent)}:children`,
        instant: null,
        instantLabel: null,
        label: 'children 2 · 1 blocked',
        tone: 'warn',
      },
    ]);
    expect(workRootFactChips(base).some((chip) => chip.label.startsWith('blocked ·'))).toBe(false);
  });
  test('a Jira issue chip names the key, the status and the replies that arrived; a failed read names its outcome', () => {
    const withJira = roots.find((root) => root.facts.some((candidate) => candidate.kind === 'jira-issue'));
    if (withJira === undefined) {
      throw new Error('Synthetic dataset must carry a Jira fact');
    }
    const chips = workRootFactChips(withJira);
    expect(chips.map((chip) => chip.label)).toContain('Jira XLB-2090 · In Progress · 2 new replies');
    expect(chips.find((chip) => chip.label.startsWith('Jira'))?.tone).toBe('warn');
    const fact = withJira.facts.find((candidate) => candidate.kind === 'jira-issue');
    if (fact === undefined || fact.kind !== 'jira-issue') {
      throw new Error('expected a Jira fact');
    }
    expect(workFactSummary(fact)).toBe(
      'Jira XLB-2090 In Progress, 2 comments, 2 new replies since the latest activity on this key',
    );
    const failed = { ...fact, newCommentsSince: null, outcome: 'unauthenticated' as const, status: null };
    expect(workFactSummary(failed)).toBe('Jira XLB-2090 read failed: unauthenticated');
    expect(workRootFactChips({ ...withJira, facts: [fact, failed] }).map((chip) => chip.label)).toEqual([
      'Jira XLB-2090 read failed (unauthenticated)',
    ]);
    expect(matchesWorkAttentionSearch(withJira, { ...EMPTY_WORK_ATTENTION_SEARCH, query: 'xlb-2090' })).toBe(true);
  });
  test('facts group by their source in first-seen order', () => {
    const groups = groupWorkFactsBySource(rootNamed('Fix mobile navigation label overlap').facts);
    expect(groups.map((group) => group.source)).toEqual(['claude-desktop', 'github', 'local-checkout']);
  });
});

describe('Work attention standing, last decision and next action (ADR 0056)', () => {
  test('reads the standing from the interpretations: current, to reconsider, answered elsewhere', () => {
    expect(workRootStanding(rootNamed('Fix mobile navigation label overlap'))).toBe('current');
    expect(workRootStanding(rootNamed('Scan resource optimization'))).toBe('reconsider');
    expect(workRootStanding(rootNamed('Toolbar refresh'))).toBe('reconsider');
    expect(workRootStanding(rootNamed('Release checklist'))).toBe('handled');
    expect(workRootStanding(rootNamed('Viz lineage exploration'))).toBe('none');
  });

  test('an earlier question answered in the harness is the row’s last decision, dated by its own fact', () => {
    const root = rootNamed('Sources label');
    expect(workRootStanding(root)).toBe('current');
    const decision = workRootLastDecision(root);
    expect(decision?.text).toBe('Earlier “Call the rail entry “Inputs” or “Collectors”?” answered in Claude Desktop');
    expect(decision?.instantLabel).toBe('asked');
    const earlier = root.facts.find((fact) => fact.id === 'sources-label:declared-earlier');
    expect(String(earlier?.kind === 'declared-turn' ? earlier.declaredAt : null)).toBe(String(decision?.instant));
    expect(workRootNextAction(root)).toBe('Answer in Claude Desktop.');
    // The earlier question stays searchable by its own words.
    expect(matchesWorkAttentionSearch(root, { ...EMPTY_WORK_ATTENTION_SEARCH, query: 'collectors' })).toBe(true);
  });

  test('a handled request names the linked session’s completion and asks nothing', () => {
    const root = rootNamed('Release checklist');
    expect(workRootLastDecision(root)).toMatchObject({
      instantLabel: 'completed',
      text: 'Handled in a session started from it',
    });
    expect(workRootNextAction(root)).toBe('Nothing asked of you; the linked session’s outcome is in the detail.');
    expect(workFactSummary(root.facts[1]!, root)).toBe(
      'Linked session declared completed: The export test is stable again.',
    );
    expect(workFactSummary(root.facts[0]!, root)).toStartWith('Declared blocked:');
  });

  test('a request untouched for over a week is an older declaration, dated, still asked and searchable', () => {
    const dormant = rootNamed('Session distillation worker redaction');
    expect(dormant.attention).toBe('human-request');
    expect(workRootStanding(dormant)).toBe('reconsider');
    expect(workRootDormantNote(dormant)).toBe('no activity since');
    // Nothing later may have answered it: no "possibly answered" chip, the next action says why.
    expect(workRootFactChips(dormant).map((chip) => chip.label)).not.toContain('possibly answered');
    expect(workRootNextAction(dormant)).toBe(
      'Nothing happened in it for over 7 days; answer or archive the session in Claude Desktop to settle it.',
    );
    expect(matchesWorkAttentionSearch(dormant, { ...EMPTY_WORK_ATTENTION_SEARCH, query: 'redaction sample' })).toBe(
      true,
    );
    expect(matchesWorkAttentionSearch(dormant, { ...EMPTY_WORK_ATTENTION_SEARCH, attention: ['human-request'] })).toBe(
      true,
    );
    // A family with children may have been active after the question: the note only claims the week.
    expect(workRootDormantNote({ ...dormant, children: { ...dormant.children, count: 1 } })).toBe(
      'no activity in over 7 d',
    );
    expect(workRootDormantNote(rootNamed('Fix mobile navigation label overlap'))).toBeNull();
    expect(workRootDormantNote(rootNamed('Toolbar refresh'))).toBeNull();
  });
  test('the Needs you note names both reasons a declaration is set apart', () => {
    expect(WORK_ATTENTION_SECTIONS[0]?.note).toContain('nothing happened in their session for over 7 days');
  });
  test('an older declaration to reconsider says so in its chips and next action', () => {
    const root = rootNamed('Toolbar refresh');
    expect(workRootFactChips(root).map((chip) => chip.label)).toContain('work continued in a linked session');
    expect(workRootNextAction(root)).toBe(
      'Check what followed; answer or archive the session in Claude Desktop to settle it.',
    );
  });

  test('proposals an interpretation says are past are not counted as open', () => {
    const base = rootNamed('Fix mobile navigation label overlap');
    const open = (id: string): WorkRoot['facts'][number] => ({
      createdAt: null,
      id,
      kind: 'proposal',
      provenance: base.facts[0]!.provenance,
      resolution: 'open',
      suggestionId: id,
      title: id,
      tldr: null,
    });
    const root: WorkRoot = {
      ...base,
      facts: [open('p-old'), open('p-new')],
      interpretations: [
        { evidence: ['p-old'], kind: 'proposal-superseded', text: 'Superseded.', uncertainty: 'Unread.' },
      ],
    };
    expect([...workRootPastProposalIds(root)]).toEqual(['p-old']);
    expect(workRootFactChips(root).find((chip) => chip.id.endsWith(':proposals'))?.label).toBe(
      'proposals 1 open / 0 resolved / 1 no longer pending',
    );
  });

  test('a search over the ranking says what it did not search', () => {
    expect(workSearchCoverage(dataset, 2, true)).toBe(
      `2 of ${dataset.roots.length} roots match, searched among the ${dataset.roots.length} shown · not searched: 4 older roots hidden (30-day window) · 9 beyond the page limit.`,
    );
    expect(workSearchCoverage(dataset, dataset.roots.length, false)).toBe(
      `${dataset.roots.length} roots shown · 4 older roots hidden (30-day window) · 9 beyond the page limit.`,
    );
    const whole = {
      ...dataset,
      coverage: { ...dataset.coverage, window: { excludedRoots: 0, sinceDays: 30 } },
      totalRoots: dataset.roots.length,
    };
    expect(workSearchCoverage(whole, 0, true)).toBe(
      `0 of ${dataset.roots.length} roots match, searched among the ${dataset.roots.length} shown · nothing else was read.`,
    );
    expect(workSearchCoverage(whole, dataset.roots.length, false)).toBe(`${dataset.roots.length} roots shown.`);
    const bounded = {
      ...whole,
      coverage: {
        ...whole.coverage,
        desktopSessions: { ...whole.coverage.desktopSessions, sessionsRead: 500, sessionsStored: 750, truncated: true },
      },
    };
    expect(workSearchCoverage(bounded, 0, true)).toContain(
      'not searched: 250 older sessions without a wait (read bound).',
    );
    const listing = {
      ...whole,
      coverage: { ...whole.coverage, desktopSessions: { ...whole.coverage.desktopSessions, truncated: true } },
    };
    expect(workSearchCoverage(listing, 0, true)).toContain('not searched: sessions the registry listing left unread.');
  });
  test('the count line splits what was left out by the budget that left it out', () => {
    // The first live run: 59 roots shown, 11 behind the window, 49 Codex campaigns beyond the
    // 20-campaign Codex budget, none cut by the page limit. It once read "59 of 59 roots shown;
    // not shown: … 49 beyond the ranking limit".
    const codex = rootNamed('Build report UI');
    const desktop = roots.filter((root) => root.key.harness !== 'codex').slice(0, 2);
    const live = {
      coverage: {
        ...dataset.coverage,
        codexSessions: { campaignsInWindow: 69, campaignsRead: 20 },
        window: { excludedRoots: 11, sinceDays: 30 },
      },
      roots: [...desktop, ...Array.from({ length: 20 }, () => codex)],
      totalRoots: 2 + 11 + 69,
    };
    expect(workSearchCoverage(live, 22, false)).toBe(
      '22 roots shown · 11 older roots hidden (30-day window) · 49 Codex campaigns beyond the 20-campaign Codex budget.',
    );
    // The page limit cut five more roots: named apart from the Codex budget.
    expect(workSearchCoverage({ ...live, totalRoots: live.totalRoots + 5 }, 22, false)).toBe(
      '22 roots shown · 11 older roots hidden (30-day window) · 49 Codex campaigns beyond the 20-campaign Codex budget · 5 beyond the page limit.',
    );
    const one = {
      ...live,
      coverage: {
        ...live.coverage,
        codexSessions: { campaignsInWindow: 21, campaignsRead: 20 },
        window: { excludedRoots: 1, sinceDays: 30 },
      },
      totalRoots: 2 + 1 + 21,
    };
    expect(workSearchCoverage(one, 1, true)).toBe(
      '1 of 22 roots match, searched among the 22 shown · not searched: 1 older root hidden (30-day window) · 1 Codex campaign beyond the 20-campaign Codex budget.',
    );
  });
});
