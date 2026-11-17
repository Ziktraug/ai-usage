import { describe, expect, test } from 'bun:test';
import { type CanonicalInstant, parseCanonicalInstant } from '@ai-usage/report-core/canonical-instant';
import type { WorkThreadEvent } from '@ai-usage/report-core/work-thread';
import type {
  WorkThreadEpisode,
  WorkThreadFactEventKind,
  WorkThreadNativeRequest,
} from '@ai-usage/report-core/work-thread-view';
import {
  buildSessionCascade,
  CASCADE_BURST_WINDOW_MS,
  CASCADE_MAX_TICKS,
  CASCADE_MIN_AXIS_MS,
  CASCADE_STRETCH_GAP_MS,
  type CascadeBlock,
  type CascadeBurstNode,
  type CascadeHistoryEntry,
  type CascadeInterlude,
  type CascadeRow,
  type CascadeSessionNode,
  type CascadeStretch,
  cascadeMark,
  cascadeOffset,
  cascadeTitle,
  readsNoParent,
  type SessionCascadeInput,
  worstCascadeMark,
} from './work-session-cascade';
import { threadTime } from './work-thread-model';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const instant = (value: string): CanonicalInstant => parseCanonicalInstant(value);
const ms = (value: string): number => Date.parse(value);
const iso = (atMs: number): string => new Date(atMs).toISOString();

const request = (key: string, state: WorkThreadNativeRequest['state']): WorkThreadNativeRequest => ({
  answeredAt: null,
  askedAt: instant('2026-11-10T09:00:00.000Z'),
  callId: null,
  detail: 'Synthetic request.',
  evidence: 'codex-request-user-input',
  harness: 'codex',
  key,
  machineId: 'test',
  observedAt: instant('2026-11-10T09:00:00.000Z'),
  questionId: null,
  sessionKey: 'session',
  sourceSessionId: 'session',
  state,
  text: 'Choose the scope?',
});

/** An ended, parentless, childless session; `end` is `null` for a session with no observed end. */
const session = (
  id: string,
  start: string,
  end: string | null,
  overrides: Partial<WorkThreadEpisode> = {},
): WorkThreadEpisode => ({
  activeMs: null,
  children: [],
  endedAt: end === null ? null : instant(end),
  firstPrompt: null,
  harness: 'codex',
  lastInstruction: null,
  launchedBy: null,
  linkKey: id,
  machineId: 'test',
  nativeRequests: [],
  origin: 'human',
  projectLabel: null,
  question: null,
  result: null,
  resume: { kind: 'none', reason: 'Synthetic session.' },
  running: false,
  sourceSessionId: id,
  spanMs: null,
  startedAt: instant(start),
  title: null,
  ...overrides,
});

const launched = { harness: 'codex', title: 'Parent' } as const;

const threadEvent = (id: string, kind: WorkThreadEvent['kind'], at: string): CascadeHistoryEntry => ({
  at: instant(at),
  event: {
    acknowledgedRemainders: [],
    at: instant(at),
    eventId: id,
    fromState: null,
    kind,
    linkKey: null,
    reason: null,
    threadId: 'thread',
    toState: null,
  },
  id,
  kind: 'event',
});

const factEvent = (id: string, kind: WorkThreadFactEventKind, at: string): CascadeHistoryEntry => ({
  at: instant(at),
  event: {
    actor: null,
    at: instant(at),
    key: 'github.example/synthetic/shop#72',
    kind,
    label: 'PR #72',
    title: null,
  },
  id,
  kind: 'fact-event',
});

const cascade = (
  episodes: readonly WorkThreadEpisode[],
  overrides: Partial<Omit<SessionCascadeInput, 'episodes'>> = {},
): readonly CascadeBlock[] =>
  buildSessionCascade({
    episodes,
    events: [],
    newestFirst: false,
    nowMs: ms('2026-11-20T00:00:00.000Z'),
    timeZone: 'UTC',
    ...overrides,
  });

const stretchesOf = (blocks: readonly CascadeBlock[]): readonly CascadeStretch[] =>
  blocks.filter((block): block is CascadeStretch => block.kind === 'stretch');

const only = <Item>(items: readonly Item[]): Item => {
  const [first, ...others] = items;
  if (first === undefined || others.length > 0) {
    throw new Error(`Expected exactly one item, received ${items.length}.`);
  }
  return first;
};

const onlyStretch = (blocks: readonly CascadeBlock[]): CascadeStretch => {
  const block = only(blocks);
  if (block.kind !== 'stretch') {
    throw new Error(`Expected a stretch, received ${block.kind}.`);
  }
  return block;
};

const asSession = (row: CascadeRow | undefined): CascadeSessionNode => {
  if (row?.kind !== 'session') {
    throw new Error(`Expected a session row, received ${row?.kind}.`);
  }
  return row;
};

const asBurst = (row: CascadeRow | undefined): CascadeBurstNode => {
  if (row?.kind !== 'burst') {
    throw new Error(`Expected a burst row, received ${row?.kind}.`);
  }
  return row;
};

const asInterlude = (block: CascadeBlock | undefined): CascadeInterlude => {
  if (block?.kind !== 'interlude') {
    throw new Error(`Expected an interlude, received ${block?.kind}.`);
  }
  return block;
};

const ids = (items: readonly { readonly id: string }[]): readonly string[] => items.map((item) => item.id);
const tickTimes = (stretch: CascadeStretch, timeZone: string): readonly string[] =>
  stretch.axis.ticks.map((tick) => threadTime(iso(tick), timeZone));

