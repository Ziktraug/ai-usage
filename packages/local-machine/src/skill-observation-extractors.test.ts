import { describe, expect, test } from 'bun:test';
import { extractClaudeSkillObservations } from '@ai-usage/local-machine/claude-session-facts';
import {
  codexSkillCatalogueObservations,
  decodeCodexCommand,
  decodeCodexCommands,
  extractCodexSkillCatalogue,
  extractCodexSkillExecObservation,
  matchCodexSkillDocuments,
} from '@ai-usage/local-machine/codex-skill-observation';
import { decodeOpenCodeSkillPart } from '@ai-usage/local-machine/opencode-session-facts';
import {
  CLAUDE_FIXTURE_ARGUMENT_TEXT,
  CLAUDE_FIXTURE_SESSION,
  claudeBundledSkillTranscript,
  claudeLateBaseDirectoryTranscript,
  claudeNoSkillTranscript,
  claudeResolvedSkillTranscript,
  codexApplyPatchPayload,
  codexCatalogueInstructions,
  codexCompoundPayload,
  codexCustomToolCallPayload,
  codexDestructivePayload,
  codexExecCommandPayload,
  codexShellArrayPayload,
  openCodeFailedSkillPart,
  openCodeOtherToolPart,
  openCodeResolvedSkillPart,
  openCodeUnresolvedSkillPart,
  SKILL_FIXTURE_HOME,
  SKILL_FIXTURE_PROJECT,
} from '@ai-usage/local-machine/test-fixtures/skill-observation-transcripts';
import { MAX_SKILL_OBSERVATIONS_PER_SESSION } from '@ai-usage/report-core/skill-observation';

const FIXTURE_HOME_PREFIX = /^\/home\/alex\//;

const codexContext = {
  observedAt: '2026-08-21T16:47:17.474Z',
  projectPath: SKILL_FIXTURE_PROJECT,
  sessionId: 'codex-session-1',
};

describe('extractClaudeSkillObservations', () => {
  test('declares an invocation and resolves its base directory from the bounded look-ahead', () => {
    const extraction = extractClaudeSkillObservations({
      records: claudeResolvedSkillTranscript,
      sourceSessionId: CLAUDE_FIXTURE_SESSION,
    });

    expect(extraction.rejected).toBe(0);
    expect(extraction.observations).toEqual([
      {
        argsPresent: true,
        harnessKey: 'claude',
        observationKey: 'toolu_managed',
        observedAt: '2026-08-01T09:00:00.000Z',
        projectPath: SKILL_FIXTURE_PROJECT,
        resolvedPath: `${SKILL_FIXTURE_HOME}/.claude/skills/improve`,
        sessionId: CLAUDE_FIXTURE_SESSION,
        skillName: 'improve',
        success: true,
        tier: 'declared',
      },
    ]);
  });

  test('never carries the argument text into the observation', () => {
    const extraction = extractClaudeSkillObservations({
      records: claudeResolvedSkillTranscript,
      sourceSessionId: CLAUDE_FIXTURE_SESSION,
    });

    expect(JSON.stringify(extraction.observations)).not.toContain(CLAUDE_FIXTURE_ARGUMENT_TEXT);
    expect(JSON.stringify(extraction.observations)).not.toContain('Northwind');
    expect(extraction.observations[0]?.argsPresent).toBe(true);
  });

  test('a bundled skill with no base directory stays an observation with a null resolved path', () => {
    const extraction = extractClaudeSkillObservations({
      records: claudeBundledSkillTranscript,
      sourceSessionId: CLAUDE_FIXTURE_SESSION,
    });

    expect(extraction.observations).toHaveLength(1);
    expect(extraction.observations[0]?.skillName).toBe('artifact-design');
    expect(extraction.observations[0]?.resolvedPath).toBeNull();
    expect(extraction.observations[0]?.success).toBe(true);
    expect(extraction.observations[0]?.argsPresent).toBe(false);
  });

  test('a base directory beyond the bounded look-ahead is a miss, not an error', () => {
    const extraction = extractClaudeSkillObservations({
      records: claudeLateBaseDirectoryTranscript,
      sourceSessionId: CLAUDE_FIXTURE_SESSION,
    });

    expect(extraction.observations).toHaveLength(1);
    expect(extraction.observations[0]?.resolvedPath).toBeNull();
    expect(extraction.rejected).toBe(0);
  });

  test('yields nothing for a transcript with no Skill tool call', () => {
    const extraction = extractClaudeSkillObservations({
      records: claudeNoSkillTranscript,
      sourceSessionId: CLAUDE_FIXTURE_SESSION,
    });

    expect(extraction).toEqual({ observations: [], rejected: 0, truncated: false });
  });

  test('flags the per-session ceiling instead of silently returning a short list', () => {
    const skillCall = (index: number) => ({
      cwd: SKILL_FIXTURE_PROJECT,
      message: {
        content: [{ id: `toolu_${index}`, input: { skill: `skill-${index}` }, name: 'Skill', type: 'tool_use' }],
        role: 'assistant',
      },
      sessionId: CLAUDE_FIXTURE_SESSION,
      timestamp: '2026-08-01T09:00:00.000Z',
      type: 'assistant',
    });
    const records = Array.from({ length: MAX_SKILL_OBSERVATIONS_PER_SESSION + 5 }, (_, index) => skillCall(index));

    const extraction = extractClaudeSkillObservations({ records, sourceSessionId: CLAUDE_FIXTURE_SESSION });

    expect(extraction.observations).toHaveLength(MAX_SKILL_OBSERVATIONS_PER_SESSION);
    // The count is a lower bound; saying so is the difference between a bounded
    // read and a wrong number.
    expect(extraction.truncated).toBe(true);
  });

  test('does not flag truncation for a session inside the ceiling', () => {
    expect(
      extractClaudeSkillObservations({
        records: claudeResolvedSkillTranscript,
        sourceSessionId: CLAUDE_FIXTURE_SESSION,
      }).truncated,
    ).toBe(false);
  });

  test('counts a Skill call that cannot be validated instead of dropping it silently', () => {
    const extraction = extractClaudeSkillObservations({
      records: [
        {
          cwd: SKILL_FIXTURE_PROJECT,
          message: {
            // No skill name: the transcript shape moved.
            content: [{ id: 'toolu_broken', input: {}, name: 'Skill', type: 'tool_use' }],
            role: 'assistant',
          },
          sessionId: CLAUDE_FIXTURE_SESSION,
          timestamp: '2026-08-01T09:00:00.000Z',
          type: 'assistant',
        },
      ],
      sourceSessionId: CLAUDE_FIXTURE_SESSION,
    });

    expect(extraction.observations).toEqual([]);
    expect(extraction.rejected).toBe(1);
  });
});

