import { describe, expect, test } from 'bun:test';
import { extractClaudeSkillObservations } from '@ai-usage/local-machine/claude-session-facts';
import {
  codexSkillCatalogueObservations,
  extractCodexSkillCatalogue,
  extractCodexSkillExecObservation,
} from '@ai-usage/local-machine/codex-skill-observation';
import { decodeOpenCodeSkillPart } from '@ai-usage/local-machine/opencode-session-facts';

const record = (value: Record<string, unknown>): Record<string, unknown> => value;

const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const CWD = '/home/alex/Projects/report';

const claudeToolUse = (id: string, input: Record<string, unknown>, at: string) =>
  record({
    cwd: CWD,
    message: {
      content: [{ id, input, name: 'Skill', type: 'tool_use' }],
      model: 'claude-sonnet-4-6',
      role: 'assistant',
    },
    sessionId: SESSION,
    timestamp: at,
    type: 'assistant',
    uuid: `assistant-${id}`,
  });

const claudeToolResult = (id: string, success: boolean, at: string) =>
  record({
    cwd: CWD,
    message: { content: [{ content: 'Launching skill', tool_use_id: id, type: 'tool_result' }], role: 'user' },
    sessionId: SESSION,
    timestamp: at,
    toolUseResult: { commandName: 'improve', success },
    type: 'user',
    uuid: `result-${id}`,
  });

const claudeBaseDirectory = (id: string, directory: string, at: string) =>
  record({
    cwd: CWD,
    isMeta: true,
    message: { content: [{ text: `Base directory for this skill: ${directory}`, type: 'text' }], role: 'user' },
    sessionId: SESSION,
    sourceToolUseID: id,
    timestamp: at,
    type: 'user',
    uuid: `meta-${id}`,
  });

describe('extractClaudeSkillObservations', () => {
  test('declares an invocation and resolves its base directory from the bounded look-ahead', () => {
    const observations = extractClaudeSkillObservations({
      records: [
        claudeToolUse(
          'toolu_01',
          { args: 'Pre-release audit for the client', skill: 'improve' },
          '2026-08-01T09:00:00.000Z',
        ),
        claudeToolResult('toolu_01', true, '2026-08-01T09:00:01.000Z'),
        claudeBaseDirectory('toolu_01', '/home/alex/.claude/skills/improve', '2026-08-01T09:00:02.000Z'),
      ],
      sourceSessionId: SESSION,
    });

    expect(observations).toHaveLength(1);
    expect(observations[0]).toEqual({
      argsPresent: true,
      harnessKey: 'claude',
      observationKey: 'toolu_01',
      observedAt: '2026-08-01T09:00:00.000Z',
      projectPath: CWD,
      resolvedPath: '/home/alex/.claude/skills/improve',
      sessionId: SESSION,
      skillName: 'improve',
      success: true,
      tier: 'declared',
    });
  });

  test('never carries the argument text into the observation', () => {
    const secret = 'Audit for Northwind Trading before the Tuesday board call';
    const observations = extractClaudeSkillObservations({
      records: [claudeToolUse('toolu_02', { args: secret, skill: 'improve' }, '2026-08-01T09:00:00.000Z')],
      sourceSessionId: SESSION,
    });

    expect(observations).toHaveLength(1);
    expect(observations[0]?.argsPresent).toBe(true);
    expect(JSON.stringify(observations[0])).not.toContain('Northwind');
  });

  test('a bundled skill with no base directory stays an observation with a null resolved path', () => {
    const observations = extractClaudeSkillObservations({
      records: [
        claudeToolUse('toolu_03', { skill: 'artifact-design' }, '2026-08-01T10:00:00.000Z'),
        claudeToolResult('toolu_03', true, '2026-08-01T10:00:01.000Z'),
      ],
      sourceSessionId: SESSION,
    });

    expect(observations).toHaveLength(1);
    expect(observations[0]?.skillName).toBe('artifact-design');
    expect(observations[0]?.resolvedPath).toBeNull();
    expect(observations[0]?.success).toBe(true);
    expect(observations[0]?.argsPresent).toBe(false);
  });

  test('a base directory beyond the bounded look-ahead is a miss, not an error', () => {
    const filler = (index: number) =>
      record({
        message: { content: [{ text: `unrelated ${index}`, type: 'text' }], role: 'user' },
        sessionId: SESSION,
        timestamp: '2026-08-01T11:00:00.000Z',
        type: 'user',
        uuid: `filler-${index}`,
      });
    const observations = extractClaudeSkillObservations({
      records: [
        claudeToolUse('toolu_04', { skill: 'improve' }, '2026-08-01T11:00:00.000Z'),
        filler(1),
        filler(2),
        filler(3),
        claudeBaseDirectory('toolu_04', '/home/alex/.claude/skills/improve', '2026-08-01T11:00:05.000Z'),
      ],
      sourceSessionId: SESSION,
    });

    expect(observations).toHaveLength(1);
    expect(observations[0]?.resolvedPath).toBeNull();
  });

  test('yields nothing for a transcript with no Skill tool call', () => {
    const observations = extractClaudeSkillObservations({
      records: [
        record({
          message: { content: [{ id: 'toolu_09', input: {}, name: 'Read', type: 'tool_use' }], role: 'assistant' },
          sessionId: SESSION,
          timestamp: '2026-08-01T12:00:00.000Z',
          type: 'assistant',
        }),
        record({
          message: { content: [{ text: 'plain prose', type: 'text' }], role: 'user' },
          sessionId: SESSION,
          timestamp: '2026-08-01T12:00:01.000Z',
          type: 'user',
        }),
      ],
      sourceSessionId: SESSION,
    });

    expect(observations).toEqual([]);
  });
});

