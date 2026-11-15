import { describe, expect, test } from 'bun:test';
import { parseCanonicalInstant } from '@ai-usage/report-core/canonical-instant';
import type { CheckoutStatusObservation, PullRequestObservation } from '@ai-usage/report-core/work-attention';
import type { WorkThreadEvent, WorkThreadLink } from '@ai-usage/report-core/work-thread';
import type { WorkThreadRemainder, WorkThreadSituation } from '@ai-usage/report-core/work-thread-situation';
import {
  WORK_THREAD_VIEW_BOUNDS,
  type WorkThreadEpisode,
  type WorkThreadFactEvent,
  type WorkThreadLocalMarker,
  type WorkThreadMark,
  type WorkThreadMarkers,
  type WorkThreadNativeRequest,
  type WorkThreadPullRequestMarker,
  type WorkThreadRow,
  type WorkThreadSourceStatus,
} from '@ai-usage/report-core/work-thread-view';
import {
  createSyntheticWorkThreadStore,
  WORK_THREADS_FIXTURE_IDS,
} from '../../../server/work-threads-e2e-fixture.server';
import {
  acknowledgedRemainderCopy,
  bucketThreadMarks,
  episodeContext,
  episodeDuration,
  episodeDurationDetail,
  episodeResumeText,
  episodeSpan,
  episodeSpanContext,
  episodeTimeRange,
  groupThreadRows,
  groupThreadRowsByBand,
  harnessName,
  localMarkerKey,
  observedWebUrl,
  primaryResumeEpisode,
  projectShortLabel,
  remainderActionCopy,
  remainderCopy,
  remainderEvidenceCopy,
  THREAD_BANDS,
  THREAD_LANE_MAX_TRACKS,
  THREAD_LIFECYCLE_STEPS,
  THREAD_TIMELINE_MIN_DAYS,
  type ThreadBand,
  type ThreadLifecycleStep,
  taskSourceStatuses,
  threadAge,
  threadBand,
  threadBandCounts,
  threadBandFilter,
  threadDate,
  threadDayKey,
  threadDayMarks,
  threadDisplayMarkers,
  threadEventActor,
  threadEventCopy,
  threadFactEventCopy,
  threadHistory,
  threadLifecycle,
  threadLifecycleSummary,
  threadListQuery,
  threadMoreUrl,
  threadPageCursors,
  threadPullRequestTracks,
  threadRecentActivity,
  threadRefs,
  threadRowMeta,
  threadSessionsLabel,
  threadSideUrl,
  threadSituationCopy,
  threadSourceAvailability,
  threadTimeline,
  threadTimeRange,
  threadUrl,
  threadView,
  threadViewUrl,
  threadWaitSince,
  threadWaitSinceLabel,
} from './work-thread-model';

const store = createSyntheticWorkThreadStore();
const query = threadListQuery(new URLSearchParams());
const list = await store.readList(query);
const requireDetail = async (id: string) => {
  const detail = await store.readDetail(id);
  if (!detail) {
    throw new Error(`Missing test task ${id}`);
  }
  return detail;
};
const analysis = await requireDetail(WORK_THREADS_FIXTURE_IDS.analysis);
const payment = await requireDetail(WORK_THREADS_FIXTURE_IDS.payments);
const review = await requireDetail(WORK_THREADS_FIXTURE_IDS.review);
const episode = payment.episodes[0];
if (!episode) {
  throw new Error('Expected a test episode');
}

describe('task presentation model', () => {
  test('a date from another year names its year', () => {
    const now = '2026-10-26T12:00:00.000Z';
    expect(threadDate('2023-04-21T09:09:21.000Z', 'UTC', false, now)).toBe('Apr 21, 2023');
    expect(threadDate('2026-04-21T09:09:21.000Z', 'UTC', false, now)).toBe('Apr 21');
    expect(threadDate('2023-04-21T09:09:21.000Z', 'UTC')).toBe('Apr 21');
  });
  test.each([
    ['same day', '2026-10-24T09:20:00.000Z', '2026-10-24T09:44:00.000Z', 'UTC', '09:20–09:44'],
    ['overnight', '2026-10-24T22:06:00.000Z', '2026-10-25T02:19:00.000Z', 'UTC', '22:06–02:19 +1d'],
    ['year boundary', '2026-12-31T23:30:00.000Z', '2027-01-02T00:15:00.000Z', 'UTC', '23:30–00:15 +2d'],
    ['short DST day', '2026-03-28T23:30:00.000Z', '2026-03-29T22:30:00.000Z', 'Europe/Paris', '00:30–00:30 +1d'],
    ['long DST day', '2026-10-24T22:30:00.000Z', '2026-10-25T22:30:00.000Z', 'Europe/Paris', '00:30–23:30'],
    ['local same day', '2026-10-24T23:30:00.000Z', '2026-10-25T00:30:00.000Z', 'America/Los_Angeles', '16:30–17:30'],
    ['UTC next day', '2026-10-24T23:30:00.000Z', '2026-10-25T00:30:00.000Z', 'UTC', '23:30–00:30 +1d'],
  ])('episode time range names calendar offsets: %s', (_label, start, end, timeZone, expected) => {
    expect(
      episodeTimeRange({ startedAt: parseCanonicalInstant(start), endedAt: parseCanonicalInstant(end) }, timeZone),
    ).toBe(expected);
  });
  test('a missing episode end does not invent an end time or day offset', () => {
    expect(
      episodeTimeRange({ startedAt: parseCanonicalInstant('2026-10-24T22:06:00.000Z'), endedAt: null }, 'UTC'),
    ).toBe('22:06');
  });
  test('groups each durable task once by project, including a PR without sessions', () => {
    const groups = groupThreadRows(list.rows);
    expect(groups.reduce((total, group) => total + group.tasks.length, 0)).toBe(list.rows.length);
    expect(groups.some((group) => group.project === 'ai-usage')).toBe(true);
    expect(threadRefs(review.row)).toContain('0 linked sessions');
    expect(threadRefs(review.row)).toContain('PR #');
  });
  test('task references count linked sessions separately from delegated sessions and omit zero delegations', () => {
    expect(threadRefs({ ...review.row, sessionCount: 1, delegatedSessionCount: 20 })).toBe(
      'PR #1492 · 1 linked session · 20 delegated',
    );
    expect(threadRefs({ ...review.row, sessionCount: 2, delegatedSessionCount: 0 })).toBe(
      'PR #1492 · 2 linked sessions',
    );
  });
  test('the side pane keeps the list filters, and the full page and the list drop the pane', () => {
    const url = new URL('http://localhost/work?tab=done&q=1487&history=journal');
    const side = new URL(threadSideUrl(url, WORK_THREADS_FIXTURE_IDS.payments, '2026-10-24'), url);
    expect(side.searchParams.get('task')).toBe(WORK_THREADS_FIXTURE_IDS.payments);
    expect(side.searchParams.get('detail')).toBe('side');
    expect(side.searchParams.get('day')).toBe('2026-10-24');
    expect(side.searchParams.get('q')).toBe('1487');
    const next = new URL(threadSideUrl(side, WORK_THREADS_FIXTURE_IDS.review), side);
    expect(next.searchParams.get('detail')).toBe('side');
    expect(next.searchParams.get('day')).toBeNull();
    const full = new URL(threadUrl(side, WORK_THREADS_FIXTURE_IDS.payments), side);
    expect(full.searchParams.get('task')).toBe(WORK_THREADS_FIXTURE_IDS.payments);
    expect(full.searchParams.has('detail')).toBe(false);
    expect(full.searchParams.get('history')).toBe('journal');
    const back = new URL(threadUrl(side, null), side);
    expect(back.searchParams.has('task')).toBe(false);
    expect(back.searchParams.has('detail')).toBe(false);
    expect(back.searchParams.get('tab')).toBe('done');
  });
  test('a task link always drops the pane and keeps the lens it was opened from', () => {
    for (const view of ['disk', 'timeline', 'pilot'] as const) {
      const url = new URL(`http://localhost/work?view=${view}&from=2026-10-01&to=2026-11-01&open=Example+shop`);
      const task = new URL(threadUrl(url, WORK_THREADS_FIXTURE_IDS.payments), url);
      expect(task.searchParams.get('view')).toBe(view);
      expect(task.searchParams.get('open')).toBe('Example shop');
      const side = new URL(threadSideUrl(task, WORK_THREADS_FIXTURE_IDS.payments), task);
      expect(side.searchParams.get('view')).toBe(view);
      expect(side.searchParams.get('detail')).toBe('side');
      const back = new URL(threadUrl(side, null), side);
      expect(back.searchParams.get('view')).toBe(view);
      expect(back.searchParams.get('from')).toBe('2026-10-01');
      expect(back.searchParams.has('task')).toBe(false);
      expect(back.searchParams.has('detail')).toBe(false);
    }
  });
  test('a switch of lens keeps the shared filters and drops what another lens would misread', () => {
    const url = new URL(
      `http://localhost/work?view=pilot&tab=done&project=Example+shop&q=1487&band=yours&cursor=next&start=first&scroll=550&focus=${WORK_THREADS_FIXTURE_IDS.review}&task=${WORK_THREADS_FIXTURE_IDS.payments}&detail=side&day=2026-10-24#top`,
    );
    expect(threadViewUrl(url, 'timeline')).toBe('/work?view=timeline&tab=done&project=Example+shop&q=1487');
    expect(threadViewUrl(url, 'disk')).toBe('/work?view=disk&tab=done&project=Example+shop&q=1487');
    expect(threadViewUrl(url, 'pilot')).toBe('/work?view=pilot&tab=done&project=Example+shop&q=1487');
    // Lanes is the URL without `view`.
    expect(threadViewUrl(url, 'lanes')).toBe('/work?tab=done&project=Example+shop&q=1487');
    expect(threadViewUrl(new URL('http://localhost/work'), 'lanes')).toBe('/work');
    // `group` is a band grouping in Lanes and a lane grouping in Timeline: it never crosses.
    expect(threadViewUrl(new URL('http://localhost/work?view=lanes&group=bands'), 'timeline')).toBe(
      '/work?view=timeline',
    );
    expect(threadViewUrl(new URL('http://localhost/work?view=timeline&group=attention'), 'lanes')).toBe('/work');
    // The Timeline's window is read by no other lens and is still there on the way back.
    const timeline = new URL('http://localhost/work?view=timeline&from=2026-10-01&to=2026-11-01&open=a&quiet=1');
    const away = new URL(threadViewUrl(timeline, 'disk'), timeline);
    expect(threadViewUrl(away, 'timeline')).toBe('/work?view=timeline&from=2026-10-01&to=2026-11-01&open=a&quiet=1');
  });
  test('a time range accepts instants or dates and names the days it crosses', () => {
    expect(threadTimeRange('2026-11-08T08:24:00.000Z', '2026-11-08T22:53:00.000Z', 'Europe/Paris')).toBe('09:24–23:53');
    expect(
      threadTimeRange(new Date('2026-11-08T19:44:00.000Z'), new Date('2026-11-09T08:05:00.000Z'), 'Europe/Paris'),
    ).toBe('20:44–09:05 +1d');
    expect(threadTimeRange('2026-11-08T08:24:00.000Z', null, 'Europe/Paris')).toBe('09:24');
  });
  test('filters and scroll survive task links and the return URL', () => {
    const url = new URL('http://localhost/work?tab=done&project=Example+shop&q=1487&cursor=next&scroll=550');
    const task = new URL(threadUrl(url, WORK_THREADS_FIXTURE_IDS.payments, '2026-10-24'), url);
    expect(task.searchParams.get('day')).toBe('2026-10-24');
    expect(threadListQuery(task.searchParams)).toEqual({
      cursor: 'next',
      limit: 50,
      project: 'Example shop',
      search: '1487',
      tab: 'done',
    });
    const back = new URL(threadUrl(task, null), url);
    expect(back.searchParams.get('scroll')).toBe('550');
    expect(back.searchParams.has('task')).toBe(false);
    expect(back.searchParams.has('day')).toBe(false);
  });
  test('continues after twenty pages instead of leaving Load more a no-op', () => {
    let url = new URL('http://localhost/work?project=Example+shop&q=PR');
    for (let index = 1; index < 20; index++) {
      url = threadMoreUrl(url, `page-${index}`).url;
    }
    expect(threadPageCursors(url.searchParams)).toHaveLength(20);
    const before = url.href;
    const next = threadMoreUrl(url, 'page-20');
    expect(next.continuation).toBe(true);
    expect(threadPageCursors(next.url.searchParams)).toEqual(['page-20']);
    expect(next.url.searchParams.get('project')).toBe('Example shop');
    expect(url.href).toBe(before);
    expect(threadPageCursors(threadMoreUrl(next.url, 'page-21').url.searchParams)).toEqual(['page-20', 'page-21']);
  });
  test('places marks by the viewer calendar date across a timezone offset', () => {
    const at = parseCanonicalInstant('2026-10-24T00:30:00.000Z');
    expect(threadDayKey(at, 'America/Los_Angeles')).toBe('2026-10-23');
    expect(threadDayKey(at, 'Europe/Paris')).toBe('2026-10-24');
    const marks = bucketThreadMarks(
      [{ at, fact: null, kind: 'session', harness: 'codex', label: null, source: null }],
      'America/Los_Angeles',
    );
    expect(marks.get('2026-10-23')).toHaveLength(1);
  });
  test('DST repeated hour is one day; week remains seven distinct calendar days', () => {
    const first = parseCanonicalInstant('2026-10-25T00:30:00.000Z');
    const second = parseCanonicalInstant('2026-10-25T01:30:00.000Z');
    const marks = bucketThreadMarks(
      [first, second].map((at) => ({
        at,
        fact: null,
        kind: 'session' as const,
        harness: 'codex',
        label: null,
        source: null,
      })),
      'Europe/Paris',
    );
    expect(marks.get('2026-10-25')).toHaveLength(2);
    const days = threadTimeline('2026-10-26T01:00:00Z', 'Europe/Paris', ['2026-10-20T08:00:00Z']);
    expect(days.map((day) => day.key).slice(-7)).toEqual([
      '2026-10-20',
      '2026-10-21',
      '2026-10-22',
      '2026-10-23',
      '2026-10-24',
      '2026-10-25',
      '2026-10-26',
    ]);
    expect(new Set(days.map((day) => day.key)).size).toBe(days.length);
    expect(days.filter((day) => day.today).map((day) => day.key)).toEqual(['2026-10-26']);
  });
  test('the timeline reaches back to the earliest task activity, today last, within its bounds', () => {
    const days = threadTimeline('2026-10-27T10:00:00Z', 'UTC', ['2026-10-25T10:00:00Z', '2026-08-30T23:30:00Z']);
    expect(days[0]?.key).toBe('2026-08-30');
    expect(days.at(-1)).toMatchObject({ key: '2026-10-27', today: true, label: 'Tue, Oct 27' });
    expect(days.filter((day) => day.month).map((day) => day.month)).toEqual(['Aug 2026', 'Sep 2026', 'Oct 2026']);
    expect(days.find((day) => day.key === '2026-08-31')).toMatchObject({ weekStart: true, dayOfMonth: 31 });
    // A recent task still reads against two weeks; a very old one is cut at the bound.
    expect(threadTimeline('2026-10-27T10:00:00Z', 'UTC', [])).toHaveLength(THREAD_TIMELINE_MIN_DAYS);
    expect(threadTimeline('2026-10-27T10:00:00Z', 'UTC', ['2020-01-01T00:00:00Z'])).toHaveLength(
      WORK_THREAD_VIEW_BOUNDS.maxTimelineDays,
    );
  });
  test('one branch checked out in several worktrees keeps one marker per checkout', () => {
    const marker = payment.row.markers.local[0];
    if (!marker?.latest) {
      throw new Error('Expected a local marker');
    }
    const other = { ...marker, latest: { ...marker.latest, checkoutPath: `${marker.latest.checkoutPath}-2` } };
    expect(localMarkerKey(marker)).not.toBe(localMarkerKey(other));
    expect(localMarkerKey(marker).startsWith(marker.key)).toBe(true);
  });
  test('the list keeps explanations, not source and date captions, and shortens projects', () => {
    expect(projectShortLabel('exaprint/Exalibur')).toBe('Exalibur');
    expect(projectShortLabel('XLB')).toBe('XLB');
    expect(projectShortLabel(null)).toBe('No project');
  });
  test('analysis copy permits ending without implying automatic closure', () => {
    const copy = threadSituationCopy(analysis.row, analysis.generatedAt, analysis.sources);
    expect(copy).toMatchObject({
      hint: 'ready-to-close',
      headline: 'End follow-up',
      caption: 'An analysis can be enough. No branch, PR or ticket is required.',
    });
    expect(copy.note).toBe(copy.caption);
    expect(analysis.row.thread.followState).toBe('following');
  });
  test('failed or stale linked-session reads require acknowledgement before ending an analysis', () => {
    const failed = [
      {
        source: 'sessions' as const,
        state: 'failed' as const,
        lastRunAt: analysis.generatedAt,
        message: 'Collection failed',
      },
    ];
    const stale = [
      {
        source: 'sessions' as const,
        state: 'ok' as const,
        lastRunAt: parseCanonicalInstant('2026-10-01T00:00:00.000Z'),
        message: null,
      },
    ];
    expect(threadSituationCopy(analysis.row, analysis.generatedAt, failed)).toMatchObject({
      hint: 'undecided',
      action: 'copy-context',
    });
    expect(
      threadSituationCopy(analysis.row, analysis.generatedAt, failed).remainders.some(
        (item) => item.kind === 'source-unavailable',
      ),
    ).toBe(true);
    expect(
      threadSituationCopy(analysis.row, analysis.generatedAt, stale).remainders.some(
        (item) => item.kind === 'source-stale',
      ),
    ).toBe(true);
    const noSessions = { ...analysis.row, links: [], sessionCount: 0, delegatedSessionCount: 0 };
    expect(threadSituationCopy(noSessions, analysis.generatedAt, failed)).toMatchObject({
      hint: 'ready-to-close',
      remainders: [],
    });
    const sessionKey = analysis.row.links.find((link) => link.kind === 'session')?.key;
    expect(sessionKey).toBeDefined();
    expect(threadSituationCopy(analysis.row, analysis.generatedAt, []).remainders).toContainEqual({
      key: sessionKey ?? '',
      source: 'sessions',
      observedAt: null,
      kind: 'source-unknown',
    });
    expect(threadSituationCopy(noSessions, analysis.generatedAt, [])).toMatchObject({
      hint: 'ready-to-close',
      remainders: [],
    });
    expect(
      threadSituationCopy({ ...noSessions, delegatedSessionCount: 1 }, analysis.generatedAt, failed).remainders,
    ).toContainEqual(expect.objectContaining({ source: 'sessions', kind: 'source-unavailable' }));
  });
  test('a linked artifact without a read stays visible and unknown', () => {
    const display = threadDisplayMarkers({ ...payment.row, markers: { local: [], pullRequests: [], jiraIssues: [] } });
    expect(display.pullRequests.length).toBeGreaterThan(0);
    expect(display.pullRequests[0]?.latest).toBeNull();
    expect(
      threadSituationCopy(
        { ...payment.row, markers: { local: [], pullRequests: [], jiraIssues: [] } },
        payment.generatedAt,
        payment.sources,
      ).remainders.some((item) => item.kind === 'source-unknown'),
    ).toBe(true);
  });
  test('failing PR checks remain actionable when the sessions read is truncated', () => {
    const marker = payment.row.markers.pullRequests[0];
    if (!marker?.latest) {
      throw new Error('Expected a PR observation');
    }
    const situation = threadSituationCopy(
      {
        ...payment.row,
        markers: {
          ...payment.row.markers,
          pullRequests: [
            {
              ...marker,
              latest: {
                ...marker.latest,
                checksRollup: 'failure',
                reviewDecision: null,
                unresolvedReviewThreads: null,
              },
            },
          ],
        },
      },
      payment.generatedAt,
      [
        {
          source: 'sessions',
          state: 'truncated',
          lastRunAt: payment.generatedAt,
          message: 'Session read limit reached',
        },
      ],
    );
    expect(situation).toMatchObject({
      hint: 'to-resume',
      headline: 'Fix checks on #1487',
      caption: 'GitHub · Oct 24',
      note: null,
      reason: 'failing-checks',
      action: 'open-pr',
    });
    expect(situation.remainders).toContainEqual(
      expect.objectContaining({ source: 'sessions', kind: 'source-unavailable', outcome: 'truncated' }),
    );
    expect(situation.remainders).toContainEqual(expect.objectContaining({ source: 'github', kind: 'failing-checks' }));
    expect(
      acknowledgedRemainderCopy(situation.remainders).some((item) => item.includes('Sessions evidence incomplete')),
    ).toBe(true);
  });
  test('a long confirmation acknowledges the full shown set within the command bound', () => {
    const messages = acknowledgedRemainderCopy(
      Array.from({ length: 25 }, (_, index) => ({
        kind: 'open-pr' as const,
        source: 'github' as const,
        observedAt: null,
        key: `github.com/test/repo#${index + 1}`,
      })),
    );
    expect(messages).toHaveLength(16);
    expect(messages[15]).toContain('10 additional remainders');
    expect(messages.every((message) => message.length <= 512)).toBe(true);
  });
  test('source links reject executable schemes, credentials and invented relative links', () => {
    expect(observedWebUrl('https://github.example/team/repo/pull/2')).toBe('https://github.example/team/repo/pull/2');
    for (const unsafe of [
      'javascript:alert(1)',
      'data:text/html,hello',
      '//github.example/pull/2',
      'https://token@github.example/pull/2',
    ]) {
      expect(observedWebUrl(unsafe)).toBeNull();
    }
  });
  test('episode spans and resume paths are explicit, without invented commands', () => {
    const none: WorkThreadEpisode = {
      ...episode,
      activeMs: null,
      spanMs: null,
      resume: { kind: 'none', reason: 'Not supported' },
    };
    expect(episodeSpan(none)).toBe('Span unknown');
    expect(episodeResumeText(none, 'Task')).toBeNull();
    const cli: WorkThreadEpisode = {
      ...episode,
      resume: { kind: 'cli-resume', command: 'codex resume observed-id', cwd: '/example' },
    };
    expect(episodeResumeText(cli, 'Task')).toContain('codex resume observed-id');
    expect(episodeContext(cli, 'Task')).toContain('Task: Task');
  });
  test('the primary action only resumes the unambiguous running episode, including a child', () => {
    const running: WorkThreadEpisode = {
      ...episode,
      linkKey: 'running-child',
      running: true,
      children: [],
      resume: { kind: 'cli-resume', command: 'codex resume running', cwd: null },
    };
    const ended: WorkThreadEpisode = { ...episode, running: false, children: [running] };
    expect(primaryResumeEpisode([ended], 1)?.linkKey).toBe('running-child');
    expect(primaryResumeEpisode([ended], 2)).toBeNull();
    expect(primaryResumeEpisode([{ ...ended, children: [] }], 1)).toBeNull();
    expect(
      primaryResumeEpisode([{ ...running, resume: { kind: 'none', reason: 'Unavailable' } }, ended], 2),
    ).toBeNull();
  });
  test('history shares calendar days, keeps delegations under the parent, and filters work events', () => {
    const all = threadHistory(payment, false, 'Europe/Paris').flatMap((day) => day.entries);
    const only = threadHistory(payment, true, 'Europe/Paris').flatMap((day) => day.entries);
    expect(only).toHaveLength(payment.episodes.length);
    expect(only.every((entry) => entry.kind === 'session')).toBe(true);
    expect(all.filter((entry) => entry.kind === 'session')).toHaveLength(payment.episodes.length);
    expect(all.filter((entry) => entry.kind === 'fact-event')).toHaveLength(payment.factEvents.length);
  });
  test('event actor stays neutral when the frozen event has no actor provenance', () => {
    const event = payment.events[0];
    if (!event) {
      throw new Error('Expected a test event');
    }
    expect(threadEventActor({ ...event, kind: 'created' })).toBe('Work event');
    expect(threadEventActor({ ...event, kind: 'wait-satisfied', linkKey: 'jira:example/EX-1' })).toBe('Jira');
  });
  test('link and detach events resolve nested session titles and harnesses', () => {
    const event = payment.events[0];
    if (!event) {
      throw new Error('Expected a test event');
    }
    const child: WorkThreadEpisode = {
      ...episode,
      linkKey: 'session:fixture-machine/codex/nested',
      title: 'Verify the retry invariant',
      harness: 'codex',
      children: [],
    };
    const episodes = [{ ...episode, children: [{ ...episode, children: [child] }] }];
    for (const kind of ['link-added', 'link-detached'] as const) {
      expect(threadEventCopy({ ...event, kind, linkKey: child.linkKey, reason: null }, episodes).detail).toBe(
        'Verify the retry invariant · Codex',
      );
    }
    expect(threadEventCopy({ ...event, kind: 'link-detached', linkKey: child.linkKey, reason: null }, []).detail).toBe(
      'a session (no longer readable)',
    );
  });
  test('source event labels use PR, Jira and branch references instead of qualified keys', () => {
    const event = payment.events[0];
    if (!event) {
      throw new Error('Expected a test event');
    }
    for (const [linkKey, label] of [
      ['github.example/team/repo#68', 'PR #68 · team/repo'],
      ['jira:example/XLB-2085', 'XLB-2085'],
      ['branch:github.example/team/repo@fix/payment/retry', 'fix/payment/retry'],
    ] as const) {
      expect(threadEventCopy({ ...event, kind: 'link-detached', linkKey, reason: null }, []).detail).toBe(label);
    }
  });
});