describe('decodeOpenCodeSkillPart', () => {
  test('declares an invocation and captures the resolved skill directory', () => {
    expect(decodeOpenCodeSkillPart(openCodeResolvedSkillPart)).toEqual({
      argsPresent: null,
      harnessKey: 'opencode',
      observationKey: 'call_resolved',
      observedAt: new Date(1_771_069_566_207).toISOString(),
      projectPath: SKILL_FIXTURE_PROJECT,
      resolvedPath: `${SKILL_FIXTURE_PROJECT}/.agents/skills/web-design-guidelines`,
      sessionId: openCodeResolvedSkillPart.session_id,
      skillName: 'web-design-guidelines',
      success: true,
      tier: 'declared',
    });
  });

  test('an unresolvable name is retained as a state, with a null resolved path', () => {
    const observation = decodeOpenCodeSkillPart(openCodeUnresolvedSkillPart);

    expect(observation).not.toBeNull();
    expect(observation?.skillName).toBe('deleted-skill');
    expect(observation?.resolvedPath).toBeNull();
    expect(observation?.tier).toBe('declared');
  });

  test('records a failed invocation as an unsuccessful observation, not a drop', () => {
    expect(decodeOpenCodeSkillPart(openCodeFailedSkillPart)?.success).toBe(false);
  });

  test('yields nothing for a non-skill tool part', () => {
    expect(decodeOpenCodeSkillPart(openCodeOtherToolPart)).toBeNull();
  });
});