describe('cascadeTitle', () => {
  const claudeId = '2b736a39-4c2c-4f6e-9a1b-0123456789ab';

  test('keeps a real title and takes the fingerprint from the session id', () => {
    expect(
      cascadeTitle({ firstPrompt: 'Ignored', sourceSessionId: claudeId, title: 'Stabilise the collector' }),
    ).toEqual({ fingerprint: '2b736a39', source: 'title', text: 'Stabilise the collector' });
  });

  test('a title that merely contains a harness word stays a title', () => {
    expect(cascadeTitle({ firstPrompt: null, sourceSessionId: claudeId, title: 'Fix claude collector' })).toEqual({
      fingerprint: '2b736a39',
      source: 'title',
      text: 'Fix claude collector',
    });
  });

  test('a label restating the harness and the id names nothing', () => {
    expect(cascadeTitle({ firstPrompt: null, sourceSessionId: claudeId, title: 'claude 2b736a39' })).toEqual({
      fingerprint: '2b736a39',
      source: 'none',
      text: null,
    });
    expect(
      cascadeTitle({ firstPrompt: null, sourceSessionId: 'agent-aa82ebb6149609a2d', title: 'subagent agent-aa' }),
    ).toEqual({ fingerprint: 'agent-aa82ebb6', source: 'none', text: null });
  });

  test('two sub-agents sharing the agent prefix keep distinct fingerprints', () => {
    const fingerprintOf = (sourceSessionId: string): string =>
      cascadeTitle({ firstPrompt: null, sourceSessionId, title: null }).fingerprint;
    expect(fingerprintOf('agent-aa82ebb6149609a2d')).not.toBe(fingerprintOf('agent-aa17c0de55aa01b2c'));
  });

  test('a generic title falls back to the first non-empty line of the first prompt', () => {
    expect(
      cascadeTitle({
        firstPrompt: '\n   \n  Investigate   the stale\tstore  \nThen report back.',
        sourceSessionId: claudeId,
        title: 'claude 2b736a39',
      }),
    ).toEqual({ fingerprint: '2b736a39', source: 'first-prompt', text: 'Investigate the stale store' });
    expect(cascadeTitle({ firstPrompt: 'Review the diff', sourceSessionId: claudeId, title: null })).toEqual({
      fingerprint: '2b736a39',
      source: 'first-prompt',
      text: 'Review the diff',
    });
  });

  test('long text is cut to 120 characters with an ellipsis', () => {
    const long = cascadeTitle({ firstPrompt: 'x'.repeat(200), sourceSessionId: claudeId, title: null });
    expect(long.text).toBe(`${'x'.repeat(119)}…`);
    expect(long.text).toHaveLength(120);
    const title = cascadeTitle({
      firstPrompt: null,
      sourceSessionId: claudeId,
      title: `${'word '.repeat(40)}\nsecond line`,
    });
    expect(title.source).toBe('title');
    expect(title.text?.length).toBeLessThanOrEqual(120);
    expect(title.text?.endsWith('word…')).toBe(true);
    expect(cascadeTitle({ firstPrompt: 'y'.repeat(120), sourceSessionId: claudeId, title: null }).text).toBe(
      'y'.repeat(120),
    );
  });

  test('no title and no prompt leave the fingerprint alone', () => {
    expect(cascadeTitle({ firstPrompt: null, sourceSessionId: claudeId, title: null })).toEqual({
      fingerprint: '2b736a39',
      source: 'none',
      text: null,
    });
    expect(cascadeTitle({ firstPrompt: ' \n ', sourceSessionId: 'short', title: '  ' })).toEqual({
      fingerprint: 'short',
      source: 'none',
      text: null,
    });
  });
});

describe('cascade marks', () => {
  const ended = instant('2026-11-10T10:00:00.000Z');

  test('a session is marked by its most pressing own evidence', () => {
    expect(
      cascadeMark({
        endedAt: ended,
        nativeRequests: [request('a', 'uncertain'), request('b', 'open')],
        running: true,
      }),
    ).toBe('asks');
    expect(cascadeMark({ endedAt: ended, nativeRequests: [request('a', 'uncertain')], running: true })).toBe('unclear');
    expect(cascadeMark({ endedAt: null, nativeRequests: [request('a', 'answered')], running: true })).toBe('running');
    expect(cascadeMark({ endedAt: null, nativeRequests: [request('a', 'withdrawn')], running: false })).toBe(
      'open-ended',
    );
    expect(cascadeMark({ endedAt: null, nativeRequests: [], running: null })).toBe('open-ended');
    expect(cascadeMark({ endedAt: ended, nativeRequests: [], running: false })).toBe('quiet');
  });

  test('the worst mark follows asks > unclear > running > open-ended > quiet', () => {
    expect(worstCascadeMark(['quiet', 'open-ended', 'running', 'unclear', 'asks'])).toBe('asks');
    expect(worstCascadeMark(['quiet', 'open-ended', 'running', 'unclear'])).toBe('unclear');
    expect(worstCascadeMark(['quiet', 'running', 'open-ended'])).toBe('running');
    expect(worstCascadeMark(['quiet', 'open-ended', 'quiet'])).toBe('open-ended');
    expect(worstCascadeMark(['quiet'])).toBe('quiet');
    expect(worstCascadeMark([])).toBeNull();
  });
});