describe('round 2 concise task evidence', () => {
  const observedAt = parseCanonicalInstant('2026-10-25T00:30:00.000Z');
  const evidence = { key: 'github.example/synthetic/shop#72', source: 'github' as const, observedAt };
  const examples: Record<WorkThreadRemainder['kind'], { input: WorkThreadRemainder; copy: string }> = {
    'native-request': {
      input: {
        ...evidence,
        source: 'sessions',
        kind: 'native-request',
        request: {
          key: 'request',
          sessionKey: episode.linkKey,
          machineId: episode.machineId,
          harness: episode.harness,
          sourceSessionId: episode.sourceSessionId,
          callId: 'call',
          questionId: 'q',
          askedAt: observedAt,
          answeredAt: null,
          observedAt,
          text: 'Choose scope?',
          state: 'open',
          evidence: 'codex-request-user-input',
          detail: 'No attributable answer.',
        },
      },
      copy: 'Native request: Choose scope?',
    },
    'local-files': {
      input: { ...evidence, source: 'local', kind: 'local-files', modified: 2, staged: 1, untracked: 0 },
      copy: 'Local: 2 modified · 1 staged · 0 untracked',
    },
    'unpushed-commits': {
      input: { ...evidence, source: 'local', kind: 'unpushed-commits', count: 1 },
      copy: '1 unpushed commit',
    },
    'running-session': {
      input: { ...evidence, source: 'sessions', kind: 'running-session', count: 2 },
      copy: '2 sessions still running',
    },
    'merge-conflict': {
      input: { ...evidence, kind: 'merge-conflict', baseRef: 'release/2026' },
      copy: 'Conflicts with release/2026',
    },
    'behind-base': {
      input: { ...evidence, kind: 'behind-base', baseRef: 'release/2026' },
      copy: 'Behind release/2026',
    },
    'changes-requested': { input: { ...evidence, kind: 'changes-requested' }, copy: 'Review changes to address' },
    'failing-checks': { input: { ...evidence, kind: 'failing-checks' }, copy: 'Checks failing' },
    'pending-checks': { input: { ...evidence, kind: 'pending-checks' }, copy: 'Checks pending' },
    'review-requested': { input: { ...evidence, kind: 'review-requested' }, copy: 'A PR waits for your review' },
    'team-review-requested': {
      input: { ...evidence, kind: 'team-review-requested' },
      copy: 'Your team was asked to review · take it or leave it',
    },
    'jira-after-merge': {
      input: { ...evidence, kind: 'jira-after-merge' },
      copy: 'Merged · the ticket moves on without you',
    },
    'unresolved-review-threads': {
      input: { ...evidence, kind: 'unresolved-review-threads', count: 2 },
      copy: '2 review threads to address',
    },
    'awaiting-review': {
      input: { ...evidence, kind: 'awaiting-review' },
      copy: 'Review requested · waiting on reviewers',
    },
    'draft-pr': { input: { ...evidence, kind: 'draft-pr' }, copy: 'Draft PR' },
    'ready-to-merge': { input: { ...evidence, kind: 'ready-to-merge' }, copy: 'Ready to merge' },
    'open-pr': { input: { ...evidence, kind: 'open-pr' }, copy: 'PR still open' },
    'jira-open': { input: { ...evidence, source: 'jira', kind: 'jira-open' }, copy: 'Ticket not done' },
    'source-unavailable': {
      input: { ...evidence, kind: 'source-unavailable', outcome: 'unauthenticated' },
      copy: 'GitHub read: unauthenticated',
    },
    'source-stale': { input: { ...evidence, kind: 'source-stale' }, copy: 'GitHub read is stale' },
    'source-unknown': { input: { ...evidence, kind: 'source-unknown' }, copy: 'GitHub state is unknown' },
  };
  test('every remainder kind has short explicit copy and evidence dates use the viewer calendar', () => {
    for (const example of Object.values(examples)) {
      expect(remainderCopy(example.input)).toBe(example.copy);
      expect(remainderCopy(example.input).includes('\n')).toBe(false);
    }
    expect(remainderEvidenceCopy(examples['behind-base'].input, 'America/Los_Angeles')).toBe('GitHub · Oct 24');
    expect(remainderEvidenceCopy(examples['behind-base'].input, 'Europe/Paris')).toBe('GitHub · Oct 25');
    expect(remainderEvidenceCopy({ ...evidence, observedAt: null, kind: 'source-unknown' }, 'UTC')).toBe(
      'GitHub · date unknown',
    );
    expect(remainderCopy({ ...evidence, kind: 'unresolved-review-threads', count: 1 })).toBe(
      '1 review thread to address',
    );
    expect(remainderCopy({ ...evidence, kind: 'behind-base', baseRef: null })).toBe('Behind the PR base (unknown)');
    expect(
      remainderCopy({
        ...evidence,
        source: 'local',
        kind: 'local-files',
        modified: null,
        staged: null,
        untracked: null,
      }),
    ).toBe('Local: unknown modified · unknown staged · unknown untracked');
  });
  test('a checkout gone from disk with local work last seen there says so, and only that case', () => {
    const unavailable = { ...evidence, kind: 'source-unavailable' as const };
    expect(remainderCopy({ ...unavailable, source: 'local', outcome: 'missing' })).toBe(
      'Checkout gone from disk · local work was last seen there',
    );
    expect(remainderCopy({ ...unavailable, source: 'local', outcome: 'denied' })).toBe('Local read: denied');
    expect(remainderCopy({ ...unavailable, source: 'local', outcome: 'truncated' })).toBe('Local evidence incomplete');
    expect(remainderCopy({ ...unavailable, source: 'github', outcome: 'missing' })).toBe('GitHub read: missing');
  });
  test('every remainder kind names its gesture, with the pull request or ticket it concerns', () => {
    const actions: Record<WorkThreadRemainder['kind'], string> = {
      'native-request': `Answer ${harnessName(episode.harness)}: Choose scope?`,
      'local-files': 'Commit or discard 3 local changes',
      'unpushed-commits': 'Push 1 commit',
      'running-session': '2 sessions running',
      'merge-conflict': 'Resolve conflicts on #72',
      'behind-base': 'Update #72 from release/2026',
      'changes-requested': 'Address requested changes on #72',
      'failing-checks': 'Fix checks on #72',
      'pending-checks': 'Checks running on #72',
      'review-requested': 'Review #72',
      'team-review-requested': 'Take or leave the team review on #72',
      'jira-after-merge': 'The ticket moves on without you',
      'unresolved-review-threads': 'Address 2 review threads on #72',
      'awaiting-review': 'Waiting on reviewers of #72',
      'draft-pr': 'Finish draft #72',
      'ready-to-merge': 'Merge #72',
      'open-pr': 'Check on #72',
      'jira-open': 'Update the ticket',
      'source-unavailable': 'Choose the next step',
      'source-stale': 'Choose the next step',
      'source-unknown': 'Choose the next step',
    };
    for (const [kind, example] of Object.entries(examples)) {
      expect([kind, remainderActionCopy(example.input, payment.row)]).toEqual([kind, actions[example.input.kind]]);
    }
  });
  test('gestures count, pluralize and fall back to plain words when a key names nothing', () => {
    const row = payment.row;
    const withoutPullRequest = { ...row, links: [], markers: { ...row.markers, pullRequests: [] } };
    const local = { ...evidence, source: 'local' as const };
    const jira = { ...evidence, source: 'jira' as const, key: 'jira:synthetic/SHOP-72' };
    const request = examples['native-request'].input;
    if (request.kind !== 'native-request') {
      throw new Error('Expected the native request example');
    }
    expect(
      remainderActionCopy({ ...request, request: { ...request.request, harness: 'claude', state: 'uncertain' } }, row),
    ).toBe('Answer Claude: Choose scope? (answer unknown)');
    expect(remainderActionCopy({ ...evidence, kind: 'unresolved-review-threads', count: 1 }, row)).toBe(
      'Address 1 review thread on #72',
    );
    expect(remainderActionCopy({ ...evidence, kind: 'behind-base', baseRef: null }, row)).toBe(
      'Update #72 from its base',
    );
    expect(remainderActionCopy({ ...local, kind: 'unpushed-commits', count: 3 }, row)).toBe('Push 3 commits');
    expect(remainderActionCopy({ ...local, kind: 'unpushed-commits', count: 1 }, withoutPullRequest)).toBe(
      'Push 1 commit, open a PR',
    );
    // A linked pull request that was never read still exists: nothing asks to open another one.
    expect(
      remainderActionCopy(
        { ...local, kind: 'unpushed-commits', count: 2 },
        { ...withoutPullRequest, links: row.links.filter((item) => item.kind === 'pull-request') },
      ),
    ).toBe('Push 2 commits');
    expect(remainderActionCopy({ ...local, kind: 'running-session', count: 1 }, row)).toBe('1 session running');
    expect(
      remainderActionCopy({ ...local, kind: 'local-files', modified: null, staged: null, untracked: 1 }, row),
    ).toBe('Commit or discard 1 local change');
    for (const counts of [
      { modified: null, staged: null, untracked: null },
      { modified: 0, staged: 0, untracked: 0 },
    ]) {
      expect(remainderActionCopy({ ...local, kind: 'local-files', ...counts }, row)).toBe(
        'Commit or discard local changes',
      );
    }
    expect(remainderActionCopy({ ...jira, kind: 'jira-open' }, row)).toBe('Update ticket SHOP-72');
    expect(remainderActionCopy({ ...jira, kind: 'jira-after-merge' }, row)).toBe('Ticket SHOP-72 moves on without you');
    const unnamed = { ...evidence, key: 'not a pull request key' };
    expect(remainderActionCopy({ ...unnamed, kind: 'failing-checks' }, row)).toBe('Fix checks on the PR');
    expect(remainderActionCopy({ ...unnamed, kind: 'ready-to-merge' }, row)).toBe('Merge the PR');
    expect(remainderActionCopy({ ...unnamed, kind: 'draft-pr' }, row)).toBe('Finish the draft PR');
  });
  test('availability is one quiet line, while session truncation and messages stay in the details', () => {
    const statuses: readonly WorkThreadSourceStatus[] = [
      { source: 'github', state: 'failed', lastRunAt: observedAt, message: 'The synthetic GitHub read failed.' },
      { source: 'jira', state: 'never-run', lastRunAt: null, message: 'No Jira source has run.' },
      {
        source: 'sessions',
        state: 'truncated',
        lastRunAt: observedAt,
        message: 'Some linked session evidence was unavailable.',
      },
      { source: 'checkouts', state: 'ok', lastRunAt: observedAt, message: null },
    ];
    const availability = threadSourceAvailability(statuses, observedAt, 'Europe/Paris');
    expect(availability.summary).toBe('GitHub read failed Oct 25 · Jira not connected');
    expect(availability.details).toHaveLength(3);
    expect(availability.details.find((detail) => detail.source === 'sessions')).toMatchObject({
      label: 'evidence incomplete',
      message: 'Some linked session evidence was unavailable.',
      stale: false,
    });
    expect(availability.summary).not.toContain('Sessions');
    expect(availability.summary).not.toContain('synthetic');
    expect(availability.summary).not.toContain('\n');
  });
  test('fresh sources disappear, while stale and unknown observation dates remain visible', () => {
    const fresh: WorkThreadSourceStatus = { source: 'github', state: 'ok', lastRunAt: observedAt, message: null };
    expect(threadSourceAvailability([fresh], observedAt, 'UTC')).toEqual({ summary: '', details: [] });
    const stale = { ...fresh, lastRunAt: parseCanonicalInstant('2026-10-01T23:30:00.000Z') };
    expect(threadSourceAvailability([stale], observedAt, 'Europe/Paris')).toMatchObject({
      summary: 'GitHub read is stale Oct 2',
      details: [{ stale: true }],
    });
    expect(threadSourceAvailability([{ ...fresh, lastRunAt: null }], observedAt, 'UTC').summary).toBe(
      'GitHub read date unknown',
    );
    const partial: WorkThreadSourceStatus = { ...fresh, source: 'sessions', state: 'truncated' };
    expect(threadSourceAvailability([partial], observedAt, 'UTC')).toMatchObject({
      summary: '',
      details: [{ source: 'sessions', label: 'evidence incomplete' }],
    });
  });
  test('source states keep distinct availability copy without calling partial coverage a failure', () => {
    const labels: Readonly<Record<WorkThreadSourceStatus['state'], string>> = {
      ok: 'read date unknown',
      'never-run': 'not connected',
      disabled: 'disabled',
      unavailable: 'unavailable',
      unauthenticated: 'sign-in required',
      failed: 'read failed',
      truncated: 'evidence incomplete',
    };
    for (const [state, label] of Object.entries(labels)) {
      const status = {
        source: 'jira' as const,
        state: state as WorkThreadSourceStatus['state'],
        lastRunAt: null,
        message: null,
      };
      expect(threadSourceAvailability([status], observedAt, 'UTC').summary).toBe(`Jira ${label}`);
    }
  });
});

