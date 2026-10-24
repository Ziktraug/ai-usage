import { describe, expect, test } from 'bun:test';
import { parseCanonicalInstant } from '@ai-usage/report-core/canonical-instant';
import type { WorkThreadEpisode } from '@ai-usage/report-core/work-thread-view';
import {
  createSyntheticWorkThreadStore,
  WORK_THREADS_FIXTURE_IDS,
} from '../../../server/work-threads-e2e-fixture.server';
import {
  acknowledgedRemainderCopy,
  bucketThreadMarks,
  episodeContext,
  episodeResumeText,
  episodeSpan,
  groupThreadRows,
  observedWebUrl,
  primaryResumeEpisode,
  threadDayKey,
  threadDisplayMarkers,
  threadEventActor,
  threadHistory,
  threadListQuery,
  threadMoreUrl,
  threadPageCursors,
  threadRefs,
  threadSituationCopy,
  threadUrl,
  threadWeek,
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
  test('groups each durable task once by project, including a PR without sessions', () => {
    const groups = groupThreadRows(list.rows);
    expect(groups.reduce((total, group) => total + group.tasks.length, 0)).toBe(list.rows.length);
    expect(groups.some((group) => group.project === 'ai-usage')).toBe(true);
    expect(threadRefs(review.row)).toContain('0 sessions');
    expect(threadRefs(review.row)).toContain('PR #');
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
    const marks = bucketThreadMarks([{ at, kind: 'session', harness: 'codex' }], 'America/Los_Angeles');
    expect(marks.get('2026-10-23')).toHaveLength(1);
  });
  test('DST repeated hour is one day; week remains seven distinct calendar days', () => {
    const first = parseCanonicalInstant('2026-10-25T00:30:00.000Z');
    const second = parseCanonicalInstant('2026-10-25T01:30:00.000Z');
    const marks = bucketThreadMarks(
      [first, second].map((at) => ({ at, kind: 'session' as const, harness: 'codex' })),
      'Europe/Paris',
    );
    expect(marks.get('2026-10-25')).toHaveLength(2);
    const week = threadWeek('2026-10-26T01:00:00Z', 'Europe/Paris');
    expect(week.map((day) => day.key)).toEqual([
      '2026-10-20',
      '2026-10-21',
      '2026-10-22',
      '2026-10-23',
      '2026-10-24',
      '2026-10-25',
      '2026-10-26',
    ]);
    expect(week.filter((day) => day.today)).toHaveLength(1);
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
    const noSessions = { ...analysis.row, links: [], sessionCount: 0 };
    expect(threadSituationCopy(noSessions, analysis.generatedAt, failed)).toMatchObject({
      hint: 'ready-to-close',
      remainders: [],
    });
    expect(threadSituationCopy(analysis.row, analysis.generatedAt, []).remainders).toContainEqual({
      key: analysis.row.links.find((link) => link.kind === 'session')?.key,
      source: 'sessions',
      observedAt: null,
      kind: 'source-unknown',
    });
    expect(threadSituationCopy(noSessions, analysis.generatedAt, [])).toMatchObject({
      hint: 'ready-to-close',
      remainders: [],
    });
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
      durationBasis: 'unknown',
      durationMs: null,
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
    expect(all.length).toBe(payment.episodes.length + payment.events.length);
  });
  test('event actor stays neutral when the frozen event has no actor provenance', () => {
    const event = payment.events[0];
    if (!event) {
      throw new Error('Expected a test event');
    }
    expect(threadEventActor({ ...event, kind: 'created' })).toBe('Work event');
    expect(threadEventActor({ ...event, kind: 'wait-satisfied', linkKey: 'jira:example/EX-1' })).toBe('Jira');
  });
});