describe('extractCodexSkillCatalogue', () => {
  test('parses names, keeps namespaced siblings apart, and normalizes each location', () => {
    expect(extractCodexSkillCatalogue(codexCatalogueInstructions)).toEqual([
      { name: 'imagegen', path: `${SKILL_FIXTURE_HOME}/.codex/skills/.system/imagegen` },
      { name: 'pr-review', path: `${SKILL_FIXTURE_HOME}/.agents/skills/pr-review` },
      { name: 'vercel:nextjs', path: `${SKILL_FIXTURE_HOME}/.codex/plugins/cache/vercel/skills/vercel:nextjs` },
      { name: 'vercel:ai-sdk', path: `${SKILL_FIXTURE_HOME}/.codex/plugins/cache/vercel/skills/vercel:ai-sdk` },
      { name: 'orchestrated', path: null },
    ]);
  });

  test('does not let a colon inside a description extend the skill name', () => {
    const parsed = extractCodexSkillCatalogue('### Available skills\n- tdd: Use when x:y matters.');
    expect(parsed).toEqual([{ name: 'tdd', path: null }]);
  });

  test('yields nothing when no catalogue block is present', () => {
    expect(extractCodexSkillCatalogue('# Using skills\n\nNo catalogue was injected.')).toEqual([]);
    expect(extractCodexSkillCatalogue(undefined)).toEqual([]);
  });

  test('projects the catalogue to exposed observations that claim no outcome', () => {
    const extraction = codexSkillCatalogueObservations(
      extractCodexSkillCatalogue(codexCatalogueInstructions),
      codexContext,
    );

    expect(extraction.rejected).toBe(0);
    expect(extraction.observations.every(({ tier }) => tier === 'exposed')).toBe(true);
    expect(extraction.observations.every(({ success }) => success === null)).toBe(true);
    expect(extraction.observations[0]?.observationKey).toBe('catalogue:imagegen');
    expect(extraction.observations.map(({ skillName }) => skillName)).toContain('vercel:ai-sdk');
  });
});

describe('decodeCodexCommand', () => {
  test('recovers the command from the JSON arguments envelope', () => {
    expect(decodeCodexCommand(codexExecCommandPayload.arguments)).toBe(
      `sed -n '1,220p' ${SKILL_FIXTURE_HOME}/.agents/skills/diagnosing-bugs/SKILL.md`,
    );
  });

  test('recovers the command from the JavaScript snippet envelope with an unquoted key', () => {
    expect(decodeCodexCommand(codexCustomToolCallPayload.input)).toBe(
      `sed -n '1,240p' ${SKILL_FIXTURE_HOME}/.agents/skills/code-review/SKILL.md`,
    );
  });

  test('recovers the command from the shell array envelope', () => {
    expect(decodeCodexCommand(codexShellArrayPayload.input)).toBe(
      `cat ${SKILL_FIXTURE_HOME}/.agents/skills/code-review/SKILL.md`,
    );
  });

  test('returns null rather than guessing when no command is present', () => {
    expect(decodeCodexCommand('*** Begin Patch')).toBeNull();
    expect(decodeCodexCommand(undefined)).toBeNull();
  });
});