describe('recorded episode time and elapsed span', () => {
  test('a multi-day conversation shows recorded turn time without substituting its elapsed span', () => {
    const multiDay = { ...episode, activeMs: 14 * 60_000, spanMs: (3 * 24 + 4) * 3_600_000 + 13 * 60_000 };
    expect(episodeDuration(multiDay)).toBe('14 min');
    expect(episodeSpan(multiDay)).toBe('76 h 13');
    expect(episodeSpanContext(multiDay)).toBe('over 3 days');
    expect(episodeDurationDetail(multiDay)).toBe("14 min recorded for this episode · not the task's lifetime");
    expect(episodeDurationDetail(multiDay)).not.toContain('76');
  });
  test('missing turn time remains missing even when its span is known', () => {
    const missing = { ...episode, activeMs: null, spanMs: 5 * 3_600_000 };
    expect(episodeDuration(missing)).toBe('—');
    expect(episodeDurationDetail(missing)).toBe('Duration not recorded for this episode');
    expect(episodeSpan(missing)).toBe('5 h');
    expect(episodeSpanContext(missing)).toBeNull();
    expect(episodeSpan({ ...missing, spanMs: null })).toBe('Span unknown');
  });
  test('hours, zero and sub-minute recorded durations remain readable and distinct from missing', () => {
    expect(episodeDuration({ ...episode, activeMs: 74 * 60_000 })).toBe('1 h 14');
    expect(episodeDuration({ ...episode, activeMs: 60 * 60_000 })).toBe('1 h');
    expect(episodeDuration({ ...episode, activeMs: 0 })).toBe('0 min');
    expect(episodeDuration({ ...episode, activeMs: 20_000 })).toBe('<1 min');
  });
  test('spread context requires both more than twice the active time and more than one hour', () => {
    expect(episodeSpanContext({ ...episode, activeMs: 30 * 60_000, spanMs: 3_600_000 })).toBeNull();
    expect(episodeSpanContext({ ...episode, activeMs: 3 * 3_600_000, spanMs: 6 * 3_600_000 })).toBeNull();
    expect(episodeSpanContext({ ...episode, activeMs: 2 * 3_600_000, spanMs: 5 * 3_600_000 })).toBe('over 5 h');
    expect(episodeSpanContext({ ...episode, activeMs: 14 * 60_000, spanMs: 25 * 3_600_000 })).toBe('over 1 day');
  });
});

describe('the shared task history', () => {
  const openedAt = parseCanonicalInstant('2026-10-20T09:00:00.000Z');
  const linkedAt = parseCanonicalInstant('2026-10-21T09:00:00.000Z');
  const endedAt = parseCanonicalInstant('2026-10-22T09:00:00.000Z');
  const baseEvent: WorkThreadEvent = {
    acknowledgedRemainders: [],
    at: linkedAt,
    eventId: '10000000-0000-4000-8000-000000000001',
    fromState: null,
    kind: 'link-added',
    linkKey: 'session:test/codex/one',
    reason: null,
    threadId: payment.row.thread.threadId,
    toState: null,
  };
  const baseLink: WorkThreadLink = {
    createdAt: linkedAt,
    detachedAt: null,
    key: 'session:test/codex/one',
    kind: 'session',
    linkId: '20000000-0000-4000-8000-000000000001',
    provenance: 'declared',
    threadId: payment.row.thread.threadId,
  };
  const fact: WorkThreadFactEvent = {
    actor: null,
    at: openedAt,
    key: 'github.example/synthetic/shop#72',
    kind: 'pull-request-opened',
    label: 'PR #72',
    title: 'Synthetic checkout change',
  };
  test('source events use their own dates, keep stable distinct identities and disappear in Sessions', () => {
    const data = {
      ...payment,
      episodes: [{ ...episode, startedAt: linkedAt }],
      events: [{ ...baseEvent, kind: 'follow-state' as const, at: endedAt, toState: 'done' as const }],
      factEvents: [fact, { ...fact, at: endedAt, kind: 'pull-request-merged' as const }],
    };
    const all = threadHistory(data, false, 'UTC').flatMap((group) => group.entries);
    expect(all.map((entry) => [entry.kind, entry.at])).toEqual([
      ['fact-event', openedAt],
      ['session', linkedAt],
      ['event', endedAt],
      ['fact-event', endedAt],
    ]);
    expect(new Set(all.map((entry) => entry.id)).size).toBe(4);
    expect(
      threadHistory(data, true, 'UTC')
        .flatMap((group) => group.entries)
        .map((entry) => entry.kind),
    ).toEqual(['session']);
    expect(threadFactEventCopy(fact)).toEqual({ title: 'PR #72 opened', detail: 'Synthetic checkout change' });
    expect(threadFactEventCopy({ ...fact, kind: 'pull-request-merged' }).title).toBe('PR #72 merged');
    expect(threadFactEventCopy({ ...fact, kind: 'pull-request-closed', title: null })).toEqual({
      title: 'PR #72 closed',
      detail: null,
    });
    expect(threadFactEventCopy({ ...fact, actor: 'reviewer', kind: 'pull-request-changes-requested' }).title).toBe(
      'PR #72 changes requested by reviewer',
    );
  });

  test('a day of the lane counts its sessions and follow-up changes and names every mark', () => {
    const mark = (overrides: Partial<WorkThreadMark>): WorkThreadMark => ({
      at: openedAt,
      fact: null,
      harness: null,
      kind: 'event',
      label: 'Waiting',
      source: null,
      ...overrides,
    });
    const day = threadDayMarks(
      [
        mark({ harness: 'claude', kind: 'session', label: 'Fix uploads' }),
        mark({ fact: 'pull-request-approved', label: 'PR #72 approved by reviewer' }),
        mark({ fact: 'pull-request-merged', label: 'PR #72 merged' }),
        mark({}),
      ],
      'Oct 23',
    );
    expect(day.sessions).toHaveLength(1);
    expect(day.others).toBe(1);
    expect(day.description).toBe(
      'Oct 23: 1 session, PR #72 approved by reviewer, PR #72 merged, 1 follow-up change. Show activity.',
    );
    expect(threadDayMarks([mark({}), mark({})], 'Oct 24')).toMatchObject({
      others: 2,
      description: 'Oct 24: 0 sessions, 2 follow-up changes. Show activity.',
    });
  });
  test('each pull request gets one track of its milestones, from its opening to where it ends', () => {
    const day = (offset: number, hour = 9) =>
      parseCanonicalInstant(
        `2026-10-${String(10 + offset).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`,
      );
    const pr = (number: number, observed: WorkThreadMark['at'], milestone: WorkThreadMark['fact']): WorkThreadMark => ({
      at: observed,
      fact: milestone,
      harness: null,
      kind: 'event',
      label: `PR #${number} ${milestone}`,
      source: { key: `github.com/acme/app#${number}`, label: `PR #${number}` },
    });
    const { tracks, hidden } = threadPullRequestTracks(
      [
        { at: day(0), fact: null, harness: 'codex', kind: 'session', label: 'Explore', source: null },
        pr(81, day(1), 'pull-request-opened'),
        pr(81, day(4, 9), 'pull-request-approved'),
        pr(81, day(4, 15), 'pull-request-merged'),
        pr(92, day(3), 'pull-request-ready'),
        pr(92, day(6), 'pull-request-changes-requested'),
        pr(95, day(7), 'pull-request-opened'),
        pr(95, day(8), 'pull-request-closed'),
      ],
      'UTC',
    );
    expect(hidden).toBe(0);
    expect(
      tracks.map(({ label, firstDay, lastDay, openedEarlier, end, steps }) => ({
        label,
        firstDay,
        lastDay,
        openedEarlier,
        end,
        steps: [...steps.values()],
      })),
    ).toEqual([
      {
        label: 'PR #81',
        firstDay: '2026-10-11',
        lastDay: '2026-10-14',
        openedEarlier: false,
        end: 'merged',
        // The merge outranks the approval of the same day.
        steps: ['pull-request-opened', 'pull-request-merged'],
      },
      {
        label: 'PR #92',
        firstDay: '2026-10-13',
        lastDay: '2026-10-16',
        openedEarlier: true,
        end: 'open',
        steps: ['pull-request-ready', 'pull-request-changes-requested'],
      },
      {
        label: 'PR #95',
        firstDay: '2026-10-17',
        lastDay: '2026-10-18',
        openedEarlier: false,
        end: 'closed',
        steps: ['pull-request-opened', 'pull-request-closed'],
      },
    ]);
  });
  test('a lane keeps the most recently active pull requests and leaves the others to the day details', () => {
    const marks = Array.from(
      { length: THREAD_LANE_MAX_TRACKS + 2 },
      (_, index): WorkThreadMark => ({
        at: parseCanonicalInstant(`2026-10-${String(10 + index).padStart(2, '0')}T09:00:00.000Z`),
        fact: 'pull-request-opened',
        harness: null,
        kind: 'event',
        label: `PR #${index} opened`,
        source: { key: `github.com/acme/app#${index}`, label: `PR #${index}` },
      }),
    );
    const { tracks, hidden } = threadPullRequestTracks(marks, 'UTC');
    expect(hidden).toBe(2);
    expect(tracks.map((track) => track.label)).toEqual(['PR #2', 'PR #3', 'PR #4']);
  });
  test.each(['origin', 'declared', 'launched'] as const)(
    'hides %s link-added events even after the link was detached',
    (provenance) => {
      const data = {
        ...payment,
        episodes: [],
        events: [baseEvent],
        factEvents: [],
        row: { ...payment.row, links: [] },
        detachedLinks: [{ ...baseLink, provenance, detachedAt: endedAt }],
      };
      expect(threadHistory(data, false, 'UTC')).toEqual([]);
    },
  );
  test('preserves user links and operator actions; unknown provenance never hides an event', () => {
    const kinds: readonly WorkThreadEvent['kind'][] = [
      'follow-state',
      'link-added',
      'link-detached',
      'note',
      'renamed',
      'wait-satisfied',
    ];
    const events = kinds.map((kind, index) => ({ ...baseEvent, kind, eventId: `event-${index}` }));
    const data = {
      ...payment,
      episodes: [],
      events,
      factEvents: [],
      row: { ...payment.row, links: [{ ...baseLink, provenance: 'user' as const }] },
      detachedLinks: [],
    };
    expect(threadHistory(data, false, 'UTC').flatMap((group) => group.entries)).toHaveLength(kinds.length);
    expect(
      threadHistory({ ...data, row: { ...data.row, links: [] } }, false, 'UTC').flatMap((group) => group.entries),
    ).toHaveLength(kinds.length);
  });
  test('an earlier automatic link does not hide a later explicit re-link', () => {
    const automatic = { ...baseLink, detachedAt: linkedAt };
    const userLink = { ...baseLink, createdAt: endedAt, provenance: 'user' as const };
    const events = [baseEvent, { ...baseEvent, at: endedAt, eventId: 'later-link' }];
    const data = {
      ...payment,
      episodes: [],
      events,
      factEvents: [],
      row: { ...payment.row, links: [userLink] },
      detachedLinks: [automatic],
    };
    const all = threadHistory(data, false, 'UTC').flatMap((group) => group.entries);
    expect(all.map((entry) => entry.id)).toEqual(['later-link']);
  });
  test.each(['pull-request', 'jira-issue'] as const)(
    'hides discovery-created events for %s tasks but retains meaningful facts',
    (origin) => {
      const data = {
        ...payment,
        episodes: [],
        events: [{ ...baseEvent, kind: 'created' as const }],
        factEvents: [fact],
        row: { ...payment.row, thread: { ...payment.row.thread, origin } },
      };
      expect(
        threadHistory(data, false, 'UTC')
          .flatMap((group) => group.entries)
          .map((entry) => entry.kind),
      ).toEqual(['fact-event']);
    },
  );
  test.each(['user', 'session'] as const)('keeps the creation of operator-chosen %s tasks', (origin) => {
    const data = {
      ...payment,
      episodes: [],
      events: [{ ...baseEvent, kind: 'created' as const }],
      factEvents: [],
      row: { ...payment.row, thread: { ...payment.row.thread, origin } },
    };
    expect(
      threadHistory(data, false, 'UTC')
        .flatMap((group) => group.entries)
        .map((entry) => entry.kind),
    ).toEqual(['event']);
  });
});

