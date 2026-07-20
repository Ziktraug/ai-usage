import { describe, expect, test } from 'bun:test';
import { normalizeSessionVcsRepository } from '@ai-usage/report-core/session-vcs';
import { parseClaudeSessionFacts } from './claude-session-facts';

const event = (value: Record<string, unknown>): Record<string, unknown> => value;

describe('parseClaudeSessionFacts', () => {
  test('owns prompt graph, duplicate usage, model attribution, timing, tools, and VCS facts', () => {
    const repository = normalizeSessionVcsRepository('git@github.com:fixture/project.git', 'local-derived');
    const facts = parseClaudeSessionFacts({
      isAgentFile: false,
      records: [
        event({
          type: 'user',
          timestamp: '2026-07-01T08:00:00.000Z',
          uuid: 'user-1',
          cwd: '/work/project',
          gitBranch: 'main',
          message: { role: 'user', content: [{ type: 'text', text: 'private prompt' }] },
        }),
        event({
          type: 'assistant',
          timestamp: '2026-07-01T08:01:00.000Z',
          uuid: 'assistant-1',
          parentUuid: 'user-1',
          requestId: 'request-1',
          gitBranch: 'main',
          message: {
            id: 'message-1',
            model: 'claude-sonnet-4-6',
            content: [{ type: 'tool_use', name: 'Read' }],
            usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 3 },
          },
        }),
        event({
          type: 'assistant',
          timestamp: '2026-07-01T08:01:00.000Z',
          uuid: 'assistant-1-copy',
          parentUuid: 'user-1',
          requestId: 'request-1',
          message: {
            id: 'message-1',
            model: 'claude-sonnet-4-6',
            content: [{ type: 'tool_use', name: 'Read' }],
            usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 3 },
          },
        }),
        event({
          type: 'user',
          timestamp: '2026-07-01T08:01:10.000Z',
          uuid: 'tool-result',
          parentUuid: 'assistant-1',
          message: { role: 'user', content: [{ type: 'tool_result', content: 'not a prompt' }] },
        }),
        event({
          type: 'assistant',
          timestamp: '2026-07-01T08:01:20.000Z',
          uuid: 'assistant-2',
          parentUuid: 'tool-result',
          requestId: 'request-2',
          gitBranch: 'topic/a',
          message: {
            id: 'message-2',
            model: 'claude-opus-4-1',
            content: [{ type: 'text', text: 'assistant text must not escape' }],
            usage: { input_tokens: 8, output_tokens: 2, cache_creation_input_tokens: 1 },
          },
        }),
        event({
          type: 'system',
          subtype: 'turn_duration',
          timestamp: '2026-07-01T08:01:30.000Z',
          parentUuid: 'assistant-2',
          durationMs: 60_000,
        }),
        event({
          type: 'pr-link',
          timestamp: '2026-07-01T08:01:31.000Z',
          prUrl: 'https://github.com/fixture/project/pull/27',
          prNumber: 27,
          prRepository: 'fixture/project',
        }),
      ],
      repository,
      sourceSessionId: 'session-1',
    });

    expect(facts).not.toBeNull();
    expect(facts?.projection).toMatchObject({ calls: 2, tools: 1, turns: 1 });
    expect(facts?.projection.tokens).toEqual({ cacheRead: 3, cacheWrite: 1, input: 18, output: 6, total: 28 });
    expect(facts?.detailFacts.prompts.map(({ text }) => text)).toEqual(['private prompt']);
    expect(facts?.report.name).toBe('claude session-');
    expect(JSON.stringify(facts?.report)).not.toContain('private prompt');
    expect(facts?.detailFacts.turns).toHaveLength(1);
    expect(facts?.detailFacts.turns[0]).toMatchObject({
      durationMs: 60_000,
      index: 0,
      timingStatus: 'recorded',
      tools: 1,
    });
    expect(facts?.detailFacts.durationStatus).toBe('recorded');
    expect(facts?.source.vcs?.branches.map(({ name }) => name)).toEqual(['main', 'topic/a']);
    expect(facts?.source.vcs?.pullRequests).toEqual([
      {
        number: 27,
        observedAt: '2026-07-01T08:01:31.000Z',
        repository: 'fixture/project',
        url: 'https://github.com/fixture/project/pull/27',
      },
    ]);
    expect(JSON.stringify(facts)).not.toContain('assistant text must not escape');
  });

  test('represents mixed and absent timings honestly while retaining unattributed metrics', () => {
    const mixed = parseClaudeSessionFacts({
      isAgentFile: false,
      records: [
        event({
          type: 'user',
          timestamp: '2026-07-01T09:00:00.000Z',
          uuid: 'user-1',
          message: { content: 'first' },
        }),
        event({
          type: 'assistant',
          timestamp: '2026-07-01T09:00:10.000Z',
          uuid: 'assistant-1',
          parentUuid: 'user-1',
          requestId: 'one',
          message: { id: 'one', model: 'claude-a', usage: { input_tokens: 2, output_tokens: 1 } },
        }),
        event({
          type: 'system',
          subtype: 'turn_duration',
          timestamp: '2026-07-01T09:00:10.000Z',
          parentUuid: 'assistant-1',
          durationMs: 5000,
        }),
        event({
          type: 'user',
          timestamp: '2026-07-01T09:01:00.000Z',
          uuid: 'user-2',
          message: { content: 'second' },
        }),
        event({
          type: 'assistant',
          timestamp: '2026-07-01T09:02:00.000Z',
          uuid: 'assistant-2',
          parentUuid: 'missing-parent',
          requestId: 'two',
          message: { id: 'two', model: 'claude-b', usage: { input_tokens: 4, output_tokens: 2 } },
        }),
      ],
      repository: null,
      sourceSessionId: 'mixed',
    });
    expect(mixed?.detailFacts.durationStatus).toBe('partial');
    expect(mixed?.detailFacts.turns.some(({ timingStatus }) => timingStatus === 'unavailable')).toBe(true);
    expect(mixed?.detailFacts.turnsStatus).toBe('partial');
    expect(mixed?.projection.tokens?.total).toBe(9);

    const unavailable = parseClaudeSessionFacts({
      isAgentFile: false,
      records: [
        event({ type: 'user', timestamp: '2026-07-01T10:00:00.000Z', uuid: 'u', message: { content: 'prompt' } }),
        event({
          type: 'assistant',
          timestamp: '2026-07-01T10:00:01.000Z',
          parentUuid: 'u',
          requestId: 'r',
          message: { id: 'm', model: 'claude-a', usage: { input_tokens: 1, output_tokens: 1 } },
        }),
      ],
      repository: null,
      sourceSessionId: 'untimed',
    });
    expect(unavailable?.detailFacts).toMatchObject({
      activeDurationMs: null,
      durationStatus: 'unavailable',
      idleDurationMs: null,
    });
    expect(unavailable?.detailFacts.turns[0]).toMatchObject({
      durationMs: null,
      intervals: [],
      timingStatus: 'unavailable',
    });
  });

  test('rejects malformed metrics and unsafe VCS facts without losing valid neighbors', () => {
    const facts = parseClaudeSessionFacts({
      isAgentFile: true,
      records: [
        event({ type: 'user', timestamp: '2026-07-01T11:00:00.000Z', sessionId: 'root', message: { content: 'go' } }),
        event({
          type: 'assistant',
          timestamp: '2026-07-01T11:00:01.000Z',
          requestId: 'bad',
          message: { id: 'bad', usage: { input_tokens: -1 } },
        }),
        event({
          type: 'assistant',
          timestamp: '2026-07-01T11:00:02.000Z',
          requestId: 'good',
          message: { id: 'good', model: 'claude-a', usage: { input_tokens: 3, output_tokens: 2 } },
        }),
        event({ type: 'pr-link', timestamp: '2026-07-01T11:00:03.000Z', prUrl: 'javascript:secret' }),
      ],
      repository: null,
      sourceSessionId: 'agent-child',
    });
    expect(facts?.report.rejectedMetricRecords).toBe(1);
    expect(facts?.projection.tokens?.total).toBe(5);
    expect(facts?.source.parentSourceSessionId).toBe('root');
    expect(facts?.source.vcs?.partial).toBe(true);
    expect(facts?.source.vcs?.pullRequests).toEqual([]);
  });

  test('unions overlapping recorded intervals and rejects outliers without inventing activity', () => {
    const baseRecords = [
      event({ type: 'user', timestamp: '2026-07-01T12:00:00.000Z', uuid: 'u', message: { content: 'go' } }),
      event({
        type: 'assistant',
        timestamp: '2026-07-01T12:00:05.000Z',
        uuid: 'a',
        parentUuid: 'u',
        requestId: 'r',
        message: { id: 'm', model: 'claude-a', usage: { input_tokens: 2, output_tokens: 1 } },
      }),
      event({
        type: 'system',
        subtype: 'turn_duration',
        timestamp: '2026-07-01T12:00:10.000Z',
        parentUuid: 'a',
        durationMs: 8000,
      }),
      event({
        type: 'system',
        subtype: 'turn_duration',
        timestamp: '2026-07-01T12:00:15.000Z',
        parentUuid: 'a',
        durationMs: 10_000,
      }),
    ];
    const overlapping = parseClaudeSessionFacts({
      isAgentFile: false,
      records: baseRecords,
      repository: null,
      sourceSessionId: 'overlap',
    });
    expect(overlapping?.detailFacts.activeDurationMs).toBe(13_000);
    expect(overlapping?.detailFacts.turns[0]?.durationMs).toBe(13_000);

    const outlier = parseClaudeSessionFacts({
      isAgentFile: false,
      records: [
        ...baseRecords,
        event({
          type: 'system',
          subtype: 'turn_duration',
          timestamp: '2026-07-01T12:00:16.000Z',
          parentUuid: 'a',
          durationMs: 60_000,
        }),
      ],
      repository: null,
      sourceSessionId: 'outlier',
    });
    expect(outlier?.projection.tokens?.total).toBe(3);
    expect(outlier?.detailFacts).toMatchObject({
      activeDurationMs: null,
      durationStatus: 'unavailable',
      idleDurationMs: null,
    });
  });

  test('treats zero timing and timing followed by later turn activity as unavailable', () => {
    const records = [
      event({
        type: 'user',
        timestamp: '2026-07-01T13:00:00.000Z',
        uuid: 'user',
        message: { content: 'Investigate timing closure' },
      }),
      event({
        type: 'assistant',
        timestamp: '2026-07-01T13:00:05.000Z',
        uuid: 'assistant-1',
        parentUuid: 'user',
        requestId: 'request-1',
        message: { id: 'message-1', model: 'claude-a', usage: { input_tokens: 1, output_tokens: 1 } },
      }),
      event({
        type: 'system',
        subtype: 'turn_duration',
        timestamp: '2026-07-01T13:00:10.000Z',
        parentUuid: 'assistant-1',
        durationMs: 5000,
      }),
      event({
        type: 'assistant',
        timestamp: '2026-07-01T13:00:20.000Z',
        uuid: 'assistant-2',
        parentUuid: 'assistant-1',
        requestId: 'request-2',
        message: { id: 'message-2', model: 'claude-a', usage: { input_tokens: 1, output_tokens: 1 } },
      }),
    ];
    const followedByActivity = parseClaudeSessionFacts({
      records,
      repository: null,
      sourceSessionId: 'later-activity',
    });
    const zeroTiming = parseClaudeSessionFacts({
      records: [
        ...records.slice(0, 2),
        event({
          type: 'system',
          subtype: 'turn_duration',
          timestamp: '2026-07-01T13:00:10.000Z',
          parentUuid: 'assistant-1',
          durationMs: 0,
        }),
      ],
      repository: null,
      sourceSessionId: 'zero-timing',
    });

    expect(followedByActivity?.detailFacts).toMatchObject({
      activeDurationMs: null,
      durationStatus: 'unavailable',
      idleDurationMs: null,
    });
    expect(zeroTiming?.detailFacts).toMatchObject({
      activeDurationMs: null,
      durationStatus: 'unavailable',
      idleDurationMs: null,
    });
  });

  test('isolates conflicting UUIDs instead of reparenting metrics to the last duplicate', () => {
    const facts = parseClaudeSessionFacts({
      records: [
        event({
          type: 'user',
          timestamp: '2026-07-01T14:00:00.000Z',
          uuid: 'user-1',
          message: { content: 'First eligible prompt' },
        }),
        event({
          type: 'system',
          timestamp: '2026-07-01T14:00:01.000Z',
          uuid: 'conflict',
          parentUuid: 'user-1',
        }),
        event({
          type: 'user',
          timestamp: '2026-07-01T14:00:02.000Z',
          uuid: 'user-2',
          message: { content: 'Second eligible prompt' },
        }),
        event({
          type: 'system',
          timestamp: '2026-07-01T14:00:03.000Z',
          uuid: 'conflict',
          parentUuid: 'user-2',
        }),
        event({
          type: 'assistant',
          timestamp: '2026-07-01T14:00:04.000Z',
          uuid: 'assistant',
          parentUuid: 'conflict',
          requestId: 'request',
          message: { id: 'message', model: 'claude-a', usage: { input_tokens: 1, output_tokens: 1 } },
        }),
      ],
      repository: null,
      sourceSessionId: 'conflicting-uuid',
    });

    const metricTurn = facts?.detailFacts.turns.find((turn) => turn.tokens.total === 2);
    expect(metricTurn?.promptIds).toEqual([]);
    expect(facts?.detailFacts.turnsStatus).toBe('partial');
  });

  test('does not attach branches from multiple cwd values to one repository', () => {
    const repository = normalizeSessionVcsRepository('https://github.com/second/repository.git', 'local-derived');
    const facts = parseClaudeSessionFacts({
      records: [
        event({
          type: 'user',
          timestamp: '2026-07-01T15:00:00.000Z',
          uuid: 'user-1',
          cwd: '/first/repository',
          gitBranch: 'first-branch',
          message: { content: 'Work in the first repository' },
        }),
        event({
          type: 'user',
          timestamp: '2026-07-01T15:01:00.000Z',
          uuid: 'user-2',
          cwd: '/second/repository',
          gitBranch: 'second-branch',
          message: { content: 'Work in the second repository' },
        }),
      ],
      repository,
      sourceSessionId: 'multiple-repositories',
    });

    expect(facts?.source.vcs?.partial).toBe(true);
    expect(facts?.source.vcs?.repository).toEqual(repository);
    expect(facts?.source.vcs?.branches.every(({ webUrl }) => webUrl === null)).toBe(true);
  });
});
