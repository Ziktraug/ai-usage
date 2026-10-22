import { describe, expect, test } from 'bun:test';
import { canonicalInstantFromDate } from './canonical-instant';
import {
  type ClaudeDesktopSessionObservation,
  type ClaudeDesktopTurnDeclaration,
  type ClaudeDesktopTurnSummary,
  parseClaudeDesktopSessionObservation,
  parseClaudeDesktopTurnDeclaration,
  WORK_ATTENTION_BOUNDS,
} from './work-attention';
import { advanceClaudeDesktopDeclarationHistory, claudeDesktopDeclarationKey } from './work-attention-native';

const NOW = new Date('2026-10-20T12:00:00.000Z');
const iso = (hoursAgo: number) => canonicalInstantFromDate(new Date(NOW.getTime() - hoursAgo * 3_600_000));

interface SweepSpec {
  readonly activityHoursAgo: number;
  readonly frameHoursAgo?: number;
  readonly needsAction?: string | null;
  readonly status?: ClaudeDesktopTurnSummary['status'];
  readonly summarizes?: string | null;
  readonly unsupported?: boolean;
}

/** One sweep of one session: the registry file as the collector normalized it at that moment. */
const sweep = (spec: SweepSpec): ClaudeDesktopSessionObservation => {
  const parsed = parseClaudeDesktopSessionObservation({
    accountDirectory: 'account',
    archived: false,
    cliSessionId: 'cli-history',
    createdAt: iso(48),
    cwd: '/home/fixture/work/project',
    desktopSessionId: 'local_history',
    fileModifiedAt: iso(spec.activityHoursAgo),
    filePath: '.config/Claude/claude-code-sessions/account/org/local_history.json',
    format: spec.unsupported ? 'unsupported' : 'claude-desktop-session-v1',
    lastActivityAt: iso(spec.activityHoursAgo),
    latestUserFrameAt: spec.frameHoursAgo === undefined ? null : iso(spec.frameHoursAgo),
    machineId: 'machine-history',
    observedAt: iso(spec.activityHoursAgo),
    organizationDirectory: 'org',
    title: 'History fixture',
    titleSource: 'auto',
    turnSummary: spec.unsupported
      ? null
      : {
          detail: 'Stopped on a question.',
          needsAction: spec.needsAction === undefined ? 'Which layout?' : spec.needsAction,
          status: spec.status ?? 'blocked',
          summarizesUuid: spec.summarizes === undefined ? 'assistant-1' : spec.summarizes,
        },
    unsupportedReason: spec.unsupported ? 'Unsupported field shape: postTurnSummary.' : null,
  });
  if (parsed === null) {
    throw new Error('the sweep fixture must satisfy the contract');
  }
  return parsed;
};

const replay = (sweeps: readonly SweepSpec[]): readonly ClaudeDesktopTurnDeclaration[] =>
  sweeps.reduce<readonly ClaudeDesktopTurnDeclaration[]>(
    (history, spec) => advanceClaudeDesktopDeclarationHistory(history, sweep(spec)),
    [],
  );