describe('source availability belongs to the current task', () => {
  const sources: readonly WorkThreadSourceStatus[] = [
    { source: 'github', state: 'unauthenticated', lastRunAt: null, message: 'GitHub authentication unavailable' },
    { source: 'jira', state: 'disabled', lastRunAt: null, message: 'Jira is disabled' },
    { source: 'checkouts', state: 'failed', lastRunAt: null, message: 'Checkout read failed' },
    { source: 'sessions', state: 'truncated', lastRunAt: null, message: 'Linked session evidence incomplete' },
  ];
  const unrelated = {
    ...analysis,
    episodes: [],
    sources,
    row: {
      ...analysis.row,
      links: [],
      markers: { local: [], pullRequests: [], jiraIssues: [] },
      sessionCount: 0,
      delegatedSessionCount: 0,
      runningSessions: 0,
    },
  };
  const linkedSources = [
    ['pull-request', 'github.example/synthetic/shop#72', 'github'],
    ['jira-issue', 'jira:synthetic/SHOP-72', 'jira'],
    ['branch', 'branch:github.example/synthetic/shop@topic', 'checkouts'],
    ['session', 'session:fixture-machine/codex/one', 'sessions'],
  ] as const;
  test.each([false, true])(
    'keeps failed checkout reads visible without Local markers (nested checkout: %s)',
    (nestedCheckout) => {
      const checkoutEpisode: WorkThreadEpisode = {
        ...episode,
        children: [],
        resume: { kind: 'cli-resume', command: 'codex resume fixture', cwd: '/fixture/checkout' },
      };
      const root: WorkThreadEpisode = nestedCheckout
        ? {
            ...checkoutEpisode,
            linkKey: `session:${episode.machineId}/${episode.harness}/root-without-checkout`,
            sourceSessionId: 'root-without-checkout',
            resume: { kind: 'none', reason: 'No root checkout recorded' },
            children: [
              {
                ...checkoutEpisode,
                linkKey: `session:${episode.machineId}/${episode.harness}/middle-without-checkout`,
                sourceSessionId: 'middle-without-checkout',
                children: [checkoutEpisode],
                resume: { kind: 'none', reason: 'Unknown' },
              },
            ],
          }
        : checkoutEpisode;
      const link: WorkThreadLink = {
        createdAt: analysis.generatedAt,
        detachedAt: null,
        key: root.linkKey,
        kind: 'session',
        linkId: '20000000-0000-4000-8000-000000000002',
        provenance: 'user',
        threadId: analysis.row.thread.threadId,
      };
      const data = { ...unrelated, episodes: [root], row: { ...unrelated.row, links: [link] } };
      const selected = taskSourceStatuses(data);
      expect(selected.map((status) => status.source)).toEqual(['checkouts', 'sessions']);
      expect(selected[0]).toBe(sources[2]);
      expect(threadSourceAvailability(selected, analysis.generatedAt, 'UTC')).toMatchObject({
        summary: 'Local read failed',
        details: expect.arrayContaining([
          { source: 'checkouts', label: 'read failed', message: 'Checkout read failed', lastRunAt: null, stale: false },
        ]),
      });
      expect(
        taskSourceStatuses({
          ...data,
          episodes: [],
          row: { ...data.row, links: [{ ...link, detachedAt: analysis.generatedAt }] },
        }),
      ).toEqual([]);
    },
  );
  test('sessions without a known checkout do not inherit unrelated checkout failures', () => {
    const resumes: readonly WorkThreadEpisode['resume'][] = [
      { kind: 'none', reason: 'Resume unavailable' },
      { kind: 'cli-resume', command: 'codex resume fixture', cwd: null },
      { kind: 'cli-resume', command: 'codex resume fixture', cwd: '' },
      { kind: 'cli-resume', command: 'codex resume fixture', cwd: ' \t ' },
    ];
    for (const resume of resumes) {
      const unknownCheckout = { ...episode, children: [], resume };
      expect(taskSourceStatuses({ ...unrelated, episodes: [unknownCheckout] }).map((status) => status.source)).toEqual([
        'sessions',
      ]);
    }
  });
  test.each(linkedSources)(
    'an active %s keeps its source failure even before any marker was observed',
    (kind, key, source) => {
      const link: WorkThreadLink = {
        createdAt: analysis.generatedAt,
        detachedAt: null,
        key,
        kind,
        linkId: '20000000-0000-4000-8000-000000000001',
        provenance: 'user',
        threadId: analysis.row.thread.threadId,
      };
      const data = { ...unrelated, row: { ...unrelated.row, links: [link] } };
      expect(taskSourceStatuses(data)).toEqual(sources.filter((status) => status.source === source));
      expect(taskSourceStatuses(data)[0]?.message).not.toBeNull();
      expect(
        taskSourceStatuses({ ...data, row: { ...data.row, links: [{ ...link, detachedAt: analysis.generatedAt }] } }),
      ).toEqual([]);
      if (kind === 'pull-request') {
        expect(threadDisplayMarkers(data.row).pullRequests[0]).toMatchObject({
          key,
          latest: null,
          latestSuccessful: null,
        });
      }
      if (kind === 'jira-issue') {
        expect(threadDisplayMarkers(data.row).jiraIssues[0]).toMatchObject({
          key,
          latest: null,
          latestSuccessful: null,
        });
      }
    },
  );
  test('observed or unknown task markers also keep their source without requiring a branch link', () => {
    const prMarker = payment.row.markers.pullRequests[0];
    const jiraMarker = payment.row.markers.jiraIssues[0];
    if (!(prMarker && jiraMarker)) {
      throw new Error('Expected artifact fixtures');
    }
    const row = {
      ...unrelated.row,
      markers: {
        local: [
          {
            checkoutPath: '/synthetic/session-checkout',
            key: 'session-checkout',
            lastSessionActivityAt: null,
            via: 'session-checkout' as const,
            latest: null,
            latestSuccessful: null,
          },
        ],
        pullRequests: [{ ...prMarker, latest: null, latestSuccessful: null }],
        jiraIssues: [{ ...jiraMarker, latest: null, latestSuccessful: null }],
      },
    };
    expect(taskSourceStatuses({ ...unrelated, row }).map((status) => status.source)).toEqual([
      'github',
      'jira',
      'checkouts',
    ]);
    expect(row.markers.local[0]?.latest).toBeNull();
  });
  test('linked and delegated counts or nested episode evidence retain partial Sessions status', () => {
    for (const counts of [{ sessionCount: 1 }, { delegatedSessionCount: 1 }, { runningSessions: 1 }]) {
      expect(
        taskSourceStatuses({ ...unrelated, row: { ...unrelated.row, ...counts } }).map((status) => status.source),
      ).toEqual(['sessions']);
    }
    const nested = { ...episode, children: [{ ...episode, children: [] }] };
    expect(taskSourceStatuses({ ...unrelated, episodes: [nested] })).toEqual(
      sources.filter((status) => status.source === 'sessions'),
    );
  });
  test('a PR-only task omits Jira and an analysis only shows its linked Sessions status', () => {
    expect(taskSourceStatuses({ ...review, sources }).map((status) => status.source)).toEqual(['github']);
    expect(taskSourceStatuses({ ...analysis, sources }).map((status) => status.source)).toEqual(['sessions']);
    expect(taskSourceStatuses(unrelated)).toEqual([]);
    expect(taskSourceStatuses({ ...analysis, sources: [] })).toEqual([]);
  });
  test('task filtering preserves source objects while the list keeps the global failures', () => {
    const selected = taskSourceStatuses({ ...review, sources });
    expect(selected[0]).toBe(sources[0]);
    expect(sources).toHaveLength(4);
    const global = threadSourceAvailability(sources, analysis.generatedAt, 'UTC');
    expect(global.summary).toContain('Jira disabled');
    expect(global.details).toHaveLength(4);
    const task = threadSourceAvailability(selected, analysis.generatedAt, 'UTC');
    expect(task.summary).toBe('GitHub sign-in required');
    expect(task.details).toHaveLength(1);
  });
});

test('native requests survive the closing trace and resume the exact asking episode', () => {
  const request = {
    key: 'qualified-request',
    sessionKey: episode.linkKey,
    machineId: episode.machineId,
    harness: episode.harness,
    sourceSessionId: episode.sourceSessionId,
    callId: 'call',
    questionId: 'choice',
    askedAt: episode.startedAt,
    answeredAt: null,
    observedAt: episode.startedAt,
    text: 'Choose the scope?',
    state: 'open' as const,
    evidence: 'codex-request-user-input' as const,
    detail: 'No attributable answer is recorded.',
  };
  const remainder: WorkThreadRemainder = {
    key: request.key,
    observedAt: request.askedAt,
    source: 'sessions',
    kind: 'native-request',
    request,
  };
  expect(acknowledgedRemainderCopy([remainder])[0]).toContain('Native request: Choose the scope?');
  expect(acknowledgedRemainderCopy([remainder])[0]).toContain('qualified-request');
  const asking: WorkThreadEpisode = {
    ...episode,
    running: false,
    nativeRequests: [request],
    resume: { kind: 'cli-resume', command: 'codex resume synthetic', cwd: null },
  };
  expect(primaryResumeEpisode([{ ...episode, linkKey: 'parent', children: [asking] }], 0, asking.linkKey)).toEqual(
    asking,
  );
  expect(primaryResumeEpisode([asking], 0, 'unrelated-session')).toBeNull();
});

const NOW = payment.generatedAt;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const instant = (offsetMs: number) => parseCanonicalInstant(new Date(Date.parse(NOW) + offsetMs).toISOString());
const fixturePullRequest = payment.row.markers.pullRequests[0];
const fixtureCheckout = payment.row.markers.local[0];
const fixtureTicket = payment.row.markers.jiraIssues[0];
const pullRequestFact = fixturePullRequest?.latest;
const checkoutFact = fixtureCheckout?.latest;
const ticketFact = fixtureTicket?.latest;
if (!(fixturePullRequest && fixtureCheckout && fixtureTicket && pullRequestFact && checkoutFact && ticketFact)) {
  throw new Error('Expected the payment task to carry a pull request, a checkout and a ticket');
}
const running = await requireDetail(WORK_THREADS_FIXTURE_IDS.sessions);
const ended = await requireDetail(WORK_THREADS_FIXTURE_IDS.done);
const waiting = await requireDetail(WORK_THREADS_FIXTURE_IDS.badges);

/** An open, green, mergeable pull request of the operator unless patched. */
const pullRequest = (
  patch: Partial<PullRequestObservation> = {},
  marker: Partial<Pick<WorkThreadPullRequestMarker, 'mergeable' | 'mergeStateStatus' | 'role'>> = {},
): WorkThreadPullRequestMarker => {
  const latest = { ...pullRequestFact, reviewDecision: null, unresolvedReviewThreads: 0, ...patch };
  return {
    ...fixturePullRequest,
    ...marker,
    key: `github.example/synthetic/example-shop#${latest.number}`,
    latest,
    latestSuccessful: latest.outcome === 'observed' ? latest : null,
  };
};
const MERGED = { state: 'MERGED', mergedAt: instant(-DAY) } as const;
const CLOSED = { state: 'CLOSED', closedAt: instant(-2 * DAY) } as const;
/** A clean, pushed checkout observed on disk unless patched. */
const checkout = (patch: Partial<CheckoutStatusObservation> = {}): WorkThreadLocalMarker => {
  const latest = { ...checkoutFact, ...patch };
  return { ...fixtureCheckout, latest, latestSuccessful: latest.outcome === 'observed' ? latest : null };
};
const neverReadCheckout: WorkThreadLocalMarker = { ...fixtureCheckout, latest: null, latestSuccessful: null };
/** A checkout read as gone from disk whose last successful read still held local work. */
const lostCheckout: WorkThreadLocalMarker = {
  ...fixtureCheckout,
  latest: { ...checkoutFact, outcome: 'missing' },
  latestSuccessful: { ...checkoutFact, dirty: true, untrackedCount: 1, observedAt: instant(-2 * DAY) },
};
const ticket = (statusCategory: 'todo' | 'in-progress' | 'done' | 'unknown', handedOff = false) => {
  const latest = { ...ticketFact, statusCategory, ...(handedOff ? { handedOff: true as const } : {}) };
  return { ...fixtureTicket, latest, latestSuccessful: latest };
};
const sessionLinks = payment.row.links.filter((item) => item.kind === 'session');
const branchLinks = payment.row.links.filter((item) => item.kind === 'branch');
const pullRequestLinks = payment.row.links.filter((item) => item.kind === 'pull-request');
const ticketLinks = payment.row.links.filter((item) => item.kind === 'jira-issue');
/** The payment task's sessions with only the given artifacts. */
const task = (markers: Partial<WorkThreadMarkers> = {}, patch: Partial<WorkThreadRow> = {}): WorkThreadRow => ({
  ...payment.row,
  links: sessionLinks,
  marks: [],
  markers: { local: [], jiraIssues: [], pullRequests: [], ...markers },
  ...patch,
});
const withoutSessions = { links: [], sessionCount: 0, delegatedSessionCount: 0 } as const;
const copyOf = (row: WorkThreadRow, sources: readonly WorkThreadSourceStatus[] = payment.sources) =>
  threadSituationCopy(row, NOW, sources, 'UTC');
