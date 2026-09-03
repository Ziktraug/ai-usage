/**
 * Synthetic transcript samples for the skill-observation extractors.
 *
 * Every shape here is redacted from a real local transcript: the paths use
 * `/home/alex`, the machine reads `MacBook-Pro`, and no argument prose from a
 * real session survives. The *shapes* are faithful, and that fidelity is the
 * point — the Codex exec payloads in particular reproduce the two production
 * envelopes exactly, because tests built on hand-simplified shell strings
 * cannot catch the class of bug that motivated them.
 */

export const SKILL_FIXTURE_HOME = '/home/alex';
export const SKILL_FIXTURE_MACHINE_LABEL = 'MacBook-Pro';
export const SKILL_FIXTURE_PROJECT = '/home/alex/Projects/report';
export const CLAUDE_FIXTURE_SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
export const CODEX_FIXTURE_SESSION = 'codex-fixture-099';
export const OPENCODE_FIXTURE_SESSION = 'ses_opencode_fixture_099';

const claudeToolUse = (id: string, input: Record<string, unknown>, at: string): Record<string, unknown> => ({
  cwd: SKILL_FIXTURE_PROJECT,
  message: {
    content: [{ id, input, name: 'Skill', type: 'tool_use' }],
    model: 'claude-sonnet-4-6',
    role: 'assistant',
  },
  sessionId: CLAUDE_FIXTURE_SESSION,
  timestamp: at,
  type: 'assistant',
  uuid: `assistant-${id}`,
});

const claudeToolResult = (id: string, success: boolean, at: string): Record<string, unknown> => ({
  cwd: SKILL_FIXTURE_PROJECT,
  message: { content: [{ content: 'Launching skill', tool_use_id: id, type: 'tool_result' }], role: 'user' },
  sessionId: CLAUDE_FIXTURE_SESSION,
  timestamp: at,
  toolUseResult: { commandName: 'improve', success },
  type: 'user',
  uuid: `result-${id}`,
});

const claudeBaseDirectory = (id: string, directory: string, at: string): Record<string, unknown> => ({
  cwd: SKILL_FIXTURE_PROJECT,
  isMeta: true,
  message: { content: [{ text: `Base directory for this skill: ${directory}`, type: 'text' }], role: 'user' },
  sessionId: CLAUDE_FIXTURE_SESSION,
  sourceToolUseID: id,
  timestamp: at,
  type: 'user',
  uuid: `meta-${id}`,
});

const claudeFiller = (index: number): Record<string, unknown> => ({
  message: { content: [{ text: `unrelated ${index}`, type: 'text' }], role: 'user' },
  sessionId: CLAUDE_FIXTURE_SESSION,
  timestamp: '2026-08-01T11:00:00.000Z',
  type: 'user',
  uuid: `filler-${index}`,
});

/** Argument prose stands in for the client names measured in real transcripts. */
export const CLAUDE_FIXTURE_ARGUMENT_TEXT = 'Audit for Northwind Trading before the Tuesday board call';

/** A managed skill: declared, resolved, successful, with arguments. */
export const claudeResolvedSkillTranscript: readonly unknown[] = [
  claudeToolUse('toolu_managed', { args: CLAUDE_FIXTURE_ARGUMENT_TEXT, skill: 'improve' }, '2026-08-01T09:00:00.000Z'),
  claudeToolResult('toolu_managed', true, '2026-08-01T09:00:01.000Z'),
  claudeBaseDirectory('toolu_managed', `${SKILL_FIXTURE_HOME}/.claude/skills/improve`, '2026-08-01T09:00:02.000Z'),
];

/** A harness-bundled skill: declared, but resolving to nothing. A state, not a gap. */
export const claudeBundledSkillTranscript: readonly unknown[] = [
  claudeToolUse('toolu_bundled', { skill: 'artifact-design' }, '2026-08-01T10:00:00.000Z'),
  claudeToolResult('toolu_bundled', true, '2026-08-01T10:00:01.000Z'),
];

/** The base directory arrives past the bounded look-ahead: a miss, not an error. */
export const claudeLateBaseDirectoryTranscript: readonly unknown[] = [
  claudeToolUse('toolu_late', { skill: 'improve' }, '2026-08-01T11:00:00.000Z'),
  claudeFiller(1),
  claudeFiller(2),
  claudeFiller(3),
  claudeBaseDirectory('toolu_late', `${SKILL_FIXTURE_HOME}/.claude/skills/improve`, '2026-08-01T11:00:05.000Z'),
];

/** A transcript with tool use but no skill invocation. */
export const claudeNoSkillTranscript: readonly unknown[] = [
  {
    message: { content: [{ id: 'toolu_read', input: {}, name: 'Read', type: 'tool_use' }], role: 'assistant' },
    sessionId: CLAUDE_FIXTURE_SESSION,
    timestamp: '2026-08-01T12:00:00.000Z',
    type: 'assistant',
  },
  {
    message: { content: [{ text: 'plain prose', type: 'text' }], role: 'user' },
    sessionId: CLAUDE_FIXTURE_SESSION,
    timestamp: '2026-08-01T12:00:01.000Z',
    type: 'user',
  },
];

/**
 * A Codex instructions blob carrying the catalogue. Includes a namespaced
 * plugin skill (`vercel:nextjs`) and a sibling under the same namespace, which
 * a name pattern that stops at the first colon would collapse into one entry.
 */