describe('decodeOpenCodeSkillPart', () => {
  const skillPart = (state: Record<string, unknown>) =>
    JSON.stringify({ callID: 'call_abc', state, tool: 'skill', type: 'tool' });

  test('declares an invocation and captures the resolved skill directory', () => {
    const observation = decodeOpenCodeSkillPart({
      data: skillPart({
        input: { name: 'write-a-skill' },
        metadata: { dir: '/home/alex/Projects/report/.agents/skills/write-a-skill', name: 'write-a-skill' },
        status: 'completed',
        time: { end: 1_771_069_566_208, start: 1_771_069_566_207 },
      }),
      projectPath: '/home/alex/Projects/report',
      session_id: 'ses_opencode_1',
      time_created: 1_771_069_566_207,
    });

    expect(observation).toEqual({
      argsPresent: null,
      harnessKey: 'opencode',
      observationKey: 'call_abc',
      observedAt: new Date(1_771_069_566_207).toISOString(),
      projectPath: '/home/alex/Projects/report',
      resolvedPath: '/home/alex/Projects/report/.agents/skills/write-a-skill',
      sessionId: 'ses_opencode_1',
      skillName: 'write-a-skill',
      success: true,
      tier: 'declared',
    });
  });

  test('an unresolvable name is retained as a state, with a null resolved path', () => {
    const observation = decodeOpenCodeSkillPart({
      data: skillPart({ input: { name: 'deleted-skill' }, status: 'completed' }),
      projectPath: null,
      session_id: 'ses_opencode_2',
      time_created: 1_771_069_566_207,
    });

    expect(observation).not.toBeNull();
    expect(observation?.skillName).toBe('deleted-skill');
    expect(observation?.resolvedPath).toBeNull();
    expect(observation?.tier).toBe('declared');
  });

  test('records a failed invocation as an unsuccessful observation, not a drop', () => {
    const observation = decodeOpenCodeSkillPart({
      data: skillPart({ input: { name: 'grilling' }, status: 'error' }),
      session_id: 'ses_opencode_3',
      time_created: 1_771_069_566_207,
    });

    expect(observation?.success).toBe(false);
  });

  test('yields nothing for a non-skill tool part', () => {
    const observation = decodeOpenCodeSkillPart({
      data: JSON.stringify({ callID: 'call_x', state: { input: {}, status: 'completed' }, tool: 'bash', type: 'tool' }),
      session_id: 'ses_opencode_4',
      time_created: 1_771_069_566_207,
    });

    expect(observation).toBeNull();
  });
});