const sessionsSource = (state: WorkThreadSourceStatus['state']): readonly WorkThreadSourceStatus[] => [
  { source: 'sessions', state, lastRunAt: NOW, message: null },
];
const nativeRequest = (patch: Partial<WorkThreadNativeRequest> = {}): WorkThreadNativeRequest => ({
  key: 'request',
  sessionKey: episode.linkKey,
  machineId: episode.machineId,
  harness: 'claude',
  sourceSessionId: episode.sourceSessionId,
  callId: 'call',
  questionId: 'q',
  askedAt: instant(-2 * HOUR),
  answeredAt: null,
  observedAt: NOW,
  text: 'Ship the retry guard as is?',
  state: 'open',
  evidence: 'codex-request-user-input',
  detail: 'No attributable answer.',
  ...patch,
});

describe('the Pilot view and its page size', () => {
  test('only view=pilot selects the Pilot presentation', () => {
    expect(threadView(new URLSearchParams('view=pilot'))).toBe('pilot');
    expect(threadView(new URLSearchParams())).toBe('lanes');
    expect(threadView(new URLSearchParams('view=lanes'))).toBe('lanes');
    expect(threadView(new URLSearchParams('view=timeline'))).toBe('timeline');
    expect(threadView(new URLSearchParams('view=disk'))).toBe('disk');
    expect(threadView(new URLSearchParams('view=unknown'))).toBe('lanes');
    expect(threadView(new URLSearchParams('view=Pilot'))).toBe('lanes');
  });
  test('the Pilot view reads the largest page so its band counters cover the followed set', () => {
    expect(threadListQuery(new URLSearchParams('view=pilot&q=1487')).limit).toBe(WORK_THREAD_VIEW_BOUNDS.maxPageSize);
    expect(threadListQuery(new URLSearchParams('view=pilot'))).toEqual({
      cursor: null,
      limit: 100,
      project: null,
      search: null,
      tab: 'open',
    });
    expect(threadListQuery(new URLSearchParams()).limit).toBe(50);
    expect(threadListQuery(new URLSearchParams('view=lanes')).limit).toBe(50);
  });
  test('only a known band filters the Pilot view', () => {
    for (const { band } of THREAD_BANDS) {
      expect(threadBandFilter(new URLSearchParams(`view=pilot&band=${band}`))).toBe(band);
    }
    expect(threadBandFilter(new URLSearchParams())).toBeNull();
    expect(threadBandFilter(new URLSearchParams('band='))).toBeNull();
    expect(threadBandFilter(new URLSearchParams('band=Yours'))).toBeNull();
    expect(threadBandFilter(new URLSearchParams('band=waiting'))).toBeNull();
  });
});

describe('the second line of a compact row', () => {
  const sessions = '4 sessions · 1 delegated';
  test('pull requests lead with their number and state', () => {
    expect(threadRowMeta(task({ pullRequests: [pullRequest({ draft: true })] }))).toBe(`PR #1487 draft · ${sessions}`);
    expect(
      threadRowMeta(
        task({ pullRequests: [pullRequest({ number: 9, ...MERGED }), pullRequest({ number: 14, draft: true })] }),
      ),
    ).toBe(`PR #9 merged · PR #14 draft · ${sessions}`);
    expect(threadRowMeta(task({ pullRequests: [pullRequest({ reviewDecision: 'CHANGES_REQUESTED' })] }))).toBe(
      `PR #1487 changes requested · ${sessions}`,
    );
  });
  test('more than two pull requests are counted, not listed', () => {
    const pullRequests = [9, 14, 21].map((number) => pullRequest({ number }));
    expect(threadRowMeta(task({ pullRequests }))).toBe(`3 pull requests · ${sessions}`);
  });
  test('a pull request that was not read stays named, with its number from the link', () => {
    expect(threadRowMeta(task({}, { links: [...sessionLinks, ...pullRequestLinks] }))).toBe(
      `PR #1487 state unknown · ${sessions}`,
    );
    expect(threadRowMeta(task({ pullRequests: [pullRequest({ outcome: 'network' })] }))).toBe(
      `PR #1487 state unknown · ${sessions}`,
    );
  });
  test('without a pull request, the first known branch stands in', () => {
    expect(threadRowMeta(task({ local: [checkout()] }))).toBe(`fix/SHOP-2085/payment-retry · ${sessions}`);
    const unnamed = { ...checkout({ branch: null }), key: 'checkout:/synthetic/elsewhere' };
    expect(threadRowMeta(task({ local: [unnamed, checkout({ branch: 'feat/second' })] }))).toBe(
      `feat/second · ${sessions}`,
    );
    // A branch link that was never read on this machine still names its branch.
    expect(threadRowMeta(task({ local: [neverReadCheckout] }))).toBe(`fix/SHOP-2085/payment-retry · ${sessions}`);
    expect(threadRowMeta(task({}, { links: [...sessionLinks, ...branchLinks] }))).toBe(
      `fix/SHOP-2085/payment-retry · ${sessions}`,
    );
    expect(threadRowMeta(task({ local: [unnamed] }))).toBe(sessions);
    // The pull request says more than its branch.
    expect(threadRowMeta(task({ pullRequests: [pullRequest()], local: [checkout()] }))).toBe(
      `PR #1487 open · ${sessions}`,
    );
  });
  test('sessions are worded as this machine read them, and combined tasks are counted with this one', () => {
    expect(threadRowMeta(task({}, withoutSessions))).toBe('No sessions on this machine');
    expect(threadRowMeta(task({}, { sessionCount: 1, delegatedSessionCount: 0 }))).toBe('1 session');
    const combinedThreads = [
      { threadId: '12000000-0000-4000-8000-000000000201', title: 'First' },
      { threadId: '12000000-0000-4000-8000-000000000202', title: 'Second' },
    ];
    expect(threadRowMeta(task({ pullRequests: [pullRequest(MERGED)] }, { combinedThreads }))).toBe(
      `PR #1487 merged · ${sessions} · combines 3 tasks`,
    );
  });
});

describe('a task headline is a gesture; what was not read comes second', () => {
  test('a merged PR whose checkout was never read on this machine reads as an end', () => {
    for (const row of [
      task({ pullRequests: [pullRequest(MERGED)] }, { links: [...sessionLinks, ...branchLinks] }),
      task({ pullRequests: [pullRequest(MERGED)], local: [neverReadCheckout] }),
      task({ pullRequests: [pullRequest(MERGED)], local: [checkout({ outcome: 'denied' })] }),
    ]) {
      const copy = copyOf(row);
      expect(copy).toMatchObject({
        hint: 'ready-to-close',
        label: 'Ready to close',
        reason: 'merged-complete',
        action: 'end-follow-up',
        headline: 'End follow-up',
        caption: 'PR #1487 merged · checkout not read on this machine. Deployment is not established.',
      });
      expect(copy.note).toBe(copy.caption);
      // The unread source is still listed, so ending the follow-up still acknowledges it.
      expect(copy.remainders.filter((item) => item.source === 'local').map((item) => item.kind)).toEqual([
        row.markers.local[0]?.latest ? 'source-unavailable' : 'source-unknown',
      ]);
    }
  });
  test('a merged PR with files left in its checkout asks to check them, never to remove a checkout', () => {
    const left = (patch: Partial<CheckoutStatusObservation>) =>
      copyOf(task({ pullRequests: [pullRequest(MERGED)], local: [checkout({ dirty: true, ...patch })] }));
    expect(left({ untrackedCount: 1 })).toMatchObject({
      hint: 'to-resume',
      reason: 'local-files',
      headline: 'Check 1 local change, end follow-up',
      caption: 'Local · Oct 24',
      note: null,
    });
    expect(left({ modifiedCount: 2, stagedCount: 1 }).headline).toBe('Check 3 local changes, end follow-up');
    // A dirty checkout whose counts git did not report never reads "0 changes".
    expect(left({}).headline).toBe('Check local changes, end follow-up');
    expect(
      copyOf(task({ pullRequests: [pullRequest(CLOSED)], local: [checkout({ dirty: true, untrackedCount: 1 })] }))
        .headline,
    ).toBe('Check 1 local change, end follow-up');
    // Without a settled pull request the files are ordinary work.
    expect(copyOf(task({ local: [checkout({ dirty: true, untrackedCount: 1 })] })).headline).toBe(
      'Commit or discard 1 local change',
    );
  });
  test('a merged PR with a clean checkout still on disk only ends the follow-up and names the checkout', () => {
    // The list cannot tell a dedicated worktree from a primary clone, so it never asks to remove one.
    expect(copyOf(task({ pullRequests: [pullRequest(MERGED)], local: [checkout()] }))).toMatchObject({
      hint: 'ready-to-close',
      reason: 'merged-complete',
      headline: 'End follow-up',
      caption: 'PR #1487 merged · checkout still on disk. Deployment is not established.',
    });
  });
  test('a suggested end names every unread source after the disk', () => {
    const staleRead = { ...MERGED, observedAt: instant(-8 * DAY) };
    expect(copyOf(task({ pullRequests: [pullRequest(MERGED)] }), sessionsSource('truncated')).caption).toBe(
      'PR #1487 merged · sessions not fully read. Deployment is not established.',
    );
    expect(copyOf(task({ pullRequests: [pullRequest(MERGED)], jiraIssues: [ticket('unknown')] })).caption).toBe(
      'PR #1487 merged · ticket not read. Deployment is not established.',
    );
    expect(copyOf(task({ pullRequests: [pullRequest(staleRead)] })).caption).toBe(
      'PR #1487 merged · pull request read not current. Deployment is not established.',
    );
    const everything = copyOf(
      task({ pullRequests: [pullRequest(staleRead)], local: [checkout()], jiraIssues: [ticket('unknown')] }),
      sessionsSource('failed'),
    );
    expect(everything).toMatchObject({ hint: 'ready-to-close', reason: 'merged-complete', headline: 'End follow-up' });
    expect(everything.caption).toBe(
      'PR #1487 merged · checkout still on disk · sessions not fully read · ticket not read · ' +
        'pull request read not current. Deployment is not established.',
    );
    expect(everything.note).toBe(everything.caption);
    // Each source is named once, however many of its reads are missing.
    const twice = copyOf(
      task({ pullRequests: [pullRequest(MERGED)] }, { nativeRequestCoverage: 'partial' }),
      sessionsSource('truncated'),
    );
    expect(twice.remainders.filter((item) => item.source === 'sessions')).toHaveLength(2);
    expect(twice.caption).toBe('PR #1487 merged · sessions not fully read. Deployment is not established.');
    expect(
      copyOf(task({ pullRequests: [pullRequest(CLOSED)], local: [neverReadCheckout] }), sessionsSource('truncated'))
        .caption,
    ).toBe('PR #1487 closed without merge · checkout not read on this machine · sessions not fully read');
  });
  test('a merged PR whose checkout went missing with local work says where that work was last seen', () => {
    const copy = copyOf(task({ pullRequests: [pullRequest(MERGED)], local: [lostCheckout] }));
    expect(copy).toMatchObject({
      hint: 'ready-to-close',
      reason: 'merged-complete',
      headline: 'End follow-up',
      caption:
        'PR #1487 merged · checkout gone from disk, local work was last seen there. Deployment is not established.',
    });
    expect(copy.remainders.map((item) => [item.source, item.kind])).toEqual([['local', 'source-unavailable']]);
    // Without a pull request the loss is what the task waits on.
    expect(copyOf(task({ local: [lostCheckout] }))).toMatchObject({
      hint: 'undecided',
      reason: 'source-unavailable',
      headline: 'Choose the next step',
      caption: 'Checkout gone from disk · local work was last seen there · Local · Oct 24',
    });
  });
  test('a merged PR whose checkouts are all gone from disk only ends the follow-up', () => {
    const copy = copyOf(
      task({
        pullRequests: [pullRequest(MERGED)],
        local: [checkout({ outcome: 'missing' }), checkout({ outcome: 'missing', checkoutPath: '/synthetic/other' })],
      }),
    );
    expect(copy).toMatchObject({
      hint: 'ready-to-close',
      headline: 'End follow-up',
      caption: 'PR #1487 merged · checkout gone from disk. Deployment is not established.',
      remainders: [],
    });
  });
  test('the merged caption states only facts: the PRs that merged, never tickets or an empty disk', () => {
    const alone = copyOf(task({ pullRequests: [pullRequest(MERGED)] }));
    expect(alone.caption).toBe('PR #1487 merged. Deployment is not established.');
    expect(alone.headline).toBe('End follow-up');
    expect(
      copyOf(task({ pullRequests: [pullRequest(MERGED), pullRequest({ ...MERGED, number: 1490 })] })).caption,
    ).toBe('2 PRs merged. Deployment is not established.');
    // A superseded attempt closed without merge does not count as merged, and is named as what it is.
    expect(
      copyOf(task({ pullRequests: [pullRequest({ ...CLOSED, number: 1480 }), pullRequest(MERGED)] })).caption,
    ).toBe('PR #1487 merged · PR #1480 closed without merge. Deployment is not established.');
    expect(
      copyOf(
        task({
          pullRequests: [
            pullRequest({ ...CLOSED, number: 1480 }),
            pullRequest({ ...CLOSED, number: 1481 }),
            pullRequest(MERGED),
          ],
          local: [checkout()],
        }),
      ).caption,
    ).toBe('PR #1487 merged · 2 PRs closed without merge · checkout still on disk. Deployment is not established.');
    const onDisk = copyOf(task({ pullRequests: [pullRequest(MERGED)], local: [checkout()] }));
    for (const caption of [alone.caption, onDisk.caption]) {
      expect(caption).not.toContain('ticket');
      expect(caption).not.toContain('no local remainder');
    }
  });
  test('a PR closed without merge reads as an end too, without a deployment caveat', () => {
    const closed = copyOf(task({ pullRequests: [pullRequest(CLOSED)] }));
    expect(closed).toMatchObject({
      hint: 'ready-to-close',
      reason: 'closed-unmerged',
      action: 'end-follow-up',
      headline: 'End follow-up',
      caption: 'PR #1487 closed without merge',
    });
    expect(closed.note).toBe(closed.caption);
    expect(copyOf(task({ pullRequests: [pullRequest(CLOSED)], local: [checkout()] }))).toMatchObject({
      headline: 'End follow-up',
      caption: 'PR #1487 closed without merge · checkout still on disk',
    });
    expect(
      copyOf(
        task({
          pullRequests: [pullRequest(CLOSED), pullRequest({ ...CLOSED, number: 1490 })],
          local: [checkout({ outcome: 'missing' })],
        }),
      ).caption,
    ).toBe('2 PRs closed without merge · checkout gone from disk');
  });
  test('failing checks stay the gesture while the sessions read is truncated', () => {
    const copy = copyOf(
      task({ pullRequests: [pullRequest({ checksRollup: 'failure' })] }),
      sessionsSource('truncated'),
    );
    expect(copy).toMatchObject({
      hint: 'to-resume',
      reason: 'failing-checks',
      headline: 'Fix checks on #1487',
      caption: 'GitHub · Oct 24',
      note: null,
    });
    expect(copy.remainders.map((item) => item.kind)).toEqual(['failing-checks', 'source-unavailable']);
  });
  test('a task ranked only by an unread source asks for a choice and keeps the source state visible', () => {
    expect(copyOf(analysis.row, sessionsSource('failed'))).toMatchObject({
      hint: 'undecided',
      label: 'To decide',
      reason: 'source-unavailable',
      headline: 'Choose the next step',
      caption: 'Sessions read: failed · Sessions · Oct 24',
      note: null,
    });
    expect(copyOf(analysis.row, sessionsSource('truncated')).caption).toBe(
      'Sessions evidence incomplete · Sessions · Oct 24',
    );
    expect(copyOf(task({ local: [neverReadCheckout] }))).toMatchObject({
      hint: 'undecided',
      reason: 'source-unknown',
      headline: 'Choose the next step',
      caption: 'Local state is unknown · Local · date unknown',
    });
  });
  test('an open native request names the agent and its question', () => {
    const row = task(
      { pullRequests: [pullRequest({ checksRollup: 'pending' })] },
      { nativeRequests: [nativeRequest()] },
    );
    expect(copyOf(row)).toMatchObject({
      hint: 'to-resume',
      reason: 'native-request',
      action: 'resume-session',
      headline: 'Answer Claude: Ship the retry guard as is?',
      caption: 'Sessions · Oct 24',
      note: null,
    });
    expect(copyOf({ ...row, nativeRequests: [nativeRequest({ state: 'uncertain' })] }).headline).toBe(
      'Answer Claude: Ship the retry guard as is? (answer unknown)',
    );
  });
  test('a review with nothing left, a change with no known end and running work keep distinct copy', () => {
    const reviewed = copyOf({ ...analysis.row, thread: { ...analysis.row.thread, intent: 'review' } });
    expect(reviewed).toMatchObject({
      reason: 'no-remainder',
      headline: 'End follow-up',
      caption: 'The review is done. Nothing known is left.',
    });
    expect(reviewed.note).toBe(reviewed.caption);
    expect(copyOf(task())).toMatchObject({
      hint: 'undecided',
      reason: 'next-step',
      headline: 'Choose the next step',
      caption: 'Follow-up stays yours to end',
      note: null,
    });
    expect(copyOf(running.row)).toMatchObject({
      hint: 'in-progress',
      label: 'In progress',
      reason: 'running-session',
      headline: '1 session running',
      caption: 'Sessions · Oct 24',
      note: null,
    });
  });
  test('an ended follow-up and an explicit wait keep their wording', () => {
    const done = copyOf(ended.row);
    expect(done).toMatchObject({
      hint: 'done',
      label: 'Done',
      headline: 'You ended this follow-up',
      caption: 'History and links stay available.',
    });
    expect(done.note).toBe(done.caption);
    const wait = copyOf(waiting.row);
    expect(wait).toMatchObject({
      hint: 'waiting',
      label: 'Waiting',
      headline: 'A product answer on SHOP-1998',
      caption: 'No session needs to keep running while you wait.',
    });
    expect(wait.note).toBe(wait.caption);
  });
  test('sessions are counted where they ran, never guessed elsewhere', () => {
    expect(threadSessionsLabel(task({}, withoutSessions))).toBe('No sessions on this machine');
    expect(threadSessionsLabel(task({}, { sessionCount: 1, delegatedSessionCount: 0 }))).toBe('1 session');
    expect(threadSessionsLabel(task())).toBe('4 sessions · 1 delegated');
    expect(threadSessionsLabel(task({}, { sessionCount: 0, delegatedSessionCount: 2 }))).toBe(
      '0 sessions · 2 delegated',
    );
  });
});