export const codexCatalogueInstructions = [
  '# Using skills',
  '',
  'A skill is a set of instructions provided through a `SKILL.md` source.',
  '',
  '### Available skills',
  `- imagegen: Generate or edit raster images. (file: ${SKILL_FIXTURE_HOME}/.codex/skills/.system/imagegen/SKILL.md)`,
  `- pr-review: Review a pull request end to end. (file: ${SKILL_FIXTURE_HOME}/.agents/skills/pr-review/SKILL.md)`,
  `- vercel:nextjs: Build with Next.js. (file: ${SKILL_FIXTURE_HOME}/.codex/plugins/cache/vercel/skills/vercel:nextjs/SKILL.md)`,
  `- vercel:ai-sdk: Build with the AI SDK. (file: ${SKILL_FIXTURE_HOME}/.codex/plugins/cache/vercel/skills/vercel:ai-sdk/SKILL.md)`,
  '- orchestrated: A skill with no filesystem location.',
  '',
  '## Next section',
  `- not-a-skill: past the section break. (file: ${SKILL_FIXTURE_HOME}/nope/SKILL.md)`,
].join('\n');

/**
 * The two Codex exec envelopes exactly as production writes them.
 *
 * Neither is a bare shell string. `function_call` / `exec_command` carries JSON
 * in `arguments`; `custom_tool_call` / `exec` carries a JavaScript snippet in
 * `input` whose object literal uses an *unquoted* key. Matching either raw
 * captures surrounding JSON as part of the path.
 */
export const codexExecCommandPayload = {
  arguments: JSON.stringify({
    cmd: `sed -n '1,220p' ${SKILL_FIXTURE_HOME}/.agents/skills/diagnosing-bugs/SKILL.md`,
    max_output_tokens: 12_000,
    workdir: SKILL_FIXTURE_PROJECT,
    yield_time_ms: 10_000,
  }),
  call_id: 'call_exec_command',
  name: 'exec_command',
  type: 'function_call',
} as const;

export const codexCustomToolCallPayload = {
  call_id: 'call_custom_tool',
  input: `const r = await tools.exec_command({cmd:"sed -n '1,240p' ${SKILL_FIXTURE_HOME}/.agents/skills/code-review/SKILL.md","workdir":"${SKILL_FIXTURE_PROJECT}","yield_time_ms":10000}); text(r.output);\n`,
  name: 'exec',
  type: 'custom_tool_call',
} as const;

/** The classic array form, quoted here as the reviewer's reported failure case. */
export const codexShellArrayPayload = {
  call_id: 'call_shell_array',
  input: JSON.stringify({ command: ['cat', `${SKILL_FIXTURE_HOME}/.agents/skills/code-review/SKILL.md`] }),
  name: 'exec',
  type: 'custom_tool_call',
} as const;

/** A destructive command naming a SKILL.md. Not evidence that anything was used. */
export const codexDestructivePayload = {
  arguments: JSON.stringify({ cmd: `rm ${SKILL_FIXTURE_HOME}/.agents/skills/code-review/SKILL.md` }),
  call_id: 'call_destructive',
  name: 'exec_command',
  type: 'function_call',
} as const;

/** A compound command: the read is in a later segment than the leading verb. */
export const codexCompoundPayload = {
  arguments: JSON.stringify({
    cmd: `set -euo pipefail; sed -n '1,80p' ${SKILL_FIXTURE_HOME}/.agents/skills/tdd/SKILL.md`,
  }),
  call_id: 'call_compound',
  name: 'exec_command',
  type: 'function_call',
} as const;

/** A patch body quoting a SKILL.md path — never a read. */
export const codexApplyPatchPayload = {
  call_id: 'call_patch',
  input: `*** Begin Patch\n*** Update File: ${SKILL_FIXTURE_HOME}/.agents/skills/code-review/SKILL.md\n@@\n-old\n+new\n*** End Patch`,
  name: 'apply_patch',
  type: 'custom_tool_call',
} as const;

const openCodeSkillPart = (callId: string, state: Record<string, unknown>) =>
  JSON.stringify({ callID: callId, state, tool: 'skill', type: 'tool' });

/** A declared invocation whose skill directory the harness recorded. */
export const openCodeResolvedSkillPart = {
  data: openCodeSkillPart('call_resolved', {
    input: { name: 'web-design-guidelines' },
    metadata: { dir: `${SKILL_FIXTURE_PROJECT}/.agents/skills/web-design-guidelines`, name: 'web-design-guidelines' },
    status: 'completed',
    time: { end: 1_771_069_566_208, start: 1_771_069_566_207 },
  }),
  id: 'part-resolved',
  projectPath: SKILL_FIXTURE_PROJECT,
  session_id: OPENCODE_FIXTURE_SESSION,
  time_created: 1_771_069_566_207,
};

/** A declared invocation naming a skill that resolves to nothing. */
export const openCodeUnresolvedSkillPart = {
  data: openCodeSkillPart('call_unresolved', { input: { name: 'deleted-skill' }, status: 'completed' }),
  id: 'part-unresolved',
  projectPath: null,
  session_id: OPENCODE_FIXTURE_SESSION,
  time_created: 1_771_069_566_300,
};

/** A failed invocation: recorded as unsuccessful, never dropped. */
export const openCodeFailedSkillPart = {
  data: openCodeSkillPart('call_failed', { input: { name: 'grilling' }, status: 'error' }),
  id: 'part-failed',
  projectPath: null,
  session_id: OPENCODE_FIXTURE_SESSION,
  time_created: 1_771_069_566_400,
};

/** A tool part that is not a skill invocation. */
export const openCodeOtherToolPart = {
  data: JSON.stringify({ callID: 'call_bash', state: { input: {}, status: 'completed' }, tool: 'bash', type: 'tool' }),
  id: 'part-bash',
  projectPath: null,
  session_id: OPENCODE_FIXTURE_SESSION,
  time_created: 1_771_069_566_500,
};