describe('session nodes', () => {
  const nowMs = ms('2026-11-10T10:50:00.000Z');
  const grandchild = session('grandchild', '2026-11-10T10:06:00.000Z', null, {
    launchedBy: launched,
    nativeRequests: [request('open', 'open')],
  });
  const firstChild = session('child-a', '2026-11-10T10:05:00.000Z', '2026-11-10T10:15:00.000Z', {
    children: [grandchild],
    launchedBy: launched,
  });
  const runningChild = session('child-b', '2026-11-10T10:20:00.000Z', null, {
    launchedBy: launched,
    running: true,
    // A stored span never replaces the computed one.
    spanMs: 5 * HOUR,
  });
  const parent = session('parent', '2026-11-10T10:00:00.000Z', '2026-11-10T10:30:00.000Z', {
    children: [runningChild, firstChild],
    title: 'Rework the reader',
  });

  test('nests declared children recursively and totals every descendant', () => {
    const stretch = onlyStretch(cascade([parent], { nowMs }));
    const node = asSession(only(stretch.rows));

    expect(node.id).toBe('parent');
    expect(node.episode).toBe(parent);
    expect(node.title).toEqual({ fingerprint: 'parent', source: 'title', text: 'Rework the reader' });
    expect(node.startMs).toBe(ms('2026-11-10T10:00:00.000Z'));
    expect(node.endMs).toBe(ms('2026-11-10T10:30:00.000Z'));
    expect(node.mark).toBe('quiet');
    expect(node.childrenMark).toBe('asks');
    expect(node.descendants).toEqual({
      count: 3,
      endMs: nowMs,
      spanMs: 10 * MINUTE + 30 * MINUTE,
      startMs: ms('2026-11-10T10:05:00.000Z'),
      unknownSpans: 1,
    });
    expect(ids(node.children)).toEqual(['child-a', 'child-b']);

    const [first, second] = node.children;
    expect(first?.mark).toBe('quiet');
    expect(first?.childrenMark).toBe('asks');
    expect(first?.descendants).toEqual({
      count: 1,
      endMs: null,
      spanMs: null,
      startMs: ms('2026-11-10T10:06:00.000Z'),
      unknownSpans: 1,
    });
    expect(first?.children[0]?.id).toBe('grandchild');
    expect(first?.children[0]?.mark).toBe('asks');
    expect(first?.children[0]?.endMs).toBeNull();
    expect(first?.children[0]?.descendants).toBeNull();
    expect(first?.children[0]?.childrenMark).toBeNull();

    expect(second?.mark).toBe('running');
    expect(second?.endMs).toBe(nowMs);
    expect(second?.descendants).toBeNull();
    expect(second?.childrenMark).toBeNull();
  });

  test('the stretch reaches the latest descendant and takes the most pressing mark at any depth', () => {
    const stretch = onlyStretch(cascade([parent], { nowMs }));
    expect(stretch.startMs).toBe(ms('2026-11-10T10:00:00.000Z'));
    expect(stretch.endMs).toBe(nowMs);
    expect(stretch.mark).toBe('asks');
    expect(stretch.sessionCount).toBe(1);
    expect(stretch.childCount).toBe(3);
  });

  test('an end is unknown when the session neither ended nor runs, or when it precedes the start', () => {
    const open = session('open', '2026-11-10T10:00:00.000Z', null);
    const undeclared = session('undeclared', '2026-11-10T10:01:30.000Z', null, { running: null });
    const reversed = session('reversed', '2026-11-10T10:03:00.000Z', '2026-11-10T09:00:00.000Z');
    const stretch = onlyStretch(cascade([open, undeclared, reversed], { nowMs }));
    expect(stretch.rows.map((row) => [row.id, row.endMs])).toEqual([
      ['open', null],
      ['undeclared', null],
      ['reversed', null],
    ]);
    expect(asSession(stretch.rows[2]).mark).toBe('quiet');
    expect(stretch.endMs).toBe(ms('2026-11-10T10:03:00.000Z'));
  });

  test('children starting together are ordered by id', () => {
    const root = session('root', '2026-11-10T10:00:00.000Z', '2026-11-10T10:30:00.000Z', {
      children: ['c', 'a', 'b'].map((id) =>
        session(id, '2026-11-10T10:05:00.000Z', '2026-11-10T10:06:00.000Z', { launchedBy: launched }),
      ),
    });
    expect(ids(asSession(only(onlyStretch(cascade([root])).rows)).children)).toEqual(['a', 'b', 'c']);
    expect(ids(asSession(only(onlyStretch(cascade([root], { newestFirst: true })).rows)).children)).toEqual([
      'c',
      'b',
      'a',
    ]);
  });
});

