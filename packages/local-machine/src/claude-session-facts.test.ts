import { describe, expect, test } from 'bun:test';
import { parseClaudeSessionFacts } from '@ai-usage/local-machine/claude-session-facts';
import { approxCost, priceFor } from '@ai-usage/report-core/pricing';
import { normalizeSessionVcsRepository } from '@ai-usage/report-core/session-vcs';

const event = (value: Record<string, unknown>): Record<string, unknown> => value;

describe('parseClaudeSessionFacts', () => {
  test('counts the final streamed output once across report, models, phases, and turns', async () => {
    const jsonl = await Bun.file(new URL('./test-fixtures/claude-streamed-usage.jsonl', import.meta.url)).text();
    const facts = parseClaudeSessionFacts({
      records: jsonl
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
      repository: null,
      sourceSessionId: 'streamed-usage',
    });
    const tokens = { cacheRead: 5, cacheWrite: 6, input: 16, output: 13, total: 40 };
    expect(facts?.report.tokens).toEqual({ cr: 5, cw: 6, in: 16, out: 13 });
    expect(facts?.projection).toMatchObject({ calls: 2, tokens, tools: 0, turns: 1 });
    expect(facts?.report.rejectedMetricRecords).toBe(0);
    expect(facts?.report.modelSegments).toEqual([
      expect.objectContaining({ model: 'claude-sonnet-4-6', tokIn: 10, tokOut: 9, tokCr: 3, tokCw: 5 }),
      expect.objectContaining({ model: 'claude-opus-4-1', tokIn: 6, tokOut: 4, tokCr: 2, tokCw: 1 }),
    ]);
    expect(facts?.projection.modelSegments).toEqual([
      { model: 'claude-opus-4-1', tokens: { cacheRead: 2, cacheWrite: 1, input: 6, output: 4, total: 13 } },
      { model: 'claude-sonnet-4-6', tokens: { cacheRead: 3, cacheWrite: 5, input: 10, output: 9, total: 27 } },
    ]);
    expect(facts?.detailFacts.phases.map((phase) => phase.tokens.output)).toEqual([9, 4]);
    expect(facts?.detailFacts.turns).toHaveLength(1);
    expect(facts?.detailFacts.turns[0]).toMatchObject({ calls: 2, tokens });
    expect(facts?.detailFacts.turns[0]?.cost).toBeCloseTo(
      approxCost(priceFor('claude-sonnet-4-6').rates, { cr: 3, cw: 5, in: 10, out: 9 }) +
        approxCost(priceFor('claude-opus-4-1').rates, { cr: 2, cw: 1, in: 6, out: 4 }),
      12,
    );
  });

  test.each([
    { outputs: [2, 9, 4], output: 9, rejected: 0 },
    { outputs: [-1, 2, 9], output: 9, rejected: 1 },
    { outputs: [2, -1, 9], output: 9, rejected: 1 },
    { outputs: [2, 9, Number.MAX_SAFE_INTEGER], output: 9, rejected: 1 },
  ])('retains valid streamed maxima and rejects invalid metrics: $outputs', ({ outputs, output, rejected }) => {
    const facts = parseClaudeSessionFacts({
      records: outputs.map((outputTokens, index) => ({
        type: 'assistant',
        timestamp: `2026-07-01T08:00:0${index}.000Z`,
        message: { id: 'message', usage: { input_tokens: 10, output_tokens: outputTokens } },
      })),
      repository: null,
      sourceSessionId: 'streamed-usage',
    });
    expect(facts?.report.tokens).toEqual({ cr: 0, cw: 0, in: 10, out: output });
    expect(facts?.report.calls).toBe(1);
    expect(facts?.report.rejectedMetricRecords).toBe(rejected);
  });

  test('preserves first input/cache fields and rejects an unsafe merged total', () => {
    const facts = parseClaudeSessionFacts({
      records: [
        { input_tokens: 10, cache_read_input_tokens: 3, cache_creation_input_tokens: 5, output_tokens: 2 },
        { input_tokens: 100, cache_read_input_tokens: 30, cache_creation_input_tokens: 50, output_tokens: 9 },
        { output_tokens: Number.MAX_SAFE_INTEGER },
      ].map((usage, index) => ({
        type: 'assistant',
        timestamp: `2026-07-01T08:00:0${index}.000Z`,
        message: { id: 'message', usage },
      })),
      repository: null,
      sourceSessionId: 'streamed-usage',
    });
    expect(facts?.projection.tokens).toEqual({ cacheRead: 3, cacheWrite: 5, input: 10, output: 9, total: 27 });
    expect(facts?.report.rejectedMetricRecords).toBe(1);
  });

  const streamedBlock = (
    uuid: string,
    parentUuid: string,
    second: number,
    content: unknown[],
    usage: Record<string, unknown> | undefined = { input_tokens: 10, output_tokens: 2 },
  ): Record<string, unknown> =>
    event({
      type: 'assistant',
      timestamp: `2026-07-01T08:00:${String(second).padStart(2, '0')}.000Z`,
      uuid,
      parentUuid,
      requestId: 'request-1',
      message: { id: 'message-1', model: 'claude-sonnet-4-6', content, ...(usage ? { usage } : {}) },
    });
  const streamedPrompt = event({
    type: 'user',
    timestamp: '2026-07-01T08:00:00.000Z',
    uuid: 'user-1',
    message: { role: 'user', content: 'Synthetic prompt' },
  });

  test('counts a tool_use streamed in a later content-block record of the same message', () => {
    const facts = parseClaudeSessionFacts({
      records: [
        streamedPrompt,
        streamedBlock('assistant-1', 'user-1', 1, [{ type: 'thinking', thinking: 'Synthetic thought' }]),
        streamedBlock('assistant-1-tool', 'assistant-1', 2, [
          { type: 'tool_use', id: 'toolu-read', name: 'Read', input: {} },
        ]),
      ],
      repository: null,
      sourceSessionId: 'streamed-tools',
    });
    expect(facts?.report).toMatchObject({ calls: 1, tools: 1 });
    expect(facts?.projection).toMatchObject({ calls: 1, tools: 1, turns: 1 });
    expect(facts?.detailFacts.turns).toEqual([expect.objectContaining({ calls: 1, tools: 1 })]);
  });

  test('adds later streamed tool uses once, whether replayed, id-less, or carried by invalid usage', () => {
    const facts = parseClaudeSessionFacts({
      records: [
        streamedPrompt,
        streamedBlock('assistant-1', 'user-1', 1, [{ type: 'text', text: 'Synthetic answer' }]),
        streamedBlock('assistant-1-tool', 'assistant-1', 2, [
          { type: 'tool_use', id: 'toolu-read', name: 'Read', input: {} },
        ]),
        // A replayed record repeats an id already counted.
        streamedBlock('assistant-1-replay', 'assistant-1-tool', 3, [
          { type: 'tool_use', id: 'toolu-read', name: 'Read', input: {} },
        ]),
        // An id-less block in a later record cannot be told apart from a replay.
        streamedBlock('assistant-1-anonymous', 'assistant-1-replay', 4, [{ type: 'tool_use', name: 'Read' }]),
        // The tool use is real even when this record's usage is rejected or absent.
        streamedBlock(
          'assistant-1-invalid',
          'assistant-1-anonymous',
          5,
          [{ type: 'tool_use', id: 'toolu-grep', name: 'Grep', input: {} }],
          { input_tokens: 10, output_tokens: -1 },
        ),
        streamedBlock(
          'assistant-1-unmetered',
          'assistant-1-invalid',
          6,
          [{ type: 'tool_use', id: 'toolu-glob', name: 'Glob', input: {} }],
          undefined,
        ),
      ],
      repository: null,
      sourceSessionId: 'streamed-tools',
    });
    expect(facts?.projection).toMatchObject({ calls: 1, tools: 3, turns: 1 });
    expect(facts?.projection.tokens).toEqual({ cacheRead: 0, cacheWrite: 0, input: 10, output: 2, total: 12 });
    expect(facts?.report.rejectedMetricRecords).toBe(1);
    expect(facts?.detailFacts.turns).toEqual([expect.objectContaining({ calls: 1, tools: 3 })]);
  });

  test('anchors a later streamed launch and its result to the round that counts the tool', () => {
    const facts = parseClaudeSessionFacts({
      isAgentFile: false,
      records: [
        streamedPrompt,
        streamedBlock('assistant-1', 'user-1', 1, [{ type: 'thinking', thinking: 'Synthetic thought' }]),
        // Its parent chain is broken, so only the shared message identity ties
        // this record to the round of the first observation.
        streamedBlock('assistant-1-tool', 'missing-parent', 2, [
          { type: 'tool_use', id: 'toolu-spawn', name: 'Task', input: { description: 'Synthetic launch' } },
        ]),
        event({
          type: 'user',
          timestamp: '2026-07-01T08:00:30.000Z',
          uuid: 'result-1',
          parentUuid: 'assistant-1-tool',
          toolUseResult: { agentId: 'synthetic-agent' },
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu-spawn', content: 'launched' }],
          },
        }),
        event({
          type: 'system',
          subtype: 'turn_duration',
          timestamp: '2026-07-01T08:00:31.000Z',
          parentUuid: 'result-1',
          durationMs: 31_000,
        }),
      ],
      repository: null,
      sourceSessionId: 'streamed-launch',
    });
    expect(facts?.detailFacts.turns).toEqual([
      expect.objectContaining({
        durationMs: 31_000,
        endAt: '2026-07-01T08:00:31.000Z',
        index: 0,
        timingStatus: 'recorded',
        tools: 1,
      }),
    ]);
    expect(facts?.detailFacts.interactions).toEqual([
      expect.objectContaining({ toolUseId: 'toolu-spawn', turnIndex: 0 }),
    ]);
    expect(facts?.detailFacts.children).toEqual([expect.objectContaining({ spawnTurnIndex: 0 })]);
  });

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

  test('keeps one round per prompt across deep ancestry and broken chains, with observed bounds', () => {
    const records: Record<string, unknown>[] = [
      event({
        type: 'user',
        timestamp: '2026-08-17T10:00:00.000Z',
        uuid: 'prompt-1',
        promptId: 'recorded-prompt-1',
        message: { role: 'user', content: [{ type: 'text', text: 'Migrate every route' }] },
      }),
    ];
    // 150 alternating assistant/tool-result hops, far past the former 64-hop cap.
    let parent = 'prompt-1';
    for (let hop = 0; hop < 150; hop += 1) {
      const at = new Date(Date.parse('2026-08-17T10:00:00.000Z') + (hop + 1) * 10_000).toISOString();
      records.push(
        event({
          type: 'assistant',
          timestamp: at,
          uuid: `assistant-${hop}`,
          parentUuid: parent,
          requestId: `request-${hop}`,
          message: {
            id: `message-${hop}`,
            model: 'claude-sonnet-4-6',
            content: [{ type: 'tool_use', id: `toolu-${hop}`, name: 'Read', input: {} }],
            usage: { input_tokens: 5, output_tokens: 1 },
          },
        }),
        event({
          type: 'user',
          timestamp: at,
          uuid: `result-${hop}`,
          parentUuid: `assistant-${hop}`,
          promptId: 'recorded-prompt-1',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu-${hop}`, content: 'ok' }] },
        }),
      );
      parent = `result-${hop}`;
    }
    // A record whose parent was dropped as oversized: only Claude's promptId stamp links it back.
    records.push(
      event({
        type: 'assistant',
        timestamp: '2026-08-17T10:30:00.000Z',
        uuid: 'assistant-orphan',
        parentUuid: 'dropped-oversized-record',
        requestId: 'request-orphan',
        message: {
          id: 'message-orphan',
          model: 'claude-sonnet-4-6',
          content: [{ type: 'text', text: 'done' }],
          usage: { input_tokens: 2, output_tokens: 2 },
        },
      }),
      event({
        type: 'user',
        timestamp: '2026-08-17T10:31:00.000Z',
        uuid: 'result-orphan',
        parentUuid: 'assistant-orphan',
        promptId: 'recorded-prompt-1',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu-x', content: 'late result' }] },
      }),
    );
    // The orphan assistant's own parent is missing, but its child tool result carries the stamp;
    // model the real transcript shape where the assistant's parent is the stamped tool result.
    const orphan = records.find((record) => record.uuid === 'assistant-orphan');
    if (orphan) {
      orphan.parentUuid = 'result-orphan-parent';
    }
    records.push(
      event({
        type: 'user',
        timestamp: '2026-08-17T10:29:00.000Z',
        uuid: 'result-orphan-parent',
        parentUuid: 'dropped-oversized-record',
        promptId: 'recorded-prompt-1',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu-w', content: 'earlier' }] },
      }),
    );

    const facts = parseClaudeSessionFacts({ isAgentFile: false, records, repository: null, sourceSessionId: 'deep' });
    expect(facts?.detailFacts.turns).toHaveLength(1);
    expect(facts?.detailFacts.turns[0]).toMatchObject({
      calls: 151,
      costKind: 'approximate',
      endAt: '2026-08-17T10:31:00.000Z',
      promptIds: ['prompt-1'],
      startAt: '2026-08-17T10:00:00.000Z',
      timingStatus: 'unavailable',
      tools: 150,
    });
    expect(facts?.detailFacts.coverage.grouping.status).toBe('complete');
    expect(facts?.detailFacts.coverage.recordedTiming).toEqual({
      omittedCount: 1,
      reasons: ['timing-not-recorded'],
      status: 'unavailable',
    });
  });

  test('links sub-agents to the round that launched or messaged them, once per agent', () => {
    const facts = parseClaudeSessionFacts({
      agentMetas: [
        {
          agentId: 'agent-ae',
          agentType: 'codex:codex-rescue',
          description: 'Independent UI critique',
          toolUseId: 'toolu-spawn',
          workflowRunId: null,
        },
        {
          agentId: 'agent-meta-only',
          agentType: 'Explore',
          description: 'Locate loaders',
          toolUseId: 'toolu-lost',
          workflowRunId: null,
        },
        {
          agentId: 'agent-wf-1',
          agentType: 'workflow-subagent',
          description: null,
          toolUseId: null,
          workflowRunId: 'wf_run',
        },
        {
          agentId: 'agent-wf-2',
          agentType: 'workflow-subagent',
          description: null,
          toolUseId: null,
          workflowRunId: 'wf_run',
        },
      ],
      agentMetasUnreadable: 1,
      isAgentFile: false,
      records: [
        event({
          type: 'user',
          timestamp: '2026-08-17T10:00:00.000Z',
          uuid: 'prompt-1',
          message: { role: 'user', content: 'Start the migration' },
        }),
        event({
          type: 'assistant',
          timestamp: '2026-08-17T10:00:10.000Z',
          uuid: 'assistant-1',
          parentUuid: 'prompt-1',
          requestId: 'request-1',
          message: {
            id: 'message-1',
            model: 'claude-sonnet-4-6',
            content: [
              {
                type: 'tool_use',
                id: 'toolu-spawn',
                name: 'Agent',
                input: { description: 'Independent UI critique', subagent_type: 'codex:codex-rescue' },
              },
            ],
            usage: { input_tokens: 5, output_tokens: 1 },
          },
        }),
        event({
          type: 'user',
          timestamp: '2026-08-17T10:00:20.000Z',
          uuid: 'result-1',
          parentUuid: 'assistant-1',
          toolUseResult: { agentId: 'agent-ae', status: 'async_launched' },
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu-spawn', content: 'launched' }],
          },
        }),
        event({
          type: 'user',
          timestamp: '2026-08-17T11:00:00.000Z',
          uuid: 'prompt-2',
          message: { role: 'user', content: 'Ask the critic to go deeper' },
        }),
        event({
          type: 'assistant',
          timestamp: '2026-08-17T11:00:10.000Z',
          uuid: 'assistant-2',
          parentUuid: 'prompt-2',
          requestId: 'request-2',
          message: {
            id: 'message-2',
            model: 'claude-sonnet-4-6',
            content: [
              {
                type: 'tool_use',
                id: 'toolu-message',
                name: 'SendMessage',
                input: { to: 'agent-ae', summary: 'Go deeper' },
              },
              { type: 'tool_use', id: 'toolu-unanswered', name: 'Task', input: { description: 'Never answered' } },
              { type: 'tool_use', id: 'toolu-workflow', name: 'Workflow', input: { description: 'Audit in parallel' } },
            ],
            usage: { input_tokens: 5, output_tokens: 1 },
          },
        }),
        event({
          type: 'user',
          timestamp: '2026-08-17T11:00:20.000Z',
          uuid: 'result-workflow',
          parentUuid: 'assistant-2',
          toolUseResult: { runId: 'wf_run', status: 'async_launched' },
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu-workflow', content: 'started' }],
          },
        }),
      ],
      repository: null,
      sourceSessionId: 'links',
    });

    expect(facts?.detailFacts.children).toEqual([
      {
        agentType: 'codex:codex-rescue',
        evidence: 'claude-agent-link',
        label: 'Independent UI critique',
        sourceSessionId: 'agent-ae',
        spawnTurnIndex: 0,
      },
      {
        agentType: 'workflow-subagent',
        evidence: 'claude-agent-meta',
        label: null,
        sourceSessionId: 'agent-wf-1',
        spawnTurnIndex: 1,
      },
      {
        agentType: 'workflow-subagent',
        evidence: 'claude-agent-meta',
        label: null,
        sourceSessionId: 'agent-wf-2',
        spawnTurnIndex: 1,
      },
      {
        agentType: 'Explore',
        evidence: 'claude-agent-meta',
        label: 'Locate loaders',
        sourceSessionId: 'agent-meta-only',
        spawnTurnIndex: null,
      },
    ]);
    expect(facts?.detailFacts.interactions).toEqual([
      {
        at: '2026-08-17T10:00:10.000Z',
        childSourceSessionId: 'agent-ae',
        kind: 'spawn',
        label: 'Independent UI critique',
        toolUseId: 'toolu-spawn',
        turnIndex: 0,
      },
      {
        at: '2026-08-17T11:00:10.000Z',
        childSourceSessionId: 'agent-ae',
        kind: 'message',
        label: 'Go deeper',
        toolUseId: 'toolu-message',
        turnIndex: 1,
      },
      {
        at: '2026-08-17T11:00:10.000Z',
        childSourceSessionId: null,
        kind: 'spawn',
        label: 'Never answered',
        toolUseId: 'toolu-unanswered',
        turnIndex: 1,
      },
      {
        at: '2026-08-17T11:00:10.000Z',
        childSourceSessionId: null,
        kind: 'spawn',
        label: 'Audit in parallel',
        toolUseId: 'toolu-workflow',
        turnIndex: 1,
      },
    ]);
    expect(facts?.detailFacts.coverage.childDiscovery).toEqual({
      omittedCount: 2,
      reasons: ['child-result-missing', 'child-metadata-unreadable'],
      status: 'partial',
    });
    expect(facts?.detailFacts.coverage.interactionAttribution.status).toBe('complete');
    expect(facts?.detailFacts.turns[0]?.endAt).toBe('2026-08-17T10:00:20.000Z');
    expect(facts?.detailFacts.turns[1]?.endAt).toBe('2026-08-17T11:00:20.000Z');
    expect(JSON.stringify(facts?.report)).not.toContain('Independent UI critique');
  });

  test('keeps prompt identities past the body budget so late rounds still group', () => {
    const records: Record<string, unknown>[] = [];
    const bigBody = 'x'.repeat(32 * 1024);
    for (let index = 0; index < 34; index += 1) {
      const at = new Date(Date.parse('2026-08-17T10:00:00.000Z') + index * 60_000);
      records.push(
        event({
          type: 'user',
          timestamp: at.toISOString(),
          uuid: `prompt-${index}`,
          message: { role: 'user', content: `${index} ${bigBody}` },
        }),
        event({
          type: 'assistant',
          timestamp: new Date(at.getTime() + 1000).toISOString(),
          uuid: `assistant-${index}`,
          parentUuid: `prompt-${index}`,
          requestId: `request-${index}`,
          message: {
            id: `message-${index}`,
            model: 'claude-sonnet-4-6',
            content: [{ type: 'text', text: 'ok' }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        }),
      );
    }
    const facts = parseClaudeSessionFacts({ isAgentFile: false, records, repository: null, sourceSessionId: 'budget' });
    expect(facts?.detailFacts.prompts).toHaveLength(34);
    expect(facts?.detailFacts.turns).toHaveLength(34);
    expect(facts?.detailFacts.turns.every((turn) => turn.promptIds.length === 1)).toBe(true);
    const emptyBodies = facts?.detailFacts.prompts.filter(({ text }) => text.length === 0) ?? [];
    expect(emptyBodies.length).toBeGreaterThan(0);
    expect(emptyBodies.every(({ truncated }) => truncated)).toBe(true);
    expect(facts?.detailFacts.coverage.promptBodies).toMatchObject({
      reasons: ['prompt-body-budget'],
      status: 'partial',
    });
    expect(facts?.detailFacts.coverage.grouping.status).toBe('complete');
  });

  test('names child sessions the way the collector does and bounds link labels', () => {
    const facts = parseClaudeSessionFacts({
      agentMetas: [
        {
          agentId: 'a6331997c22b0d1fb',
          agentType: 'general-purpose',
          description: 'y'.repeat(300),
          toolUseId: 'toolu-1',
          workflowRunId: null,
        },
      ],
      isAgentFile: false,
      records: [
        event({
          type: 'user',
          timestamp: '2026-08-17T10:00:00.000Z',
          uuid: 'prompt-1',
          message: { role: 'user', content: 'Go' },
        }),
        event({
          type: 'assistant',
          timestamp: '2026-08-17T10:00:10.000Z',
          uuid: 'assistant-1',
          parentUuid: 'prompt-1',
          requestId: 'request-1',
          message: {
            id: 'message-1',
            model: 'claude-sonnet-4-6',
            content: [{ type: 'tool_use', id: 'toolu-1', name: 'Task', input: { description: 'x'.repeat(300) } }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        }),
        event({
          type: 'assistant',
          timestamp: '2026-08-17T10:00:10.000Z',
          uuid: 'assistant-1-streamed',
          parentUuid: 'prompt-1',
          requestId: 'request-1',
          message: {
            id: 'message-1',
            model: 'claude-sonnet-4-6',
            content: [{ type: 'tool_use', id: 'toolu-1', name: 'Task', input: { description: 'x'.repeat(300) } }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        }),
        event({
          type: 'user',
          timestamp: '2026-08-17T10:00:20.000Z',
          uuid: 'result-1',
          parentUuid: 'assistant-1',
          toolUseResult: { agentId: 'a6331997c22b0d1fb' },
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu-1', content: 'launched' }] },
        }),
      ],
      repository: null,
      sourceSessionId: 'prefix',
    });
    expect(facts?.detailFacts.children.map(({ sourceSessionId }) => sourceSessionId)).toEqual([
      'agent-a6331997c22b0d1fb',
    ]);
    expect(facts?.detailFacts.children[0]?.label).toHaveLength(256);
    expect(facts?.detailFacts.interactions).toHaveLength(1);
    expect(facts?.detailFacts.interactions[0]?.childSourceSessionId).toBe('agent-a6331997c22b0d1fb');
    expect(facts?.detailFacts.interactions[0]?.label).toHaveLength(256);
  });
});