describe('bands say whose move it is', () => {
  const situation = (
    hint: WorkThreadSituation['hint'],
    reason: WorkThreadSituation['reason'],
  ): Pick<WorkThreadSituation, 'hint' | 'reason' | 'remainders'> => ({ hint, reason, remainders: [] });
  const fresh = task();
  const stale = task({}, { lastActivityAt: instant(-8 * DAY) });
  const delivered = task({ pullRequests: [pullRequest(MERGED)] });
  const abandoned = task({ pullRequests: [pullRequest(CLOSED)] });

  test('the bands keep their order, labels and notes', () => {
    expect(THREAD_BANDS.map((item) => [item.band, item.label, item.note])).toEqual([
      ['yours', 'Yours', 'An answer, a fix or a merge waits on you'],
      ['in-flight', 'In flight', 'Recent activity, nothing waits on you'],
      ['to-tidy', 'To tidy', 'Delivered, closed or finished: tidy up and end the follow-up'],
      ['dormant', 'Dormant', 'No activity for 7 days or more'],
      ['done', 'Done', 'Follow-up ended'],
    ]);
  });
  test('an ended follow-up is done, however old', () => {
    expect(threadBand(stale, situation('done', 'follow-up-ended'), NOW)).toBe('done');
    expect(threadBand(fresh, situation('done', 'follow-up-ended'), NOW)).toBe('done');
  });
  test('a task ready to close is to tidy, however old', () => {
    expect(threadBand(delivered, situation('ready-to-close', 'merged-complete'), NOW)).toBe('to-tidy');
    expect(threadBand(stale, situation('ready-to-close', 'no-remainder'), NOW)).toBe('to-tidy');
  });
  test('a delivered or closed task with files, a ticket or no recent activity left is to tidy', () => {
    for (const row of [delivered, abandoned]) {
      expect(threadBand(row, situation('to-resume', 'local-files'), NOW)).toBe('to-tidy');
      expect(threadBand(row, situation('to-resume', 'jira-open'), NOW)).toBe('to-tidy');
      // Another known step on a delivered task is still the operator's move while it is recent.
      expect(threadBand(row, situation('to-resume', 'native-request'), NOW)).toBe('yours');
      expect(threadBand(row, situation('to-resume', 'unpushed-commits'), NOW)).toBe('yours');
      const old = { ...row, lastActivityAt: instant(-8 * DAY) };
      expect(threadBand(old, situation('to-resume', 'native-request'), NOW)).toBe('to-tidy');
      expect(threadBand(old, situation('waiting', 'jira-after-merge'), NOW)).toBe('to-tidy');
    }
    // Without a settled pull request, local files are ordinary work.
    expect(threadBand(fresh, situation('to-resume', 'local-files'), NOW)).toBe('yours');
  });
  test('an undelivered task without activity for more than seven days is dormant, whatever its hint', () => {
    for (const [hint, reason] of [
      ['to-resume', 'failing-checks'],
      ['undecided', 'source-unknown'],
      ['waiting', 'awaiting-review'],
      ['waiting', 'explicit-wait'],
      ['in-progress', 'running-session'],
    ] as const) {
      expect(threadBand(stale, situation(hint, reason), NOW)).toBe('dormant');
    }
  });
  test('recent work that does not wait on the operator is in flight, a task to decide included', () => {
    expect(threadBand(fresh, situation('in-progress', 'running-session'), NOW)).toBe('in-flight');
    expect(threadBand(fresh, situation('waiting', 'pending-checks'), NOW)).toBe('in-flight');
    expect(threadBand(fresh, situation('waiting', 'explicit-wait'), NOW)).toBe('in-flight');
    // Nothing known waits on the operator: an unread source or an optional team review is not a step owed.
    for (const reason of ['source-unknown', 'source-stale', 'next-step', 'team-review-requested'] as const) {
      expect(threadBand(fresh, situation('undecided', reason), NOW)).toBe('in-flight');
    }
  });
  test('yours holds only recent work with a step that waits on the operator', () => {
    for (const reason of ['failing-checks', 'native-request', 'ready-to-merge', 'unpushed-commits'] as const) {
      expect(threadBand(fresh, situation('to-resume', reason), NOW)).toBe('yours');
    }
  });
  test('a commit made today keeps a task out of dormant, whatever the age of its last session', () => {
    const silent = { lastActivityAt: instant(-8 * DAY) };
    const committed = task({ local: [checkout({ ahead: 2, lastCommitAt: instant(-HOUR) })] }, silent);
    const current = copyOf(committed);
    expect(current.reason).toBe('unpushed-commits');
    expect(threadWaitSince(committed, current)).toEqual({ at: instant(-HOUR), basis: 'last-commit' });
    expect(threadBand(committed, current, NOW)).toBe('yours');
    // The same task whose last commit is as old as its last session is dormant.
    const idle = task({ local: [checkout({ ahead: 2, lastCommitAt: instant(-9 * DAY) })] }, silent);
    expect(threadBand(idle, copyOf(idle), NOW)).toBe('dormant');
    // The later of the two dates counts: an old commit does not age a task with a recent session.
    const active = task({ local: [checkout({ ahead: 2, lastCommitAt: instant(-9 * DAY) })] });
    expect(threadBand(active, copyOf(active), NOW)).toBe('yours');
    // A delivered task with a fresh commit is not left behind by silence alone.
    const resumed = task(
      { pullRequests: [pullRequest(MERGED)], local: [checkout({ ahead: 1, lastCommitAt: instant(-HOUR) })] },
      silent,
    );
    expect(copyOf(resumed).reason).toBe('unpushed-commits');
    expect(threadBand(resumed, copyOf(resumed), NOW)).toBe('yours');
  });
  test('seven days exactly is not yet dormant; one millisecond more is', () => {
    const resume = situation('to-resume', 'failing-checks');
    expect(threadBand(task({}, { lastActivityAt: instant(-7 * DAY) }), resume, NOW)).toBe('yours');
    expect(threadBand(task({}, { lastActivityAt: instant(-7 * DAY - 1) }), resume, NOW)).toBe('dormant');
    expect(() => threadBand(fresh, resume, 'not a date')).toThrow(RangeError);
  });
  test('derived situations land in the expected bands', () => {
    const bandOf = (row: WorkThreadRow) => threadBand(row, copyOf(row), NOW);
    expect(bandOf(payment.row)).toBe('yours');
    expect(bandOf(running.row)).toBe('in-flight');
    expect(bandOf(ended.row)).toBe('done');
    expect(bandOf(task({ pullRequests: [pullRequest({ checksRollup: 'pending' })] }))).toBe('in-flight');
    expect(bandOf(task({ pullRequests: [pullRequest(MERGED)] }, { links: [...sessionLinks, ...branchLinks] }))).toBe(
      'to-tidy',
    );
    expect(
      bandOf(task({ pullRequests: [pullRequest(MERGED)], local: [checkout({ dirty: true, untrackedCount: 1 })] })),
    ).toBe('to-tidy');
    expect(bandOf(task({ pullRequests: [pullRequest(MERGED)], jiraIssues: [ticket('in-progress')] }))).toBe('to-tidy');
    // A task ranked only by an unread source owes the operator no known step.
    expect(copyOf(task({ local: [neverReadCheckout] })).hint).toBe('undecided');
    expect(bandOf(task({ local: [neverReadCheckout] }))).toBe('in-flight');
    expect(bandOf(task())).toBe('in-flight');
  });

  const numbered = (suffix: number): WorkThreadRow =>
    task({}, { thread: { ...payment.row.thread, threadId: `12000000-0000-4000-8000-0000000001${suffix}` } });
  const [first, second, third, fourth, fifth, sixth] = [10, 11, 12, 13, 14, 15].map(numbered);
  if (!(first && second && third && fourth && fifth && sixth)) {
    throw new Error('Expected six band fixtures');
  }
  const placed = new Map<string, { readonly band: ThreadBand; readonly since: string }>([
    [first.thread.threadId, { band: 'yours', since: instant(-DAY) }],
    [second.thread.threadId, { band: 'yours', since: instant(-3 * DAY) }],
    [third.thread.threadId, { band: 'yours', since: instant(-3 * DAY) }],
    [fourth.thread.threadId, { band: 'dormant', since: instant(-20 * DAY) }],
    [fifth.thread.threadId, { band: 'dormant', since: instant(-9 * DAY) }],
    [sixth.thread.threadId, { band: 'done', since: instant(-2 * DAY) }],
  ]);
  const placeOf = (row: WorkThreadRow) => {
    const place = placed.get(row.thread.threadId);
    if (!place) {
      throw new Error(`No band fixture for ${row.thread.threadId}`);
    }
    return place;
  };
  const rows = [first, third, second, fourth, fifth, sixth];
  const group = (input: readonly WorkThreadRow[]) =>
    groupThreadRowsByBand(
      input,
      (row) => placeOf(row).band,
      (row) => placeOf(row).since,
    );

  test('groups keep the band order, skip empty bands and carry the list group shape', () => {
    const groups = group(rows);
    expect(groups.map((item) => item.band)).toEqual(['yours', 'dormant', 'done']);
    expect(groups[0]).toEqual({
      band: 'yours',
      project: 'Yours',
      label: 'Yours',
      note: 'An answer, a fix or a merge waits on you',
      tasks: [second, third, first],
    });
    expect(group([])).toEqual([]);
  });
  test('the longest wait leads a band, ties fall back to the task id, and dormant shows the most recent first', () => {
    const groups = group(rows);
    expect(groups[0]?.tasks.map((row) => row.thread.threadId)).toEqual(
      [second, third, first].map((row) => row.thread.threadId),
    );
    expect(groups[1]?.tasks).toEqual([fifth, fourth]);
    const tied = new Map(placed);
    tied.set(fourth.thread.threadId, { band: 'dormant', since: instant(-9 * DAY) });
    expect(
      groupThreadRowsByBand(
        [fifth, fourth],
        () => 'dormant',
        (row) => tied.get(row.thread.threadId)?.since ?? NOW,
      )[0]?.tasks,
    ).toEqual([fourth, fifth]);
  });
  test('ended follow-ups show the most recent first, like dormant tasks', () => {
    const tasksIn = (band: ThreadBand) =>
      groupThreadRowsByBand(
        [fourth, sixth, fifth],
        () => band,
        (row) => placeOf(row).since,
      )[0]?.tasks;
    expect(tasksIn('done')).toEqual([sixth, fifth, fourth]);
    expect(tasksIn('dormant')).toEqual([sixth, fifth, fourth]);
    expect(tasksIn('to-tidy')).toEqual([fourth, fifth, sixth]);
  });
  test('the order does not depend on the order rows were collected in', () => {
    expect(group([...rows].reverse())).toEqual(group(rows));
    expect(group([sixth, fifth, first, fourth, second, third])).toEqual(group(rows));
  });
  test('counts name every band, empty ones included', () => {
    expect(threadBandCounts(rows, (row) => placeOf(row).band)).toEqual({
      yours: 3,
      'in-flight': 0,
      'to-tidy': 0,
      dormant: 2,
      done: 1,
    });
    expect(threadBandCounts([], () => 'yours')).toEqual({
      yours: 0,
      'in-flight': 0,
      'to-tidy': 0,
      dormant: 0,
      done: 0,
    });
  });
});

