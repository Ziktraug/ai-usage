import { describe, expect, test } from 'bun:test';
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
  workFilterOptions,
  workRootFactChips,
  workRootId,
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
    expect(needsYou.at(-1)?.title).toBe('Scan resource optimization');
    expect(needsYou.slice(0, -1).every((root) => !root.reconsidered)).toBe(true);
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
  test('the recent section is the only one that collapses, beyond ten rows', () => {
    expect(WORK_ATTENTION_SECTIONS.map((section) => section.collapseBeyond)).toEqual([null, null, null, 10]);
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
    expect(blocked.length).toBe(6);
    expect(blocked.every((root) => root.attention === 'human-request')).toBe(true);
    const codex = filterWorkRoots(roots, { ...EMPTY_WORK_ATTENTION_SEARCH, harness: ['codex'] });
    expect(codex.length).toBeGreaterThanOrEqual(3);
    expect(codex.every((root) => root.declared === null)).toBe(true);
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
  test('chips merge a declared and an observed pull request into one dated line', () => {
    const chips = workRootFactChips(rootNamed('Fix mobile navigation label overlap'));
    expect(chips.map((chip) => chip.label)).toEqual(['PR #71 checks pending', 'children 1']);
    const dirty = workRootFactChips(rootNamed('Recover Claude history'));
    expect(dirty.map((chip) => chip.label)).toEqual(['checkout dirty (3 modified)', 'children 2 · 1 blocked']);
    expect(dirty.map((chip) => chip.tone)).toEqual(['warn', 'warn']);
    const failed = workRootFactChips(rootNamed('Platform runtime review follow-ups'));
    expect(failed.map((chip) => chip.label)).toEqual(['PR #53 read failed (unauthenticated)']);
    const leads = workRootFactChips(rootNamed('Overview composition pass'));
    expect(leads.map((chip) => chip.label)).toEqual(['proposals 2 open / 1 resolved']);
  });
  test('facts group by their source in first-seen order', () => {
    const groups = groupWorkFactsBySource(rootNamed('Fix mobile navigation label overlap').facts);
    expect(groups.map((group) => group.source)).toEqual(['claude-desktop', 'github', 'local-checkout']);
  });
});