describe('bursts', () => {
  test('parentless sessions starting within the window of the first form one burst', () => {
    const roots = [
      session('d', '2026-11-10T09:01:00.000Z', '2026-11-10T09:05:00.000Z'),
      session('b', '2026-11-10T09:00:05.000Z', '2026-11-10T09:05:00.000Z'),
      session('a', '2026-11-10T09:00:00.000Z', '2026-11-10T09:05:00.000Z'),
      session('c', '2026-11-10T09:00:30.000Z', '2026-11-10T09:05:00.000Z'),
      session('straggler', '2026-11-10T09:01:01.000Z', '2026-11-10T09:05:00.000Z'),
    ];
    const stretch = onlyStretch(cascade(roots));
    expect(ids(stretch.rows)).toEqual(['burst:a', 'straggler']);
    const burst = asBurst(stretch.rows[0]);
    expect(ids(burst.members)).toEqual(['a', 'b', 'c', 'd']);
    expect(burst.startMs).toBe(ms('2026-11-10T09:00:00.000Z'));
    expect(ms('2026-11-10T09:01:00.000Z') - burst.startMs).toBe(CASCADE_BURST_WINDOW_MS);
    expect(asSession(stretch.rows[1]).id).toBe('straggler');
    expect(stretch.sessionCount).toBe(5);
  });

  test('four sessions at the same minute are one burst named after the first id', () => {
    const roots = ['delta', 'bravo', 'alpha', 'charlie'].map((id) =>
      session(id, '2026-11-10T09:00:00.000Z', '2026-11-10T09:10:00.000Z'),
    );
    const burst = asBurst(only(onlyStretch(cascade(roots)).rows));
    expect(burst.id).toBe('burst:alpha');
    expect(ids(burst.members)).toEqual(['alpha', 'bravo', 'charlie', 'delta']);
    expect(ids(asBurst(only(onlyStretch(cascade(roots, { newestFirst: true })).rows)).members)).toEqual([
      'delta',
      'charlie',
      'bravo',
      'alpha',
    ]);
  });

  test('the window is measured from the first member, not from the previous one', () => {
    const roots = [
      session('a', '2026-11-10T09:00:00.000Z', '2026-11-10T09:05:00.000Z'),
      session('b', '2026-11-10T09:00:40.000Z', '2026-11-10T09:05:00.000Z'),
      session('c', '2026-11-10T09:01:20.000Z', '2026-11-10T09:05:00.000Z'),
      session('d', '2026-11-10T09:01:50.000Z', '2026-11-10T09:05:00.000Z'),
    ];
    const rows = onlyStretch(cascade(roots)).rows;
    expect(ids(rows)).toEqual(['burst:a', 'burst:c']);
    expect(ids(asBurst(rows[1]).members)).toEqual(['c', 'd']);
  });

  test('a session with a declared parent is never a member and ends the run', () => {
    const at = (second: string): string => `2026-11-10T09:00:${second}.000Z`;
    const end = '2026-11-10T09:05:00.000Z';
    const delegated = session('x', at('20'), end, { launchedBy: launched });
    const split = onlyStretch(
      cascade([
        session('a', at('00'), end),
        session('b', at('10'), end),
        delegated,
        session('c', at('30'), end),
        session('d', at('40'), end),
      ]),
    );
    expect(ids(split.rows)).toEqual(['burst:a', 'x', 'burst:c']);
    expect(ids(asBurst(split.rows[0]).members)).toEqual(['a', 'b']);
    expect(ids(asBurst(split.rows[2]).members)).toEqual(['c', 'd']);

    const alone = onlyStretch(cascade([session('a', at('00'), end), delegated, session('c', at('30'), end)]));
    expect(alone.rows.map((row) => row.kind)).toEqual(['session', 'session', 'session']);
    expect(ids(alone.rows)).toEqual(['a', 'x', 'c']);

    const delegatedOnly = onlyStretch(
      cascade([delegated, session('y', at('21'), end, { launchedBy: launched }), session('z', at('22'), end)]),
    );
    expect(delegatedOnly.rows.map((row) => row.kind)).toEqual(['session', 'session', 'session']);
  });

  test('a delegated session whose parent was not read declares a lineage and never joins a burst', () => {
    const rows = onlyStretch(
      cascade([
        session('a', '2026-11-10T09:00:00.000Z', '2026-11-10T09:10:00.000Z', { origin: 'delegated' }),
        session('b', '2026-11-10T09:00:10.000Z', '2026-11-10T09:10:00.000Z', { origin: 'delegated' }),
        session('c', '2026-11-10T09:00:20.000Z', '2026-11-10T09:10:00.000Z', { origin: null }),
        session('d', '2026-11-10T09:00:30.000Z', '2026-11-10T09:10:00.000Z', { origin: 'automated-review' }),
      ]),
    ).rows;
    expect(rows.map((row) => row.kind)).toEqual(['session', 'session', 'burst']);
    expect(ids(asBurst(rows[2]).members)).toEqual(['c', 'd']);
    expect(readsNoParent({ launchedBy: null, origin: 'delegated' })).toBe(false);
    expect(readsNoParent({ launchedBy: launched, origin: 'human' })).toBe(false);
    expect(readsNoParent({ launchedBy: null, origin: null })).toBe(true);
  });

  test('a single session is not a burst', () => {
    const stretch = onlyStretch(cascade([session('a', '2026-11-10T09:00:00.000Z', '2026-11-10T09:05:00.000Z')]));
    expect(asSession(only(stretch.rows)).id).toBe('a');
  });

  test('a burst summarises its members and reaches their descendants', () => {
    const asking = session('asking', '2026-11-10T09:02:00.000Z', '2026-11-10T09:40:00.000Z', {
      launchedBy: launched,
      nativeRequests: [request('open', 'open')],
    });
    const roots = [
      session('a', '2026-11-10T09:00:00.000Z', '2026-11-10T09:10:00.000Z'),
      session('b', '2026-11-10T09:00:20.000Z', null, { children: [asking] }),
      session('c', '2026-11-10T09:00:40.000Z', '2026-11-10T09:20:00.000Z'),
    ];
    const stretch = onlyStretch(cascade(roots));
    const burst = asBurst(only(stretch.rows));
    expect(burst.summary).toEqual({
      count: 3,
      endMs: ms('2026-11-10T09:20:00.000Z'),
      spanMs: 10 * MINUTE + (20 * MINUTE - 40 * SECOND),
      startMs: ms('2026-11-10T09:00:00.000Z'),
      unknownSpans: 1,
    });
    expect(burst.endMs).toBe(ms('2026-11-10T09:40:00.000Z'));
    expect(burst.mark).toBe('asks');
    expect(burst.members.map((member) => member.mark)).toEqual(['quiet', 'open-ended', 'quiet']);
    expect(stretch.endMs).toBe(ms('2026-11-10T09:40:00.000Z'));
    expect(stretch.sessionCount).toBe(3);
    expect(stretch.childCount).toBe(1);

    const unknown = asBurst(
      only(
        onlyStretch(
          cascade([
            session('a', '2026-11-10T09:00:00.000Z', null),
            session('b', '2026-11-10T09:00:20.000Z', null, { running: null }),
          ]),
        ).rows,
      ),
    );
    expect(unknown.endMs).toBeNull();
    expect(unknown.mark).toBe('open-ended');
    expect(unknown.summary).toEqual({
      count: 2,
      endMs: null,
      spanMs: null,
      startMs: ms('2026-11-10T09:00:00.000Z'),
      unknownSpans: 2,
    });
  });
});