describe('extractCodexSkillCatalogue', () => {
  const instructions = [
    '# Using skills',
    '',
    'Some prose about how skills work.',
    '',
    '### Available skills',
    '- imagegen: Generate or edit raster images. (file: /home/alex/.codex/skills/.system/imagegen/SKILL.md)',
    '- pr-review: Review a pull request end to end. (file: /home/alex/.agents/skills/pr-review/SKILL.md)',
    '- orchestrated: A skill with no filesystem location.',
    '',
    '## Next section',
    '- not-a-skill: this entry is past the section break. (file: /home/alex/nope/SKILL.md)',
  ].join('\n');

  test('parses names and normalizes each location to the skill directory', () => {
    expect(extractCodexSkillCatalogue(instructions)).toEqual([
      { name: 'imagegen', path: '/home/alex/.codex/skills/.system/imagegen' },
      { name: 'pr-review', path: '/home/alex/.agents/skills/pr-review' },
      { name: 'orchestrated', path: null },
    ]);
  });

  test('yields nothing when no catalogue block is present', () => {
    expect(extractCodexSkillCatalogue('# Using skills\n\nNo catalogue was injected in this session.')).toEqual([]);
    expect(extractCodexSkillCatalogue(undefined)).toEqual([]);
  });

  test('projects the catalogue to exposed observations that claim no outcome', () => {
    const observations = codexSkillCatalogueObservations(extractCodexSkillCatalogue(instructions), {
      observedAt: '2026-08-21T16:47:05.889Z',
      projectPath: CWD,
      sessionId: 'codex-session-1',
    });

    expect(observations.map(({ skillName }) => skillName)).toEqual(['imagegen', 'pr-review', 'orchestrated']);
    expect(observations.every(({ tier }) => tier === 'exposed')).toBe(true);
    expect(observations.every(({ success }) => success === null)).toBe(true);
    expect(observations[0]?.observationKey).toBe('catalogue:imagegen');
  });
});

describe('extractCodexSkillExecObservation', () => {
  const context = { observedAt: '2026-08-21T16:47:17.474Z', projectPath: CWD, sessionId: 'codex-session-1' };

  test('infers a read from an exec command naming a SKILL.md', () => {
    const observations = extractCodexSkillExecObservation(
      "sed -n '1,240p' /home/alex/.agents/skills/diagnosing-bugs/SKILL.md",
      'call_E5x6',
      context,
    );

    expect(observations).toEqual([
      {
        argsPresent: null,
        harnessKey: 'codex',
        observationKey: 'exec:call_E5x6:diagnosing-bugs',
        observedAt: context.observedAt,
        projectPath: CWD,
        resolvedPath: '/home/alex/.agents/skills/diagnosing-bugs',
        sessionId: 'codex-session-1',
        skillName: 'diagnosing-bugs',
        success: null,
        tier: 'inferred',
      },
    ]);
  });

  test('deduplicates repeated names inside one command', () => {
    const observations = extractCodexSkillExecObservation(
      'cat /home/alex/skills/improve/SKILL.md /home/alex/skills/improve/SKILL.md /home/alex/skills/yeet/SKILL.md',
      'call_two',
      context,
    );

    expect(observations.map(({ skillName }) => skillName)).toEqual(['improve', 'yeet']);
  });

  test('never lands in the declared tier', () => {
    const observations = extractCodexSkillExecObservation(
      'cat /home/alex/skills/improve/SKILL.md',
      'call_tier',
      context,
    );

    expect(observations[0]?.tier).toBe('inferred');
  });

  test('yields nothing for a command that reads no skill document', () => {
    expect(extractCodexSkillExecObservation('bun run check', 'call_none', context)).toEqual([]);
    expect(extractCodexSkillExecObservation('cat /home/alex/README.md', 'call_none', context)).toEqual([]);
    expect(extractCodexSkillExecObservation(undefined, 'call_none', context)).toEqual([]);
  });
});