describe('a wait is dated by its source, never by a collection', () => {
  const waitOf = (row: WorkThreadRow) => threadWaitSince(row, copyOf(row));
  const milestone = (at: WorkThreadMark['at'], fact: WorkThreadMark['fact'], number = 1487): WorkThreadMark => ({
    at,
    fact,
    harness: null,
    kind: 'event',
    label: null,
    source: { key: `github.example/synthetic/example-shop#${number}`, label: `PR #${number}` },
  });
  test('an agent question dates the wait from the earliest question still asked', () => {
    const row = task(
      {},
      {
        nativeRequests: [
          nativeRequest({ key: 'late', askedAt: instant(-2 * HOUR) }),
          nativeRequest({ key: 'early', askedAt: instant(-5 * HOUR) }),
          nativeRequest({ key: 'undated', askedAt: null }),
        ],
      },
    );
    expect(waitOf(row)).toEqual({ at: instant(-5 * HOUR), basis: 'asked' });
    expect(waitOf({ ...row, nativeRequests: [nativeRequest({ askedAt: null })] })).toEqual({
      at: row.lastActivityAt,
      basis: 'activity',
    });
  });
  test('a delivered task waits since its latest merge', () => {
    const row = task({
      pullRequests: [
        pullRequest({ ...MERGED, mergedAt: instant(-3 * DAY) }),
        pullRequest({ ...MERGED, mergedAt: instant(-DAY), number: 1490 }),
        pullRequest({ ...CLOSED, closedAt: instant(-HOUR), number: 1491 }),
      ],
    });
    expect(copyOf(row).reason).toBe('merged-complete');
    expect(waitOf(row)).toEqual({ at: instant(-DAY), basis: 'merged' });
    expect(waitOf(task({ pullRequests: [pullRequest({ ...MERGED, mergedAt: null })] }))).toEqual({
      at: payment.row.lastActivityAt,
      basis: 'activity',
    });
  });
  test('a task closed without merge waits since its latest closing', () => {
    const row = task({
      pullRequests: [
        pullRequest({ ...CLOSED, closedAt: instant(-4 * DAY) }),
        pullRequest({ ...CLOSED, closedAt: instant(-2 * DAY), number: 1490 }),
      ],
    });
    expect(waitOf(row)).toEqual({ at: instant(-2 * DAY), basis: 'closed' });
    expect(waitOf(task({ pullRequests: [pullRequest({ state: 'CLOSED', closedAt: null })] })).basis).toBe('activity');
  });
  test('a pull request step waits since its latest milestone, else since the pull request opened', () => {
    const failing = pullRequest({ checksRollup: 'failure', createdAt: instant(-6 * DAY) });
    const marks: readonly WorkThreadMark[] = [
      milestone(instant(-6 * DAY), 'pull-request-opened'),
      milestone(instant(-2 * DAY), 'pull-request-approved'),
      // Another pull request and a session are not milestones of this one.
      milestone(instant(-DAY), 'pull-request-merged', 1490),
      { at: instant(-HOUR), fact: null, harness: 'claude', kind: 'session', label: null, source: null },
    ];
    const row = task({ pullRequests: [failing] }, { marks });
    expect(copyOf(row).reason).toBe('failing-checks');
    expect(waitOf(row)).toEqual({ at: instant(-2 * DAY), basis: 'pull-request' });
    expect(waitOf({ ...row, marks: [] })).toEqual({ at: instant(-6 * DAY), basis: 'pull-request' });
    // The observation date of the pull request is never the start of a wait.
    expect(failing.latest?.observedAt).toBe(NOW);
    expect(waitOf(task({ pullRequests: [pullRequest({ checksRollup: 'failure', createdAt: null })] }))).toEqual({
      at: payment.row.lastActivityAt,
      basis: 'activity',
    });
  });
  test('local work waits since the last commit of its checkout', () => {
    const dirty = task({ local: [checkout({ dirty: true, modifiedCount: 2, lastCommitAt: instant(-4 * DAY) })] });
    expect(copyOf(dirty).reason).toBe('local-files');
    expect(waitOf(dirty)).toEqual({ at: instant(-4 * DAY), basis: 'last-commit' });
    const unpushed = task({ local: [checkout({ ahead: 2, lastCommitAt: instant(-3 * DAY) })] });
    expect(copyOf(unpushed).reason).toBe('unpushed-commits');
    expect(waitOf(unpushed)).toEqual({ at: instant(-3 * DAY), basis: 'last-commit' });
    expect(waitOf(task({ local: [checkout({ ahead: 2, lastCommitAt: null })] })).basis).toBe('activity');
  });
  test('any other reason waits since the last activity', () => {
    const open = task({ jiraIssues: [ticket('in-progress')] });
    expect(copyOf(open).reason).toBe('jira-open');
    expect(waitOf(open)).toEqual({ at: open.lastActivityAt, basis: 'activity' });
    expect(waitOf(task())).toEqual({ at: payment.row.lastActivityAt, basis: 'activity' });
    expect(waitOf(running.row)).toEqual({ at: running.row.lastActivityAt, basis: 'activity' });
  });
  test('each basis has its label', () => {
    expect(
      (['asked', 'pull-request', 'merged', 'closed', 'last-commit', 'activity'] as const).map(threadWaitSinceLabel),
    ).toEqual(['Asked', 'PR status since', 'Merged', 'Closed', 'Last commit', 'Last activity']);
  });
  test.each([
    [-5000, 'now'],
    [0, 'now'],
    [59_999, 'now'],
    [60_000, '1 min'],
    [59 * 60_000 + 59_999, '59 min'],
    [HOUR, '1 h'],
    [48 * HOUR - 1, '47 h'],
    [48 * HOUR, '2 d'],
    [14 * DAY - 1, '13 d'],
    [14 * DAY, '2 w'],
    [30 * DAY, '4 w'],
  ])('an age of %d ms reads %s', (elapsed, expected) => {
    expect(threadAge(instant(-elapsed), NOW)).toBe(expected);
  });
  test('an age needs two valid instants', () => {
    expect(() => threadAge('not a date', NOW)).toThrow(RangeError);
    expect(() => threadAge(NOW, 'not a date')).toThrow(RangeError);
  });
});