describe('stretches', () => {
  test('a gap shorter than the limit joins, the exact limit splits', () => {
    const first = session('first', '2026-11-10T09:00:00.000Z', '2026-11-10T10:00:00.000Z');
    const joined = cascade([first, session('second', '2026-11-10T10:44:00.000Z', '2026-11-10T11:00:00.000Z')]);
    expect(ids(onlyStretch(joined).rows)).toEqual(['first', 'second']);
    expect(onlyStretch(joined).endMs).toBe(ms('2026-11-10T11:00:00.000Z'));

    const split = cascade([first, session('second', '2026-11-10T10:45:00.000Z', '2026-11-10T11:00:00.000Z')]);
    expect(ms('2026-11-10T10:45:00.000Z') - ms('2026-11-10T10:00:00.000Z')).toBe(CASCADE_STRETCH_GAP_MS);
    expect(split.map((block) => block.kind)).toEqual(['stretch', 'stretch']);
    expect(ids(split)).toEqual(['stretch:2026-11-10T09:00:00.000Z', 'stretch:2026-11-10T10:45:00.000Z']);
    expect(stretchesOf(split).map((stretch) => ids(stretch.rows))).toEqual([['first'], ['second']]);
  });

  test('a long session keeps later short ones in its stretch', () => {
    const blocks = cascade([
      session('long', '2026-11-10T09:00:00.000Z', '2026-11-10T14:00:00.000Z'),
      session('early', '2026-11-10T09:30:00.000Z', '2026-11-10T09:40:00.000Z'),
      session('late', '2026-11-10T13:00:00.000Z', '2026-11-10T13:10:00.000Z'),
      session('after', '2026-11-10T14:30:00.000Z', '2026-11-10T14:35:00.000Z'),
      session('next', '2026-11-10T15:20:00.000Z', '2026-11-10T15:30:00.000Z'),
    ]);
    expect(stretchesOf(blocks).map((stretch) => ids(stretch.rows))).toEqual([
      ['long', 'early', 'late', 'after'],
      ['next'],
    ]);
    expect(stretchesOf(blocks)[0]?.endMs).toBe(ms('2026-11-10T14:35:00.000Z'));
  });

  test('a descendant ending later extends its row', () => {
    const child = session('child', '2026-11-10T09:10:00.000Z', '2026-11-10T11:00:00.000Z', { launchedBy: launched });
    const blocks = cascade([
      session('parent', '2026-11-10T09:00:00.000Z', '2026-11-10T09:30:00.000Z', { children: [child] }),
      session('later', '2026-11-10T11:30:00.000Z', '2026-11-10T11:40:00.000Z'),
    ]);
    expect(ids(onlyStretch(blocks).rows)).toEqual(['parent', 'later']);
  });

  test('a late child with no observed end still extends its row to where it is drawn', () => {
    const stretch = onlyStretch(
      cascade([
        session('parent', '2026-11-10T09:00:00.000Z', null, {
          children: [session('child', '2026-11-10T12:00:00.000Z', null, { launchedBy: launched })],
        }),
        session('next', '2026-11-10T12:10:00.000Z', '2026-11-10T12:20:00.000Z'),
      ]),
    );
    expect(ids(stretch.rows)).toEqual(['parent', 'next']);
    expect(stretch.axis.endMs).toBeGreaterThanOrEqual(ms('2026-11-10T12:20:00.000Z'));
    expect(cascadeOffset(stretch.axis, ms('2026-11-10T12:00:00.000Z'))).toBeLessThan(1);
  });

  test('a session with no observed end is an instant', () => {
    const open = session('open', '2026-11-10T09:00:00.000Z', null);
    const joined = cascade([open, session('second', '2026-11-10T09:44:00.000Z', '2026-11-10T09:50:00.000Z')]);
    expect(ids(onlyStretch(joined).rows)).toEqual(['open', 'second']);

    const split = cascade([open, session('second', '2026-11-10T09:45:00.000Z', '2026-11-10T09:50:00.000Z')]);
    expect(stretchesOf(split)).toHaveLength(2);
    const [first] = stretchesOf(split);
    expect(first?.startMs).toBe(ms('2026-11-10T09:00:00.000Z'));
    expect(first?.endMs).toBe(ms('2026-11-10T09:00:00.000Z'));
    expect(first?.mark).toBe('open-ended');
  });

  test('counts top-level sessions and every descendant below them', () => {
    const grandchild = session('grandchild', '2026-11-10T09:12:00.000Z', '2026-11-10T09:13:00.000Z', {
      launchedBy: launched,
    });
    const children = [
      session('child-a', '2026-11-10T09:11:00.000Z', '2026-11-10T09:14:00.000Z', {
        children: [grandchild],
        launchedBy: launched,
      }),
      session('child-b', '2026-11-10T09:15:00.000Z', '2026-11-10T09:16:00.000Z', { launchedBy: launched }),
    ];
    const stretch = onlyStretch(
      cascade([
        session('a', '2026-11-10T09:00:00.000Z', '2026-11-10T09:05:00.000Z'),
        session('b', '2026-11-10T09:00:30.000Z', '2026-11-10T09:05:00.000Z'),
        session('c', '2026-11-10T09:10:00.000Z', '2026-11-10T09:20:00.000Z', { children }),
      ]),
    );
    expect(ids(stretch.rows)).toEqual(['burst:a', 'c']);
    expect(stretch.sessionCount).toBe(3);
    expect(stretch.childCount).toBe(3);
    expect(stretch.mark).toBe('quiet');
    expect(stretch.kind).toBe('stretch');
  });

  test('day keys follow the local calendar across midnight', () => {
    const overnight = [session('night', '2026-11-10T22:30:00.000Z', '2026-11-10T23:30:00.000Z')];
    expect(onlyStretch(cascade(overnight, { timeZone: 'Europe/Paris' })).dayKeys).toEqual(['2026-11-10', '2026-11-11']);
    expect(onlyStretch(cascade(overnight, { timeZone: 'UTC' })).dayKeys).toEqual(['2026-11-10']);

    const days = [session('days', '2026-10-24T22:30:00.000Z', '2026-10-27T08:00:00.000Z')];
    // Paris leaves daylight saving on 2026-10-25: the intermediate days are calendar days, not 24 h slices.
    expect(onlyStretch(cascade(days, { timeZone: 'Europe/Paris' })).dayKeys).toEqual([
      '2026-10-25',
      '2026-10-26',
      '2026-10-27',
    ]);
  });
});