describe('advanceClaudeDesktopDeclarationHistory', () => {
  test('a first sweep records the declaration, dated by the session activity of that sweep', () => {
    const history = replay([{ activityHoursAgo: 5, frameHoursAgo: 5.5 }]);
    expect(history).toEqual([
      {
        declarationKey: 'assistant-1',
        declaredAt: iso(5),
        desktopSessionId: 'local_history',
        detail: 'Stopped on a question.',
        firstObservedAt: iso(5),
        machineId: 'machine-history',
        needsAction: 'Which layout?',
        repliedAt: null,
        status: 'blocked',
        supersededAt: null,
        supersededByKey: null,
      },
    ]);
    // Every row the function returns is a row the store accepts.
    expect(history.map(parseClaudeDesktopTurnDeclaration)).toEqual([...history]);
  });

  test('a message recorded after the current question is its reply; the date of the question does not move', () => {
    const history = replay([
      { activityHoursAgo: 5, frameHoursAgo: 5.5 },
      { activityHoursAgo: 4, frameHoursAgo: 4.5 },
    ]);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ declaredAt: iso(5), repliedAt: iso(4.5), supersededAt: null });
  });

  test('a later question replaces the earlier one; a message in between is the earlier one’s reply', () => {
    const history = replay([
      { activityHoursAgo: 6, frameHoursAgo: 6.5 },
      { activityHoursAgo: 5, frameHoursAgo: 5.5, needsAction: 'Delete checkout 3?', summarizes: 'assistant-2' },
    ]);
    expect(history.map((row) => [row.declarationKey, row.declaredAt, row.repliedAt, row.supersededAt])).toEqual([
      ['assistant-1', iso(6), iso(5.5), iso(5)],
      ['assistant-2', iso(5), null, null],
    ]);
    expect(history[0]?.supersededByKey).toBe('assistant-2');
  });

  test('a message later than the new declaration is the new one’s reply and says nothing about the earlier one', () => {
    const history = replay([
      { activityHoursAgo: 6, frameHoursAgo: 6.5 },
      { activityHoursAgo: 5, frameHoursAgo: 4.5, summarizes: 'assistant-2' },
    ]);
    expect(history.map((row) => [row.declarationKey, row.repliedAt, row.supersededAt])).toEqual([
      ['assistant-1', null, iso(5)],
      ['assistant-2', iso(4.5), null],
    ]);
  });

  test('a reply recorded while the question was current survives its replacement', () => {
    const history = replay([
      { activityHoursAgo: 6, frameHoursAgo: 6.5 },
      { activityHoursAgo: 5.8, frameHoursAgo: 5.9 },
      { activityHoursAgo: 4, frameHoursAgo: 3.5, summarizes: 'assistant-2' },
    ]);
    expect(history[0]).toMatchObject({ declarationKey: 'assistant-1', repliedAt: iso(5.9), supersededAt: iso(4) });
  });

  test('a sweep without a supported declaration leaves the history as it was', () => {
    const before = replay([{ activityHoursAgo: 6 }]);
    expect(advanceClaudeDesktopDeclarationHistory(before, sweep({ activityHoursAgo: 5, unsupported: true }))).toEqual(
      before,
    );
  });

  test('a rewritten summary of the same turn keeps its date and takes the latest wording', () => {
    const history = replay([
      { activityHoursAgo: 6, needsAction: 'Which layout?' },
      { activityHoursAgo: 5.5, needsAction: 'Which of the two layouts?' },
    ]);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ declaredAt: iso(6), needsAction: 'Which of the two layouts?' });
  });

  test('a summary without summarizes_uuid is keyed by its content', () => {
    const summary: ClaudeDesktopTurnSummary = {
      detail: 'Stopped.',
      needsAction: 'Which layout?',
      status: 'blocked',
      summarizesUuid: null,
    };
    expect(claudeDesktopDeclarationKey(summary)).toBe(claudeDesktopDeclarationKey({ ...summary }));
    expect(claudeDesktopDeclarationKey(summary)).not.toBe(
      claudeDesktopDeclarationKey({ ...summary, needsAction: 'Delete it?' }),
    );
    expect(claudeDesktopDeclarationKey(summary)).toStartWith('content:');
    const history = replay([
      { activityHoursAgo: 6, summarizes: null },
      { activityHoursAgo: 5, needsAction: 'Delete it?', summarizes: null },
    ]);
    expect(history.map((row) => row.supersededAt === null)).toEqual([false, true]);
  });

  test('keeps the newest declarations within the bound, the current one last', () => {
    const sweeps = Array.from({ length: 12 }, (_value, index) => ({
      activityHoursAgo: 24 - index,
      needsAction: `Question ${index}?`,
      summarizes: `assistant-${index}`,
    }));
    const history = replay(sweeps);
    expect(history).toHaveLength(WORK_ATTENTION_BOUNDS.maxDeclarationsPerSession);
    expect(history.at(-1)).toMatchObject({ declarationKey: 'assistant-11', supersededAt: null });
    expect(history[0]?.declarationKey).toBe('assistant-4');
  });

  test('ignores rows of other sessions', () => {
    const other = {
      ...replay([{ activityHoursAgo: 6 }])[0],
      desktopSessionId: 'local_other',
    } as ClaudeDesktopTurnDeclaration;
    const history = advanceClaudeDesktopDeclarationHistory([other], sweep({ activityHoursAgo: 5 }));
    expect(history.map((row) => row.desktopSessionId)).toEqual(['local_history']);
  });
});