describe('extractCodexSkillExecObservation', () => {
  test('infers a read from the production JSON arguments envelope with a clean path', () => {
    const extraction = extractCodexSkillExecObservation(
      codexExecCommandPayload.arguments,
      codexExecCommandPayload.call_id,
      codexContext,
    );

    expect(extraction.observations).toEqual([
      {
        argsPresent: null,
        harnessKey: 'codex',
        observationKey: 'exec:call_exec_command:diagnosing-bugs',
        observedAt: codexContext.observedAt,
        projectPath: SKILL_FIXTURE_PROJECT,
        resolvedPath: `${SKILL_FIXTURE_HOME}/.agents/skills/diagnosing-bugs`,
        sessionId: codexContext.sessionId,
        skillName: 'diagnosing-bugs',
        success: null,
        tier: 'inferred',
      },
    ]);
  });

  test('infers a read from the production JavaScript snippet envelope with a clean path', () => {
    const extraction = extractCodexSkillExecObservation(
      codexCustomToolCallPayload.input,
      codexCustomToolCallPayload.call_id,
      codexContext,
    );

    expect(extraction.observations).toHaveLength(1);
    expect(extraction.observations[0]?.skillName).toBe('code-review');
    expect(extraction.observations[0]?.resolvedPath).toBe(`${SKILL_FIXTURE_HOME}/.agents/skills/code-review`);
  });

  test('never lets command or JSON fragments into the resolved path', () => {
    for (const payload of [codexExecCommandPayload, codexCustomToolCallPayload, codexShellArrayPayload]) {
      const blob = 'arguments' in payload ? payload.arguments : payload.input;
      for (const entry of matchCodexSkillDocuments(blob)) {
        expect(entry.path).not.toBeNull();
        // A junk prefix is exactly what the anchored token match prevents.
        expect(entry.path).toMatch(FIXTURE_HOME_PREFIX);
        expect(entry.path).not.toContain('{');
        expect(entry.path).not.toContain('"');
        expect(entry.path).not.toContain('cmd');
        expect(entry.path).not.toContain('sed');
        expect(entry.name).not.toContain('"');
      }
    }
  });

  test('reads the verb of the segment that names the document, not the head of the command', () => {
    const extraction = extractCodexSkillExecObservation(
      codexCompoundPayload.arguments,
      codexCompoundPayload.call_id,
      codexContext,
    );

    expect(extraction.observations.map(({ skillName }) => skillName)).toEqual(['tdd']);
  });

  test('does not count a destructive command as an inferred read', () => {
    const extraction = extractCodexSkillExecObservation(
      codexDestructivePayload.arguments,
      codexDestructivePayload.call_id,
      codexContext,
    );

    expect(extraction.observations).toEqual([]);
  });

  test('does not count a patch body that merely quotes a skill path', () => {
    const extraction = extractCodexSkillExecObservation(
      codexApplyPatchPayload.input,
      codexApplyPatchPayload.call_id,
      codexContext,
    );

    expect(extraction.observations).toEqual([]);
  });

  test('does not count a skill document in redirect-target position as a read', () => {
    for (const cmd of [
      `cat README.md > ${SKILL_FIXTURE_HOME}/.agents/skills/review/SKILL.md`,
      `cat README.md >${SKILL_FIXTURE_HOME}/.agents/skills/review/SKILL.md`,
      `cat README.md >> ${SKILL_FIXTURE_HOME}/.agents/skills/review/SKILL.md`,
      `cat README.md 2> ${SKILL_FIXTURE_HOME}/.agents/skills/review/SKILL.md`,
    ]) {
      // The token is being written, not read. An overwrite is not an invocation.
      expect(
        extractCodexSkillExecObservation(JSON.stringify({ cmd }), 'call_redirect', codexContext).observations,
      ).toEqual([]);
    }
  });

  test('does not count a skill document used as a search pattern operand', () => {
    for (const verb of ['rg', 'grep']) {
      const extraction = extractCodexSkillExecObservation(
        JSON.stringify({ cmd: `${verb} ${SKILL_FIXTURE_HOME}/.agents/skills/review/SKILL.md /tmp/transcript.txt` }),
        'call_pattern',
        codexContext,
      );
      // The path is what is being searched *for*; the file read is the transcript.
      expect(extraction.observations).toEqual([]);
    }
  });

  test('still counts a search whose file operand is the skill document', () => {
    const extraction = extractCodexSkillExecObservation(
      JSON.stringify({ cmd: `rg needle ${SKILL_FIXTURE_HOME}/.agents/skills/review/SKILL.md` }),
      'call_search_read',
      codexContext,
    );

    expect(extraction.observations.map(({ skillName }) => skillName)).toEqual(['review']);
  });

  test('ties each decoded command to its own exec call in a multi-call snippet', () => {
    const snippet = [
      `const a = await tools.exec_command({cmd:"cat ${SKILL_FIXTURE_HOME}/.agents/skills/first/SKILL.md"});`,
      `const b = await tools.exec_command({cmd:"cat ${SKILL_FIXTURE_HOME}/.agents/skills/second/SKILL.md"});`,
    ].join('\n');

    // A first-key-wins scan would report only `first`.
    expect(decodeCodexCommands(snippet)).toHaveLength(2);
    expect(
      extractCodexSkillExecObservation(snippet, 'call_multi', codexContext).observations.map((o) => o.skillName),
    ).toEqual(['first', 'second']);
  });

  test('does not attribute a cmd key that belongs to no exec call', () => {
    const snippet = `const note = {cmd:"cat ${SKILL_FIXTURE_HOME}/.agents/skills/decoy/SKILL.md"};\nconst r = await tools.exec_command({cmd:"cat ${SKILL_FIXTURE_HOME}/.agents/skills/real/SKILL.md"});`;

    expect(
      extractCodexSkillExecObservation(snippet, 'call_scoped', codexContext).observations.map((o) => o.skillName),
    ).toEqual(['real']);
  });

  test('deduplicates repeated names inside one command', () => {
    const extraction = extractCodexSkillExecObservation(
      JSON.stringify({
        cmd: `cat ${SKILL_FIXTURE_HOME}/skills/improve/SKILL.md ${SKILL_FIXTURE_HOME}/skills/improve/SKILL.md ${SKILL_FIXTURE_HOME}/skills/yeet/SKILL.md`,
      }),
      'call_two',
      codexContext,
    );

    expect(extraction.observations.map(({ skillName }) => skillName)).toEqual(['improve', 'yeet']);
  });

  test('yields nothing for a command that reads no skill document', () => {
    expect(extractCodexSkillExecObservation('bun run check', 'call_none', codexContext).observations).toEqual([]);
    expect(
      extractCodexSkillExecObservation(JSON.stringify({ cmd: 'cat /home/alex/README.md' }), 'call_none', codexContext)
        .observations,
    ).toEqual([]);
    expect(extractCodexSkillExecObservation(undefined, 'call_none', codexContext).observations).toEqual([]);
  });
});