describe('the axis', () => {
  const axisOf = (start: string, end: string | null, timeZone = 'UTC') =>
    onlyStretch(cascade([session('one', start, end)], { timeZone })).axis;

  test('picks the smallest step that fits the tick budget', () => {
    const short = axisOf('2026-11-10T09:10:00.000Z', '2026-11-10T09:50:00.000Z');
    expect(short.stepMs).toBe(15 * MINUTE);
    expect([iso(short.startMs), iso(short.endMs)]).toEqual(['2026-11-10T09:00:00.000Z', '2026-11-10T10:15:00.000Z']);
    expect(short.ticks.map(iso)).toEqual([
      '2026-11-10T09:00:00.000Z',
      '2026-11-10T09:15:00.000Z',
      '2026-11-10T09:30:00.000Z',
      '2026-11-10T09:45:00.000Z',
      '2026-11-10T10:00:00.000Z',
      '2026-11-10T10:15:00.000Z',
    ]);

    const fiveHours = axisOf('2026-11-10T09:10:00.000Z', '2026-11-10T14:10:00.000Z');
    expect(fiveHours.stepMs).toBe(30 * MINUTE);
    expect([iso(fiveHours.startMs), iso(fiveHours.endMs)]).toEqual([
      '2026-11-10T09:00:00.000Z',
      '2026-11-10T14:30:00.000Z',
    ]);
    expect(fiveHours.ticks).toHaveLength(CASCADE_MAX_TICKS);

    const thirtyOneHours = axisOf('2026-11-10T09:10:00.000Z', '2026-11-11T16:10:00.000Z');
    expect(thirtyOneHours.stepMs).toBe(3 * HOUR);
    expect([iso(thirtyOneHours.startMs), iso(thirtyOneHours.endMs)]).toEqual([
      '2026-11-10T09:00:00.000Z',
      '2026-11-11T18:00:00.000Z',
    ]);
    expect(thirtyOneHours.ticks).toHaveLength(12);

    const nineDays = axisOf('2026-11-01T09:10:00.000Z', '2026-11-10T09:10:00.000Z');
    expect(nineDays.stepMs).toBe(DAY);
    expect([iso(nineDays.startMs), iso(nineDays.endMs)]).toEqual([
      '2026-11-01T00:00:00.000Z',
      '2026-11-11T00:00:00.000Z',
    ]);
    expect(nineDays.ticks).toHaveLength(11);
  });

  test('every tick is one step after the previous one and the end is a tick', () => {
    for (const end of ['2026-11-10T09:50:00.000Z', '2026-11-10T14:10:00.000Z', '2026-11-13T02:00:00.000Z']) {
      const start = '2026-11-10T09:10:00.000Z';
      const axis = axisOf(start, end);
      const neededEndMs = Math.max(ms(end), ms(start) + CASCADE_MIN_AXIS_MS);
      expect(axis.ticks[0]).toBe(axis.startMs);
      expect(axis.ticks.at(-1)).toBe(axis.endMs);
      expect(axis.ticks.slice(1).map((tick, index) => tick - (axis.ticks[index] ?? Number.NaN))).toEqual(
        axis.ticks.slice(1).map(() => axis.stepMs),
      );
      expect(axis.ticks.length).toBeLessThanOrEqual(CASCADE_MAX_TICKS);
      expect(axis.startMs).toBeLessThanOrEqual(ms(start));
      expect(axis.startMs + axis.stepMs).toBeGreaterThan(ms(start));
      // The end is the first tick at or past the needed end, never one step further.
      expect(axis.endMs).toBeGreaterThanOrEqual(neededEndMs);
      expect(axis.endMs - axis.stepMs).toBeLessThan(neededEndMs);
    }
  });

  test('an end already on a tick is the last tick', () => {
    const axis = axisOf('2026-11-10T09:00:00.000Z', '2026-11-10T10:00:00.000Z');
    expect([iso(axis.startMs), iso(axis.endMs), axis.stepMs]).toEqual([
      '2026-11-10T09:00:00.000Z',
      '2026-11-10T10:00:00.000Z',
      15 * MINUTE,
    ]);
    expect(axis.ticks).toHaveLength(5);
  });

  test('past the listed steps the widest one doubles, so the tick budget always holds', () => {
    const months = axisOf('2026-01-05T09:10:00.000Z', '2026-06-01T09:10:00.000Z');
    expect(months.stepMs).toBe(14 * DAY);
    expect(iso(months.startMs)).toBe('2026-01-05T00:00:00.000Z');
    expect(months.ticks.length).toBeLessThanOrEqual(CASCADE_MAX_TICKS);
    expect(months.endMs).toBeGreaterThanOrEqual(ms('2026-06-01T09:10:00.000Z'));
    const years = axisOf('2023-01-05T09:10:00.000Z', '2026-06-01T09:10:00.000Z');
    expect(years.ticks.length).toBeLessThanOrEqual(CASCADE_MAX_TICKS);
    expect(years.endMs).toBeGreaterThanOrEqual(ms('2026-06-01T09:10:00.000Z'));
  });

  test('ticks sit on local-time boundaries in Europe/Paris', () => {
    const stretch = onlyStretch(
      cascade([session('one', '2026-11-10T09:10:00.000Z', '2026-11-12T21:10:00.000Z')], { timeZone: 'Europe/Paris' }),
    );
    expect(stretch.axis.stepMs).toBe(6 * HOUR);
    // 10:10 in Paris floors to 06:00 in Paris, which is 05:00 UTC.
    expect(iso(stretch.axis.startMs)).toBe('2026-11-10T05:00:00.000Z');
    expect(iso(stretch.axis.endMs)).toBe('2026-11-12T23:00:00.000Z');
    expect(tickTimes(stretch, 'Europe/Paris')).toEqual([
      '06:00',
      '12:00',
      '18:00',
      '00:00',
      '06:00',
      '12:00',
      '18:00',
      '00:00',
      '06:00',
      '12:00',
      '18:00',
      '00:00',
    ]);

    const hourly = onlyStretch(
      cascade([session('one', '2026-11-10T23:10:00.000Z', '2026-11-11T05:10:00.000Z')], { timeZone: 'Europe/Paris' }),
    );
    expect(hourly.axis.stepMs).toBe(HOUR);
    // 00:10 in Paris on the 11th: the first tick is that local midnight.
    expect(tickTimes(hourly, 'Europe/Paris')).toEqual([
      '00:00',
      '01:00',
      '02:00',
      '03:00',
      '04:00',
      '05:00',
      '06:00',
      '07:00',
    ]);
  });

  test('ticks sit on local-time boundaries in a zone with a half-hour offset', () => {
    const stretch = onlyStretch(
      cascade([session('one', '2026-11-10T09:10:00.000Z', '2026-11-10T15:10:00.000Z')], { timeZone: 'Asia/Kolkata' }),
    );
    expect(stretch.axis.stepMs).toBe(HOUR);
    // 14:40 in Kolkata floors to 14:00 in Kolkata, which is 08:30 UTC.
    expect(iso(stretch.axis.startMs)).toBe('2026-11-10T08:30:00.000Z');
    expect(tickTimes(stretch, 'Asia/Kolkata')).toEqual([
      '14:00',
      '15:00',
      '16:00',
      '17:00',
      '18:00',
      '19:00',
      '20:00',
      '21:00',
    ]);

    const daily = onlyStretch(
      cascade([session('one', '2026-11-01T09:10:00.000Z', '2026-11-10T09:10:00.000Z')], { timeZone: 'Asia/Kolkata' }),
    );
    expect(daily.axis.stepMs).toBe(DAY);
    expect(iso(daily.axis.startMs)).toBe('2026-10-31T18:30:00.000Z');
    expect(new Set(tickTimes(daily, 'Asia/Kolkata'))).toEqual(new Set(['00:00']));
  });

  test('a short or instantaneous stretch still covers the minimum length', () => {
    const instantAxis = axisOf('2026-11-10T09:10:00.000Z', null);
    expect(instantAxis.stepMs).toBe(15 * MINUTE);
    expect([iso(instantAxis.startMs), iso(instantAxis.endMs)]).toEqual([
      '2026-11-10T09:00:00.000Z',
      '2026-11-10T10:15:00.000Z',
    ]);
    expect(instantAxis.endMs - ms('2026-11-10T09:10:00.000Z')).toBeGreaterThanOrEqual(CASCADE_MIN_AXIS_MS);

    const aligned = axisOf('2026-11-10T09:00:00.000Z', '2026-11-10T09:05:00.000Z');
    expect(aligned.endMs - aligned.startMs).toBe(CASCADE_MIN_AXIS_MS);
    expect(aligned.ticks).toHaveLength(5);
  });

  test('cascadeOffset places an instant on the axis and clamps outside it', () => {
    const axis = { endMs: 3000, startMs: 1000 };
    expect(cascadeOffset(axis, 1000)).toBe(0);
    expect(cascadeOffset(axis, 1500)).toBe(0.25);
    expect(cascadeOffset(axis, 3000)).toBe(1);
    expect(cascadeOffset(axis, 500)).toBe(0);
    expect(cascadeOffset(axis, 9000)).toBe(1);
  });
});