describe('the lifecycle rail', () => {
  const stepOf = (
    row: WorkThreadRow,
    key: ThreadLifecycleStep['key'],
    sources: readonly WorkThreadSourceStatus[] = payment.sources,
  ) => {
    const step = threadLifecycle(row, copyOf(row, sources).remainders).find((item) => item.key === key);
    if (!step) {
      throw new Error(`Missing lifecycle step ${key}`);
    }
    return { state: step.state, detail: step.detail };
  };
  const statesOf = (row: WorkThreadRow) =>
    threadLifecycle(row, copyOf(row).remainders).map((step) => `${step.key}:${step.state}`);

  test('always shows the same eight positions in the same order', () => {
    const fixed = THREAD_LIFECYCLE_STEPS.map((step) => [step.key, step.short, step.name]);
    expect(fixed).toEqual([
      ['sessions', 'Sess', 'Sessions'],
      ['push', 'Push', 'Push'],
      ['pull-request', 'PR', 'Pull request'],
      ['checks', 'CI', 'Checks'],
      ['review', 'Rev', 'Review'],
      ['merge', 'Merge', 'Merge'],
      ['disk', 'Disk', 'Disk'],
      ['ticket', 'Ticket', 'Ticket'],
    ]);
    for (const row of [payment.row, analysis.row, review.row, ended.row, task({}, withoutSessions)]) {
      const steps = threadLifecycle(row, copyOf(row).remainders);
      expect(steps.map((step) => [step.key, step.short, step.name])).toEqual(fixed);
      expect(steps.every((step) => step.detail.length > 0)).toBe(true);
    }
  });
  test('reads a task in review end to end, with a text equivalent', () => {
    const steps = threadLifecycle(payment.row, copyOf(payment.row).remainders);
    expect(steps.map((step) => [step.key, step.state, step.detail])).toEqual([
      ['sessions', 'done', '4 sessions · 1 delegated'],
      ['push', 'done', 'Pushed · a pull request exists'],
      ['pull-request', 'done', '#1487 open'],
      ['checks', 'done', 'Checks pass'],
      ['review', 'yours', 'Changes requested on #1487'],
      ['merge', 'upcoming', 'Not merged yet'],
      ['disk', 'upcoming', 'Checkout on disk'],
      ['ticket', 'upcoming', 'SHOP-2085 follows the open pull request'],
    ]);
    expect(threadLifecycleSummary(steps)).toBe(
      'Sessions: 4 sessions · 1 delegated; Push: Pushed · a pull request exists; Pull request: #1487 open; ' +
        'Checks: Checks pass; Review: Changes requested on #1487; Merge: Not merged yet; Disk: Checkout on disk; ' +
        'Ticket: SHOP-2085 follows the open pull request',
    );
    expect(threadLifecycleSummary([])).toBe('');
  });
  test('an analysis has sessions and nothing else', () => {
    expect(statesOf(analysis.row)).toEqual([
      'sessions:done',
      'push:none',
      'pull-request:none',
      'checks:none',
      'review:none',
      'merge:none',
      'disk:none',
      'ticket:none',
    ]);
    expect(stepOf(analysis.row, 'disk').detail).toBe('No checkout linked');
    expect(stepOf(analysis.row, 'ticket').detail).toBe('No ticket');
    expect(stepOf(analysis.row, 'pull-request').detail).toBe('No pull request');
  });
  test('failing checks fail the checks step; running checks run it; unreported checks are unread', () => {
    expect(stepOf(task({ pullRequests: [pullRequest({ checksRollup: 'failure' })] }), 'checks')).toEqual({
      state: 'failed',
      detail: 'Checks failing on #1487',
    });
    expect(stepOf(task({ pullRequests: [pullRequest({ checksRollup: 'pending' })] }), 'checks')).toEqual({
      state: 'running',
      detail: 'Checks running on #1487',
    });
    for (const checksRollup of [null, 'unknown'] as const) {
      expect(stepOf(task({ pullRequests: [pullRequest({ checksRollup })] }), 'checks')).toEqual({
        state: 'unread',
        detail: 'Checks not reported',
      });
    }
    expect(stepOf(task({ pullRequests: [pullRequest()] }), 'checks')).toEqual({ state: 'done', detail: 'Checks pass' });
  });
  test('a draft is the operator to finish and its review has not started', () => {
    const draft = task({ pullRequests: [pullRequest({ draft: true })] });
    expect(stepOf(draft, 'pull-request')).toEqual({ state: 'yours', detail: 'Draft #1487' });
    expect(stepOf(draft, 'review')).toEqual({ state: 'upcoming', detail: 'Draft · review not started' });
    expect(stepOf(draft, 'merge')).toEqual({ state: 'upcoming', detail: 'Not merged yet' });
  });
  test('a green approved pull request leaves the merge to the operator', () => {
    const ready = task({ pullRequests: [pullRequest({ reviewDecision: 'APPROVED' })] });
    expect(stepOf(ready, 'merge')).toEqual({ state: 'yours', detail: '#1487 ready to merge' });
    expect(stepOf(ready, 'review')).toEqual({ state: 'done', detail: 'Approved' });
    expect(stepOf(task({ pullRequests: [pullRequest()] }), 'review')).toEqual({
      state: 'none',
      detail: 'No review required',
    });
  });
  test('a conflict fails the merge step; a branch behind its base only delays it', () => {
    expect(stepOf(task({ pullRequests: [pullRequest({}, { mergeable: 'conflicting' })] }), 'merge')).toEqual({
      state: 'failed',
      detail: 'Conflicts on #1487',
    });
    expect(stepOf(task({ pullRequests: [pullRequest({}, { mergeStateStatus: 'BEHIND' })] }), 'merge')).toEqual({
      state: 'upcoming',
      detail: 'Behind its base',
    });
  });
  test('review states: requested changes and threads are yours, a required review runs', () => {
    expect(stepOf(task({ pullRequests: [pullRequest({ unresolvedReviewThreads: 2 })] }), 'review')).toEqual({
      state: 'yours',
      detail: '2 review threads to address on #1487',
    });
    expect(stepOf(task({ pullRequests: [pullRequest({ reviewDecision: 'CHANGES_REQUESTED' })] }), 'review')).toEqual({
      state: 'yours',
      detail: 'Changes requested on #1487',
    });
    expect(stepOf(task({ pullRequests: [pullRequest({ reviewDecision: 'REVIEW_REQUIRED' })] }), 'review')).toEqual({
      state: 'running',
      detail: 'Waiting on reviewers',
    });
  });
  test("someone else's pull request only asks for the review", () => {
    const requested = task({
      pullRequests: [
        pullRequest({ checksRollup: 'failure', reviewDecision: 'REVIEW_REQUIRED' }, { role: 'review-requested' }),
      ],
    });
    expect(stepOf(requested, 'review')).toEqual({ state: 'yours', detail: 'Your review is requested on #1487' });
    expect(stepOf(requested, 'checks')).toEqual({ state: 'none', detail: "Someone else's pull request" });
    expect(stepOf(requested, 'merge')).toEqual({ state: 'none', detail: "Someone else's pull request" });
    expect(stepOf(requested, 'pull-request')).toEqual({ state: 'done', detail: '#1487 open' });
    const team = task({ pullRequests: [pullRequest({}, { role: 'team-review-requested' })] });
    expect(stepOf(team, 'review')).toEqual({
      state: 'upcoming',
      detail: 'Your team was asked · take it or leave it',
    });
  });
  test('a checkout never read on this machine is unread, on the disk and for the push', () => {
    for (const row of [
      task({}, { links: [...sessionLinks, ...branchLinks] }),
      task({ local: [neverReadCheckout] }),
      task({ local: [checkout({ outcome: 'timeout' })] }),
    ]) {
      expect(stepOf(row, 'disk')).toEqual({ state: 'unread', detail: 'Checkout not read on this machine' });
      expect(stepOf(row, 'push')).toEqual({ state: 'unread', detail: 'Checkout not read on this machine' });
      expect(stepOf(row, 'pull-request')).toEqual({ state: 'upcoming', detail: 'No pull request yet' });
      for (const key of ['checks', 'review', 'merge'] as const) {
        expect(stepOf(row, key)).toEqual({ state: 'upcoming', detail: 'No pull request yet' });
      }
    }
    // A known pull request establishes the push whatever the disk says, and says what establishes it.
    expect(stepOf(task({ pullRequests: [pullRequest()], local: [neverReadCheckout] }), 'push')).toEqual({
      state: 'done',
      detail: 'Pushed · a pull request exists',
    });
  });
  test('a checkout gone from disk is done on the disk step', () => {
    const gone = task({ local: [checkout({ outcome: 'missing' })] });
    expect(stepOf(gone, 'disk')).toEqual({ state: 'done', detail: 'Checkout gone from disk' });
    expect(stepOf(gone, 'push')).toEqual({ state: 'unread', detail: 'Checkout gone from disk · push state unknown' });
    // One checkout still on disk outranks another that is gone; one never read outranks both.
    expect(stepOf(task({ local: [checkout({ outcome: 'missing' }), checkout()] }), 'disk')).toEqual({
      state: 'upcoming',
      detail: 'Checkout on disk',
    });
    expect(
      stepOf(task({ local: [checkout({ outcome: 'missing' }), checkout(), neverReadCheckout] }), 'disk').state,
    ).toBe('unread');
  });
  test('a checkout gone from disk that last held local work is unread, not done', () => {
    const lost = { state: 'unread', detail: 'Checkout gone from disk · local work was last seen there' } as const;
    expect(stepOf(task({ local: [lostCheckout] }), 'disk')).toEqual(lost);
    // It outranks the other checkouts that are gone with nothing left, and one still on disk.
    const elsewhere = { ...checkout({ outcome: 'missing' }), key: 'checkout:/synthetic/elsewhere' };
    expect(stepOf(task({ local: [elsewhere, lostCheckout] }), 'disk')).toEqual(lost);
    expect(stepOf(task({ pullRequests: [pullRequest(MERGED)], local: [lostCheckout, elsewhere] }), 'disk')).toEqual(
      lost,
    );
    const onDisk = { ...checkout(), key: 'checkout:/synthetic/elsewhere' };
    expect(stepOf(task({ local: [onDisk, lostCheckout] }), 'disk')).toEqual(lost);
  });
  test('a checkout on disk is the operator step only while it holds local changes', () => {
    // The list cannot tell a dedicated worktree from a primary clone: a clean checkout asks nothing.
    const delivered = task({ pullRequests: [pullRequest(MERGED)], local: [checkout()] });
    expect(stepOf(delivered, 'disk')).toEqual({ state: 'upcoming', detail: 'Checkout still on disk' });
    expect(statesOf(delivered)).toEqual([
      'sessions:done',
      'push:done',
      'pull-request:done',
      'checks:done',
      'review:done',
      'merge:done',
      'disk:upcoming',
      'ticket:none',
    ]);
    expect(stepOf(delivered, 'pull-request').detail).toBe('#1487 merged');
    expect(stepOf(delivered, 'merge').detail).toBe('Merged');
    const dirty = task({ pullRequests: [pullRequest(MERGED)], local: [checkout({ dirty: true, untrackedCount: 1 })] });
    expect(stepOf(dirty, 'disk')).toEqual({ state: 'yours', detail: '1 local change on disk' });
    expect(stepOf(task({ pullRequests: [pullRequest(CLOSED)], local: [checkout()] }), 'disk')).toEqual({
      state: 'upcoming',
      detail: 'Checkout still on disk',
    });
    // Without a settled pull request the checkout is simply where the work happens.
    expect(stepOf(task({ local: [checkout()] }), 'disk')).toEqual({ state: 'upcoming', detail: 'Checkout on disk' });
    expect(stepOf(task({ local: [checkout({ dirty: true, modifiedCount: 3, stagedCount: 1 })] }), 'disk')).toEqual({
      state: 'yours',
      detail: '4 local changes on disk',
    });
    expect(stepOf(task({ local: [checkout({ dirty: true })] }), 'disk')).toEqual({
      state: 'yours',
      detail: 'Local changes on disk',
    });
  });
  test('the push step never reads done past a checkout that was not read', () => {
    const elsewhere = (marker: WorkThreadLocalMarker) => ({ ...marker, key: 'checkout:/synthetic/elsewhere' });
    const unread = { state: 'unread', detail: 'Checkout not read on this machine' } as const;
    // One checkout pushed says nothing of another that was never read or whose read failed.
    expect(stepOf(task({ local: [checkout(), elsewhere(neverReadCheckout)] }), 'push')).toEqual(unread);
    expect(stepOf(task({ local: [checkout(), elsewhere(checkout({ outcome: 'timeout' }))] }), 'push')).toEqual(unread);
    // A checkout gone from disk is a read: the one still on disk speaks for the push.
    expect(stepOf(task({ local: [checkout(), elsewhere(checkout({ outcome: 'missing' }))] }), 'push')).toEqual({
      state: 'done',
      detail: 'Branch pushed',
    });
    // Known unpushed commits stay the operator's step beside an unread checkout.
    expect(stepOf(task({ local: [checkout({ ahead: 2 }), elsewhere(neverReadCheckout)] }), 'push')).toEqual({
      state: 'yours',
      detail: '2 commits to push',
    });
  });
  test('the push step follows the commits, the upstream and the pull request', () => {
    expect(stepOf(task({ local: [checkout({ ahead: 2 })] }), 'push')).toEqual({
      state: 'yours',
      detail: '2 commits to push',
    });
    expect(stepOf(task({ local: [checkout()] }), 'push')).toEqual({ state: 'done', detail: 'Branch pushed' });
    expect(stepOf(task({ local: [checkout({ upstream: null, ahead: null })] }), 'push')).toEqual({
      state: 'upcoming',
      detail: 'Branch not pushed yet',
    });
    expect(stepOf(task({ local: [checkout({ ahead: null })] }), 'push')).toEqual({
      state: 'unread',
      detail: 'Push state unknown',
    });
    expect(stepOf(task(), 'push').state).toBe('none');
  });
  test('no sessions on this machine is said as such; linked sessions that could not be read are unread', () => {
    expect(stepOf(task({}, withoutSessions), 'sessions')).toEqual({
      state: 'none',
      detail: 'No sessions on this machine',
    });
    expect(stepOf(task({}, { sessionCount: 0, delegatedSessionCount: 0 }), 'sessions')).toEqual({
      state: 'unread',
      detail: 'Linked sessions could not be read',
    });
  });
  test('partial session coverage is unread; a running session runs; a waiting agent is yours', () => {
    expect(stepOf(task({}, { nativeRequestCoverage: 'partial' }), 'sessions')).toEqual({
      state: 'unread',
      detail: '4 sessions · 1 delegated · not fully read',
    });
    expect(stepOf(task(), 'sessions', sessionsSource('truncated')).state).toBe('unread');
    expect(stepOf(running.row, 'sessions')).toEqual({ state: 'running', detail: '1 session running' });
    const asked = task({}, { nativeRequests: [nativeRequest()] });
    expect(stepOf(asked, 'sessions')).toEqual({ state: 'yours', detail: 'An agent waits for your answer' });
    // The worst fact wins: an agent waiting on the operator outranks another session still running.
    expect(stepOf({ ...asked, runningSessions: 1 }, 'sessions').state).toBe('yours');
  });
  test('the ticket step follows the ticket, the pull requests and what was read', () => {
    expect(stepOf(task({ jiraIssues: [ticket('in-progress')] }), 'ticket')).toEqual({
      state: 'yours',
      detail: 'SHOP-2085 to update',
    });
    expect(stepOf(task({ pullRequests: [pullRequest()], jiraIssues: [ticket('in-progress')] }), 'ticket')).toEqual({
      state: 'upcoming',
      detail: 'SHOP-2085 follows the open pull request',
    });
    expect(
      stepOf(task({ pullRequests: [pullRequest(MERGED)], jiraIssues: [ticket('in-progress', true)] }), 'ticket'),
    ).toEqual({ state: 'running', detail: 'Moves on without you' });
    expect(stepOf(task({ jiraIssues: [ticket('done')] }), 'ticket')).toEqual({
      state: 'done',
      detail: 'SHOP-2085 done',
    });
    expect(stepOf(task({ jiraIssues: [ticket('unknown')] }), 'ticket')).toEqual({
      state: 'unread',
      detail: 'SHOP-2085 state unknown',
    });
    expect(stepOf(task({}, { links: [...sessionLinks, ...ticketLinks] }), 'ticket')).toEqual({
      state: 'unread',
      detail: 'SHOP-2085 state unknown',
    });
    expect(stepOf(task(), 'ticket')).toEqual({ state: 'none', detail: 'No ticket' });
  });
  test('a linked pull request never read is unread through every pull request step', () => {
    const linked = task({}, { links: [...sessionLinks, ...pullRequestLinks] });
    for (const key of ['pull-request', 'checks', 'review', 'merge'] as const) {
      expect(stepOf(linked, key)).toEqual({ state: 'unread', detail: 'State of #1487 unknown' });
    }
    expect(stepOf(linked, 'push')).toEqual({ state: 'unread', detail: 'Push state unknown' });
  });
  test('a pull request whose read is not current shows "not read" on its steps, never its last known facts', () => {
    const old = instant(-10 * DAY);
    const notRead = { state: 'unread', detail: '#1487 not read' };
    const ready = task({ pullRequests: [pullRequest({ reviewDecision: 'APPROVED', observedAt: old })] });
    for (const key of ['pull-request', 'checks', 'review', 'merge'] as const) {
      expect(stepOf(ready, key)).toEqual(notRead);
    }
    // The pull request exists whatever its state became: the push is still established.
    expect(stepOf(ready, 'push')).toEqual({ state: 'done', detail: 'Pushed · a pull request exists' });
    const failing = task({ pullRequests: [pullRequest({ checksRollup: 'failure', observedAt: old })] });
    expect(stepOf(failing, 'checks')).toEqual(notRead);
    const requested = task({
      pullRequests: [pullRequest({ reviewDecision: 'CHANGES_REQUESTED', unresolvedReviewThreads: 2, observedAt: old })],
    });
    expect(stepOf(requested, 'review')).toEqual(notRead);
    const draft = task({ pullRequests: [pullRequest({ draft: true, observedAt: old })] });
    expect(stepOf(draft, 'pull-request')).toEqual(notRead);
    // A read that failed after a success leaves the same doubt as one that aged.
    const failedRead: WorkThreadPullRequestMarker = {
      ...pullRequest({ reviewDecision: 'APPROVED' }),
      latest: { ...pullRequestFact, outcome: 'network', state: null },
    };
    expect(stepOf(task({ pullRequests: [failedRead] }), 'merge')).toEqual(notRead);
    // A closed pull request can reopen: an old read does not end its steps.
    const closed = task({ pullRequests: [pullRequest({ ...CLOSED, observedAt: old })] });
    expect(stepOf(closed, 'pull-request')).toEqual(notRead);
    expect(stepOf(closed, 'merge')).toEqual(notRead);
    // A merge is terminal and counts by its last known state.
    const merged = task({ pullRequests: [pullRequest({ ...MERGED, observedAt: old })] });
    expect(stepOf(merged, 'pull-request')).toEqual({ state: 'done', detail: '#1487 merged' });
    expect(stepOf(merged, 'merge')).toEqual({ state: 'done', detail: 'Merged' });
    // Only the pull request that was not read is qualified; a current one beside it keeps its facts.
    const mixed = task({
      pullRequests: [
        pullRequest({ reviewDecision: 'APPROVED', observedAt: old }),
        pullRequest({ checksRollup: 'failure', number: 1490 }),
      ],
    });
    expect(stepOf(mixed, 'checks')).toEqual({ state: 'failed', detail: 'Checks failing on #1490' });
    expect(stepOf(mixed, 'merge')).toEqual(notRead);
  });
  test('a gesture is never worded from a pull request read that is not current', () => {
    const old = instant(-10 * DAY);
    const current = copyOf(task({ pullRequests: [pullRequest({ reviewDecision: 'APPROVED' })] }));
    expect(current.headline).toBe('Merge #1487');
    const stale = copyOf(task({ pullRequests: [pullRequest({ reviewDecision: 'APPROVED', observedAt: old })] }));
    expect(stale.reason).toBe('ready-to-merge');
    expect(stale.headline).toBe('Choose the next step');
    expect(stale.caption).toContain('GitHub read is stale');
    for (const patch of [
      { checksRollup: 'failure' },
      { reviewDecision: 'CHANGES_REQUESTED' },
      { draft: true },
    ] as const) {
      const copy = copyOf(task({ pullRequests: [pullRequest({ ...patch, observedAt: old })] }));
      expect(copy.headline).toBe('Choose the next step');
      expect(copy.caption).toContain('GitHub read is stale');
    }
    // A stale pull request does not silence the step of another one that was read.
    const mixed = copyOf(
      task({
        pullRequests: [
          pullRequest({ reviewDecision: 'APPROVED', observedAt: old }),
          pullRequest({ checksRollup: 'failure', number: 1490 }),
        ],
      }),
    );
    expect(mixed.headline).toBe('Fix checks on #1490');
  });
  test('a pull request closed without merge ends its steps without marking them done', () => {
    const closed = task({ pullRequests: [pullRequest(CLOSED)] });
    expect(stepOf(closed, 'pull-request')).toEqual({ state: 'done', detail: '#1487 closed without merge' });
    expect(stepOf(closed, 'checks')).toEqual({ state: 'none', detail: 'Closed without merge' });
    expect(stepOf(closed, 'review')).toEqual({ state: 'none', detail: 'Closed without merge' });
    expect(stepOf(closed, 'merge')).toEqual({ state: 'none', detail: 'Closed without merge' });
  });
  test('with several pull requests the worst fact of each step wins', () => {
    const several = task({
      pullRequests: [pullRequest(MERGED), pullRequest({ checksRollup: 'failure', number: 1490 })],
    });
    expect(stepOf(several, 'pull-request')).toEqual({ state: 'done', detail: '2 pull requests' });
    expect(stepOf(several, 'checks')).toEqual({ state: 'failed', detail: 'Checks failing on #1490' });
    expect(stepOf(several, 'merge')).toEqual({ state: 'upcoming', detail: 'Not merged yet' });
    const superseded = task({ pullRequests: [pullRequest({ ...CLOSED, number: 1480 }), pullRequest(MERGED)] });
    expect(stepOf(superseded, 'merge')).toEqual({ state: 'done', detail: 'Merged' });
    expect(stepOf(superseded, 'checks')).toEqual({ state: 'done', detail: 'Merged' });
  });
});

describe('the recent activity strip', () => {
  const session = (at: string): WorkThreadMark => ({
    at: parseCanonicalInstant(at),
    fact: null,
    harness: 'claude',
    kind: 'session',
    label: null,
    source: null,
  });
  const milestone = (at: string): WorkThreadMark => ({
    ...session(at),
    fact: 'pull-request-opened',
    harness: null,
    kind: 'event',
    source: { key: 'github.example/synthetic/example-shop#1487', label: 'PR #1487' },
  });
  const followUp = (at: string): WorkThreadMark => ({ ...session(at), harness: null, kind: 'event' });
  const now = '2026-10-24T11:00:00.000Z';

  test('counts sessions and milestones per calendar day, today last', () => {
    const activity = threadRecentActivity(
      [
        session('2026-10-24T09:00:00.000Z'),
        session('2026-10-24T10:00:00.000Z'),
        session('2026-10-23T23:30:00.000Z'),
        milestone('2026-10-22T10:00:00.000Z'),
        followUp('2026-10-22T11:00:00.000Z'),
        // Outside the window.
        session('2026-10-01T10:00:00.000Z'),
      ],
      now,
      'UTC',
    );
    expect(activity.days).toHaveLength(14);
    expect(activity.days[0]).toEqual({
      key: '2026-10-11',
      label: 'Sun, Oct 11',
      sessions: 0,
      milestones: 0,
      today: false,
    });
    expect(activity.days.slice(-3)).toEqual([
      { key: '2026-10-22', label: 'Thu, Oct 22', sessions: 0, milestones: 1, today: false },
      { key: '2026-10-23', label: 'Fri, Oct 23', sessions: 1, milestones: 0, today: false },
      { key: '2026-10-24', label: 'Sat, Oct 24', sessions: 2, milestones: 0, today: true },
    ]);
    expect(activity.description).toBe('Last 14 days: 3 sessions on 2 days, 1 pull request milestone');
  });
  test('buckets a mark by the viewer calendar day', () => {
    const marks = [session('2026-10-24T00:30:00.000Z')];
    const pacific = threadRecentActivity(marks, now, 'America/Los_Angeles');
    expect(pacific.days.at(-1)).toMatchObject({ key: '2026-10-24', sessions: 0, today: true });
    expect(pacific.days.at(-2)).toMatchObject({ key: '2026-10-23', sessions: 1, today: false });
    const paris = threadRecentActivity(marks, now, 'Europe/Paris');
    expect(paris.days.at(-1)).toMatchObject({ key: '2026-10-24', sessions: 1, today: true });
    expect(paris.days.filter((day) => day.today)).toHaveLength(1);
  });
  test('describes one, several or no activity in words', () => {
    expect(threadRecentActivity([session('2026-10-24T09:00:00.000Z')], now, 'UTC').description).toBe(
      'Last 14 days: 1 session on 1 day',
    );
    expect(
      threadRecentActivity([milestone('2026-10-20T09:00:00.000Z'), milestone('2026-10-21T09:00:00.000Z')], now, 'UTC')
        .description,
    ).toBe('Last 14 days: 2 pull request milestones');
    expect(threadRecentActivity([], now, 'UTC').description).toBe('Last 14 days: no activity');
    expect(threadRecentActivity([followUp('2026-10-24T09:00:00.000Z')], now, 'UTC').description).toBe(
      'Last 14 days: no activity',
    );
  });
  test('a shorter window keeps the most recent days; a window the timeline cannot serve is refused', () => {
    const week = threadRecentActivity([session('2026-10-12T09:00:00.000Z')], now, 'UTC', 7);
    expect(week.days.map((day) => day.key)).toEqual([
      '2026-10-18',
      '2026-10-19',
      '2026-10-20',
      '2026-10-21',
      '2026-10-22',
      '2026-10-23',
      '2026-10-24',
    ]);
    expect(week.description).toBe('Last 7 days: no activity');
    for (const days of [0, 15, 1.5, Number.NaN]) {
      expect(() => threadRecentActivity([], now, 'UTC', days)).toThrow(RangeError);
    }
  });
});
