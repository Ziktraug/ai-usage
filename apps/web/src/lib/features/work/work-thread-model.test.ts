import { describe, expect, test } from 'bun:test';
import { parseCanonicalInstant } from '@ai-usage/report-core/canonical-instant';
import type { WorkThreadEvent, WorkThreadLink } from '@ai-usage/report-core/work-thread';
import type { WorkThreadRemainder } from '@ai-usage/report-core/work-thread-situation';
import {
  WORK_THREAD_VIEW_BOUNDS,
  type WorkThreadEpisode,
  type WorkThreadFactEvent,
  type WorkThreadMark,
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
  localMarkerKey,
  observedWebUrl,
  primaryResumeEpisode,
  projectShortLabel,
  remainderCopy,
  remainderEvidenceCopy,
  THREAD_TIMELINE_MIN_DAYS,
  taskSourceStatuses,
  threadDate,
  threadDayKey,
  threadDayMarks,
  threadDisplayMarkers,
  threadEventActor,
  threadEventCopy,
  threadFactEventCopy,
  threadHistory,
  threadListQuery,
  threadMoreUrl,
  threadPageCursors,
  threadRefs,
  threadSituationCopy,
  threadSourceAvailability,
  threadTimeline,
  threadUrl,
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
      [{ at, fact: null, kind: 'session', harness: 'codex', label: null }],
      'America/Los_Angeles',
    );
    expect(marks.get('2026-10-23')).toHaveLength(1);
  });
  test('DST repeated hour is one day; week remains seven distinct calendar days', () => {
    const first = parseCanonicalInstant('2026-10-25T00:30:00.000Z');
    const second = parseCanonicalInstant('2026-10-25T01:30:00.000Z');
    const marks = bucketThreadMarks(
      [first, second].map((at) => ({ at, fact: null, kind: 'session' as const, harness: 'codex', label: null })),
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
    expect(threadSituationCopy(analysis.row, analysis.generatedAt, analysis.sources)).toMatchObject({
      hint: 'ready-to-close',
      headline: 'An analysis can be enough',
    });
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
      headline: 'Checks failing',
      caption: 'GitHub · Oct 24',
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

  test('a day of the lane draws its most telling milestone and names every mark', () => {
    const mark = (overrides: Partial<WorkThreadMark>): WorkThreadMark => ({
      at: openedAt,
      fact: null,
      harness: null,
      kind: 'event',
      label: 'Waiting',
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
    expect(day.milestone).toBe('pull-request-merged');
    expect(day.sessions).toHaveLength(1);
    expect(day.others).toBe(1);
    expect(day.description).toBe(
      'Oct 23: 1 session, PR #72 approved by reviewer, PR #72 merged, 1 follow-up change. Show activity.',
    );
    expect(threadDayMarks([mark({}), mark({})], 'Oct 24')).toMatchObject({
      milestone: null,
      others: 2,
      description: 'Oct 24: 0 sessions, 2 follow-up changes. Show activity.',
    });
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
        local: [{ key: 'session-checkout', via: 'session-checkout' as const, latest: null, latestSuccessful: null }],
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