describe('milestones and interludes', () => {
  // Axes: 09:00–10:00 and 13:00–14:00 (UTC, 15 min steps).
  const episodes = [
    session('morning', '2026-11-10T09:00:00.000Z', '2026-11-10T10:00:00.000Z'),
    session('afternoon', '2026-11-10T13:00:00.000Z', '2026-11-10T14:00:00.000Z'),
  ];
  const events = [
    threadEvent('after-note', 'note', '2026-11-10T15:00:00.000Z'),
    threadEvent('inside-note', 'note', '2026-11-10T09:40:00.000Z'),
    factEvent('pr-opened', 'pull-request-opened', '2026-11-10T09:30:00.000Z'),
    threadEvent('between-linked', 'link-added', '2026-11-10T11:30:00.000Z'),
    threadEvent('between-waiting', 'follow-state', '2026-11-10T11:00:00.000Z'),
    threadEvent('before-renamed', 'renamed', '2026-11-10T08:00:00.000Z'),
    threadEvent('created', 'created', '2026-11-10T07:50:00.000Z'),
    factEvent('pr-merged', 'pull-request-merged', '2026-11-10T14:00:00.000Z'),
  ];

  test('events inside an axis are milestones; the others form interludes at their place', () => {
    const blocks = cascade(episodes, { events });
    expect(blocks.map((block) => [block.kind, block.id, ids(block.milestones)])).toEqual([
      ['interlude', 'interlude:created', ['created', 'before-renamed']],
      ['stretch', 'stretch:2026-11-10T09:00:00.000Z', ['pr-opened', 'inside-note']],
      ['interlude', 'interlude:between-waiting', ['between-waiting', 'between-linked']],
      ['stretch', 'stretch:2026-11-10T13:00:00.000Z', ['pr-merged']],
      ['interlude', 'interlude:after-note', ['after-note']],
    ]);
  });

  test('pull request facts, the creation and follow-state changes cut; other events do not', () => {
    const milestones = cascade(episodes, { events }).flatMap((block) => block.milestones);
    expect(Object.fromEntries(milestones.map((milestone) => [milestone.id, milestone.cuts]))).toEqual({
      'after-note': false,
      'before-renamed': false,
      'between-linked': false,
      'between-waiting': true,
      created: true,
      'inside-note': false,
      'pr-merged': true,
      'pr-opened': true,
    });
    const opened = milestones.find((milestone) => milestone.id === 'pr-opened');
    expect(opened?.atMs).toBe(ms('2026-11-10T09:30:00.000Z'));
    expect(opened?.entry).toBe(events[2]);

    const kinds = [
      'link-detached',
      'wait-satisfied',
      'combined',
      'separated',
    ] as const satisfies readonly WorkThreadEvent['kind'][];
    const others = cascade(episodes, {
      events: kinds.map((kind, index) => threadEvent(kind, kind, `2026-11-10T09:1${index}:00.000Z`)),
    });
    expect(stretchesOf(others)[0]?.milestones.map((milestone) => milestone.cuts)).toEqual([false, false, false, false]);
  });

  test('both ends of the axis are inside it, and equal instants are ordered by id', () => {
    const blocks = cascade([session('morning', '2026-11-10T09:10:00.000Z', '2026-11-10T09:50:00.000Z')], {
      events: [
        threadEvent('past-end', 'note', '2026-11-10T10:15:00.001Z'),
        threadEvent('end-b', 'note', '2026-11-10T10:15:00.000Z'),
        threadEvent('end-a', 'note', '2026-11-10T10:15:00.000Z'),
        threadEvent('start', 'note', '2026-11-10T09:00:00.000Z'),
        threadEvent('before-start', 'note', '2026-11-10T08:59:59.999Z'),
      ],
    });
    expect(blocks.map((block) => [block.kind, ids(block.milestones)])).toEqual([
      ['interlude', ['before-start']],
      ['stretch', ['start', 'end-a', 'end-b']],
      ['interlude', ['past-end']],
    ]);
  });

  test('where two axes overlap, the stretch containing the event takes it, else the one already begun', () => {
    // Axes: 09:00–10:15 (minimum length) and 10:00–11:15.
    const blocks = cascade(
      [
        session('first', '2026-11-10T09:10:00.000Z', '2026-11-10T09:20:00.000Z'),
        session('second', '2026-11-10T10:05:00.000Z', '2026-11-10T10:30:00.000Z'),
      ],
      {
        events: [
          threadEvent('in-second', 'note', '2026-11-10T10:10:00.000Z'),
          threadEvent('in-neither', 'note', '2026-11-10T10:02:00.000Z'),
          threadEvent('second-only', 'note', '2026-11-10T11:00:00.000Z'),
        ],
      },
    );
    expect(stretchesOf(blocks).map((stretch) => [iso(stretch.axis.startMs), iso(stretch.axis.endMs)])).toEqual([
      ['2026-11-10T09:00:00.000Z', '2026-11-10T10:15:00.000Z'],
      ['2026-11-10T10:00:00.000Z', '2026-11-10T11:15:00.000Z'],
    ]);
    expect(blocks.map((block) => [block.kind, ids(block.milestones)])).toEqual([
      ['stretch', ['in-neither']],
      ['stretch', ['in-second', 'second-only']],
    ]);
  });

  test('an event after a later stretch has begun is never listed under the older one', () => {
    // Axes: 10:00–11:15 and 10:45–12:00; the event is inside both axes and inside neither session range.
    const blocks = cascade(
      [
        session('first', '2026-11-10T10:05:00.000Z', '2026-11-10T10:10:00.000Z'),
        session('second', '2026-11-10T10:56:00.000Z', '2026-11-10T10:58:00.000Z'),
      ],
      { events: [threadEvent('after-second', 'note', '2026-11-10T11:05:00.000Z')] },
    );
    expect(blocks.map((block) => [block.kind, ids(block.milestones)])).toEqual([
      ['stretch', []],
      ['stretch', ['after-second']],
    ]);
  });

  test('newest first reverses blocks, rows, members, children and milestones', () => {
    const child = (id: string, start: string): WorkThreadEpisode =>
      session(id, start, '2026-11-10T09:30:00.000Z', { launchedBy: launched });
    const rich = [
      session('a', '2026-11-10T09:00:00.000Z', '2026-11-10T10:00:00.000Z', {
        children: [child('a-1', '2026-11-10T09:05:00.000Z'), child('a-2', '2026-11-10T09:06:00.000Z')],
      }),
      session('b', '2026-11-10T09:00:30.000Z', '2026-11-10T09:50:00.000Z'),
      session('late', '2026-11-10T09:20:00.000Z', '2026-11-10T09:40:00.000Z'),
      ...episodes.slice(1),
    ];
    const shape = (blocks: readonly CascadeBlock[]) =>
      blocks.map((block) => ({
        id: block.id,
        milestones: ids(block.milestones),
        rows:
          block.kind === 'stretch'
            ? block.rows.map((row) =>
                row.kind === 'burst'
                  ? { id: row.id, members: row.members.map((member) => [member.id, ids(member.children)]) }
                  : { id: row.id, children: ids(row.children) },
              )
            : null,
      }));

    expect(shape(cascade(rich, { events }))).toEqual([
      { id: 'interlude:created', milestones: ['created', 'before-renamed'], rows: null },
      {
        id: 'stretch:2026-11-10T09:00:00.000Z',
        milestones: ['pr-opened', 'inside-note'],
        rows: [
          {
            id: 'burst:a',
            members: [
              ['a', ['a-1', 'a-2']],
              ['b', []],
            ],
          },
          { id: 'late', children: [] },
        ],
      },
      { id: 'interlude:between-waiting', milestones: ['between-waiting', 'between-linked'], rows: null },
      {
        id: 'stretch:2026-11-10T13:00:00.000Z',
        milestones: ['pr-merged'],
        rows: [{ id: 'afternoon', children: [] }],
      },
      { id: 'interlude:after-note', milestones: ['after-note'], rows: null },
    ]);

    expect(shape(cascade(rich, { events, newestFirst: true }))).toEqual([
      { id: 'interlude:after-note', milestones: ['after-note'], rows: null },
      {
        id: 'stretch:2026-11-10T13:00:00.000Z',
        milestones: ['pr-merged'],
        rows: [{ id: 'afternoon', children: [] }],
      },
      { id: 'interlude:between-waiting', milestones: ['between-linked', 'between-waiting'], rows: null },
      {
        id: 'stretch:2026-11-10T09:00:00.000Z',
        milestones: ['inside-note', 'pr-opened'],
        rows: [
          { id: 'late', children: [] },
          {
            id: 'burst:a',
            members: [
              ['b', []],
              ['a', ['a-2', 'a-1']],
            ],
          },
        ],
      },
      { id: 'interlude:created', milestones: ['before-renamed', 'created'], rows: null },
    ]);
  });

  test('the order only changes the presentation, never the totals or the axis', () => {
    const oldest = stretchesOf(cascade(episodes, { events }));
    const newest = stretchesOf(cascade(episodes, { events, newestFirst: true })).toReversed();
    const facts = (stretch: CascadeStretch) => ({
      axis: stretch.axis,
      childCount: stretch.childCount,
      dayKeys: stretch.dayKeys,
      endMs: stretch.endMs,
      mark: stretch.mark,
      sessionCount: stretch.sessionCount,
      startMs: stretch.startMs,
    });
    expect(newest.map(facts)).toEqual(oldest.map(facts));
  });

  test('no episodes and no events give no blocks', () => {
    expect(cascade([])).toEqual([]);
    expect(cascade([], { newestFirst: true })).toEqual([]);
  });

  test('events without sessions form a single interlude', () => {
    const block = asInterlude(only(cascade([], { events })));
    expect(block.id).toBe('interlude:created');
    expect(ids(block.milestones)).toEqual([
      'created',
      'before-renamed',
      'pr-opened',
      'inside-note',
      'between-waiting',
      'between-linked',
      'pr-merged',
      'after-note',
    ]);
    const reversed = asInterlude(only(cascade([], { events, newestFirst: true })));
    expect(reversed.id).toBe('interlude:created');
    expect(ids(reversed.milestones)).toEqual([...ids(block.milestones)].reverse());
  });

  test('sessions without events have no milestones', () => {
    expect(cascade(episodes).map((block) => [block.kind, block.milestones.length])).toEqual([
      ['stretch', 0],
      ['stretch', 0],
    ]);
  });
});

describe('unreadable instants', () => {
  // The reader guarantees canonical instants; forging one is the only way to reach the invariant.
  const unreadable = 'not-an-instant' as CanonicalInstant;

  test('a root session whose start does not parse throws and names the link key', () => {
    const broken = session('session:test/codex/broken', '2026-11-10T09:00:00.000Z', null, { startedAt: unreadable });
    expect(() => cascade([session('fine', '2026-11-10T09:00:00.000Z', null), broken])).toThrow(TypeError);
    expect(() => cascade([broken])).toThrow('session:test/codex/broken');
  });

  test('a nested session whose start does not parse throws as well', () => {
    const child = session('session:test/codex/child', '2026-11-10T09:00:00.000Z', null, {
      launchedBy: launched,
      startedAt: unreadable,
    });
    const parent = session('parent', '2026-11-10T09:00:00.000Z', null, { children: [child] });
    expect(() => cascade([parent])).toThrow(TypeError);
    expect(() => cascade([parent])).toThrow('session:test/codex/child');
  });

  test('an unreadable end or event date throws instead of placing the item at no instant', () => {
    const broken = session('session:test/codex/ended', '2026-11-10T09:00:00.000Z', null, { endedAt: unreadable });
    expect(() => cascade([broken])).toThrow(TypeError);
    expect(() => cascade([broken])).toThrow('session:test/codex/ended');

    const undated: CascadeHistoryEntry = { ...threadEvent('undated', 'note', '2026-11-10T09:00:00.000Z'), at: 'never' };
    expect(() => cascade([], { events: [undated] })).toThrow(TypeError);
    expect(() => cascade([], { events: [undated] })).toThrow('undated');
  });
});
