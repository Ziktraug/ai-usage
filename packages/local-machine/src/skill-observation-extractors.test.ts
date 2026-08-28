import { afterEach, describe, expect, test } from 'bun:test';
import {
  extractClaudeSkillObservations,
  setClaudeSkillObservationCeilingForTesting,
} from '@ai-usage/local-machine/claude-session-facts';
import {
  codexSkillCatalogueObservations,
  decodeCodexCommand,
  decodeCodexCommands,
  extractCodexSkillCatalogue,
  extractCodexSkillExecObservation,
  matchCodexSkillDocuments,
  setCodexSkillObservationCeilingForTesting,
} from '@ai-usage/local-machine/codex-skill-observation';
import { createCodexSessionParser } from '@ai-usage/local-machine/internal/codex-history';
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

  describe('per-session ceiling', () => {
    afterEach(() => {
      setClaudeSkillObservationCeilingForTesting(null);
    });

    const skillBlock = (index: number) => ({
      id: `toolu_${index}`,
      input: { skill: `skill-${index}` },
      name: 'Skill',
      type: 'tool_use',
    });
    const envelope = (blocks: unknown[]) => ({
      cwd: SKILL_FIXTURE_PROJECT,
      message: { content: blocks, role: 'assistant' },
      sessionId: CLAUDE_FIXTURE_SESSION,
      timestamp: '2026-08-01T09:00:00.000Z',
      type: 'assistant',
    });

    test('trips on many calls inside one envelope, not just across envelopes', () => {
      setClaudeSkillObservationCeilingForTesting(3);
      // A per-envelope check leaves the inner block loop unbounded, so a single
      // message can blow straight past the ceiling and report `truncated:false`.
      const records = [envelope(Array.from({ length: 5 }, (_, index) => skillBlock(index)))];

      const extraction = extractClaudeSkillObservations({ records, sourceSessionId: CLAUDE_FIXTURE_SESSION });

      expect(extraction.observations).toHaveLength(3);
      expect(extraction.truncated).toBe(true);
    });

    test('trips across envelopes as well', () => {
      setClaudeSkillObservationCeilingForTesting(3);
      const records = Array.from({ length: 5 }, (_, index) => envelope([skillBlock(index)]));

      const extraction = extractClaudeSkillObservations({ records, sourceSessionId: CLAUDE_FIXTURE_SESSION });

      expect(extraction.observations).toHaveLength(3);
      expect(extraction.truncated).toBe(true);
    });

    test('does not flag truncation for a session inside the ceiling', () => {
      setClaudeSkillObservationCeilingForTesting(3);
      const extraction = extractClaudeSkillObservations({
        records: [envelope([skillBlock(0), skillBlock(1)])],
        sourceSessionId: CLAUDE_FIXTURE_SESSION,
      });

      expect(extraction.observations).toHaveLength(2);
      expect(extraction.truncated).toBe(false);
    });
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

describe('Codex per-session ceiling', () => {
  afterEach(() => {
    setCodexSkillObservationCeilingForTesting(null);
  });

  const rollout = (events: readonly unknown[]) => {
    const parser = createCodexSessionParser(false);
    for (const event of events) {
      parser.visit(JSON.stringify(event));
    }
    return parser.finish().session;
  };

  const sessionMeta = {
    payload: { cwd: SKILL_FIXTURE_PROJECT, id: 'codex-ceiling', originator: 'codex_cli_rs' },
    timestamp: '2026-08-01T09:00:00.000Z',
    type: 'session_meta',
  };

  test('ignores an unknown non-exec tool whose argument merely names a skill', () => {
    // A denylist let any unheard-of tool through; the corpus carries `wait`,
    // `list_agents`, `followup_task` and more, none of which run a command.
    const session = rollout([
      sessionMeta,
      ...['followup_task', 'list_agents', 'wait', 'interrupt_agent'].map((name, index) => ({
        payload: {
          arguments: JSON.stringify({ cmd: `cat ${SKILL_FIXTURE_HOME}/.agents/skills/decoy/SKILL.md` }),
          call_id: `call_${name}`,
          name,
          type: 'function_call',
        },
        timestamp: `2026-08-01T09:00:0${index + 2}.000Z`,
        type: 'response_item',
      })),
    ]);

    expect(session.skillObservations).toEqual([]);
    expect(session.skillObservationsTruncated).toBe(false);
  });

  test('stops one past the ceiling when a single command names many documents', () => {
    setCodexSkillObservationCeilingForTesting(2);
    const documents = Array.from(
      { length: 8 },
      (_, index) => `${SKILL_FIXTURE_HOME}/.agents/skills/skill-${index}/SKILL.md`,
    ).join(' ');

    // A per-segment ceiling check leaves the token loop unbounded, so one `cat`
    // returns every document it names.
    const entries = matchCodexSkillDocuments(JSON.stringify({ cmd: `cat ${documents}` }));

    expect(entries.length).toBeLessThanOrEqual(3);
  });

  test('does not flag truncation when the dropped calls carry no skill signal', () => {
    setCodexSkillObservationCeilingForTesting(1);
    const execCall = (index: number, cmd: string) => ({
      payload: { call_id: `call_${index}`, input: JSON.stringify({ cmd }), name: 'exec', type: 'custom_tool_call' },
      timestamp: '2026-08-01T09:00:02.000Z',
      type: 'response_item',
    });

    const session = rollout([
      sessionMeta,
      execCall(0, `cat ${SKILL_FIXTURE_HOME}/.agents/skills/only/SKILL.md`),
      // Past the ceiling, but carrying nothing. Nothing was lost, so the count
      // is complete and must not claim otherwise.
      execCall(1, 'echo nothing'),
      execCall(2, 'ls /tmp'),
    ]);

    expect(session.skillObservations).toHaveLength(1);
    expect(session.skillObservationsTruncated).toBe(false);
  });

  test('flags a catalogue that overruns the ceiling', () => {
    setCodexSkillObservationCeilingForTesting(3);
    const entries = Array.from(
      { length: 6 },
      (_, index) =>
        `- skill-${index}: Description. (file: ${SKILL_FIXTURE_HOME}/.agents/skills/skill-${index}/SKILL.md)`,
    );
    const catalogue = ['### Available skills', ...entries].join('\n');

    const session = rollout([
      sessionMeta,
      {
        // Key order matches production: type/id/role precede the large content,
        // which is what keeps "role":"developer" inside the 300-byte prefix the
        // collector gates on.
        payload: {
          type: 'message',
          id: 'msg_dev',
          role: 'developer',
          content: [{ type: 'input_text', text: catalogue }],
        },
        timestamp: '2026-08-01T09:00:01.000Z',
        type: 'response_item',
      },
    ]);

    // Stopping exactly at the ceiling returns a full-looking list that no
    // caller can tell from a complete one.
    expect(session.skillObservations).toHaveLength(3);
    expect(session.skillObservationsTruncated).toBe(true);
  });

  test('flags exec signals dropped at the bound, which vanish before materialization', () => {
    setCodexSkillObservationCeilingForTesting(2);
    const execCall = (index: number) => ({
      payload: {
        call_id: `call_${index}`,
        input: JSON.stringify({ cmd: `cat ${SKILL_FIXTURE_HOME}/.agents/skills/skill-${index}/SKILL.md` }),
        name: 'exec',
        type: 'custom_tool_call',
      },
      timestamp: '2026-08-01T09:00:02.000Z',
      type: 'response_item',
    });

    const session = rollout([sessionMeta, ...Array.from({ length: 5 }, (_, index) => execCall(index))]);

    expect(session.skillObservations).toHaveLength(2);
    expect(session.skillObservationsTruncated).toBe(true);
  });

  test('does not flag a session inside the ceiling', () => {
    setCodexSkillObservationCeilingForTesting(5);
    const session = rollout([
      sessionMeta,
      {
        payload: {
          call_id: 'call_one',
          input: JSON.stringify({ cmd: `cat ${SKILL_FIXTURE_HOME}/.agents/skills/only/SKILL.md` }),
          name: 'exec',
          type: 'custom_tool_call',
        },
        timestamp: '2026-08-01T09:00:02.000Z',
        type: 'response_item',
      },
    ]);

    expect(session.skillObservations).toHaveLength(1);
    expect(session.skillObservationsTruncated).toBe(false);
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

  test('yields nothing for an exec call whose argument carries no command', () => {
    // A call marker is present, so only its own argument may be read — and it
    // names no command. There is deliberately no whole-blob fallback.
    expect(decodeCodexCommands('exec_command({workdir:"/tmp"})')).toEqual([]);
    expect(decodeCodexCommands(undefined)).toEqual([]);
  });

  test('yields nothing for a blob carrying no well-formed exec call', () => {
    // Measured over the real corpus, every SKILL.md-bearing exec payload is
    // either a JSON object or a snippet with a marker, and nothing came from a
    // fallback — so refusing to guess closes prose, patch bodies and quoted
    // commands as a class rather than case by case.
    expect(decodeCodexCommand('*** Begin Patch')).toBeNull();
    expect(extractCodexSkillExecObservation('*** Begin Patch', 'call_patch', codexContext).observations).toEqual([]);
  });

  test('does not read natural-language prose as a command', () => {
    const prose = `cat the file ${SKILL_FIXTURE_HOME}/.agents/skills/decoy/SKILL.md please`;

    expect(decodeCodexCommands(prose)).toEqual([]);
    expect(extractCodexSkillExecObservation(prose, 'call_prose', codexContext).observations).toEqual([]);
  });

  test('ignores an exec_command marker that sits inside a string literal', () => {
    const snippet = `const log = "exec_command({cmd:\\"cat ${SKILL_FIXTURE_HOME}/.agents/skills/decoy/SKILL.md\\"})";`;

    // A command that merely mentions the marker is not a call.
    expect(decodeCodexCommands(snippet)).toEqual([]);
    expect(extractCodexSkillExecObservation(snippet, 'call_quoted', codexContext).observations).toEqual([]);
  });

  test('yields nothing for an unbalanced call rather than widening to end of blob', () => {
    const snippet = `await tools.exec_command({cmd:"echo hi"; const note={cmd:"cat ${SKILL_FIXTURE_HOME}/.agents/skills/decoy/SKILL.md"}`;

    // Returning end-of-blob here would re-open the whole-blob window the
    // balanced bound exists to close.
    expect(extractCodexSkillExecObservation(snippet, 'call_unbalanced', codexContext).observations).toEqual([]);
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

  test('does not count an in-place sed edit as a read', () => {
    for (const cmd of [
      `sed -i s/a/b/ ${SKILL_FIXTURE_HOME}/.agents/skills/review/SKILL.md`,
      `sed -i.bak s/a/b/ ${SKILL_FIXTURE_HOME}/.agents/skills/review/SKILL.md`,
      `sed -ni s/a/b/ ${SKILL_FIXTURE_HOME}/.agents/skills/review/SKILL.md`,
      `sed --in-place s/a/b/ ${SKILL_FIXTURE_HOME}/.agents/skills/review/SKILL.md`,
    ]) {
      // In-place mode rewrites the document and shows the model nothing.
      expect(
        extractCodexSkillExecObservation(JSON.stringify({ cmd }), 'call_in_place', codexContext).observations,
      ).toEqual([]);
    }
  });

  test('does not let a valued flag shift the pattern operand into file position', () => {
    for (const cmd of [
      `rg --glob "*.md" ${SKILL_FIXTURE_HOME}/.agents/skills/review/SKILL.md transcript.txt`,
      `rg -g "*.md" ${SKILL_FIXTURE_HOME}/.agents/skills/review/SKILL.md transcript.txt`,
      `grep -m 1 ${SKILL_FIXTURE_HOME}/.agents/skills/review/SKILL.md transcript.txt`,
      `grep -A 3 ${SKILL_FIXTURE_HOME}/.agents/skills/review/SKILL.md transcript.txt`,
    ]) {
      // The flag consumes the next token, so the skill path is still the
      // pattern being searched for, not a file being read.
      expect(
        extractCodexSkillExecObservation(JSON.stringify({ cmd }), 'call_valued_flag', codexContext).observations,
      ).toEqual([]);
    }
  });

  test('treats an attached flag value as self-contained', () => {
    // `--glob=*.md` consumes no following token, so the skill path is the
    // pattern operand here too.
    expect(
      extractCodexSkillExecObservation(
        JSON.stringify({ cmd: `rg --glob=*.md ${SKILL_FIXTURE_HOME}/.agents/skills/review/SKILL.md transcript.txt` }),
        'call_attached',
        codexContext,
      ).observations,
    ).toEqual([]);
    // …and the file operand after an attached value is still a read.
    expect(
      extractCodexSkillExecObservation(
        JSON.stringify({ cmd: `rg --glob=*.md needle ${SKILL_FIXTURE_HOME}/.agents/skills/review/SKILL.md` }),
        'call_attached_read',
        codexContext,
      ).observations.map(({ skillName }) => skillName),
    ).toEqual(['review']);
  });

  test('counts the first operand as a file when a flag already supplied the pattern', () => {
    for (const cmd of [
      `grep -e needle ${SKILL_FIXTURE_HOME}/.agents/skills/review/SKILL.md`,
      `rg --regexp needle ${SKILL_FIXTURE_HOME}/.agents/skills/review/SKILL.md`,
      `sed -e 1,80p ${SKILL_FIXTURE_HOME}/.agents/skills/review/SKILL.md`,
    ]) {
      expect(
        extractCodexSkillExecObservation(JSON.stringify({ cmd }), 'call_pattern_flag', codexContext).observations.map(
          ({ skillName }) => skillName,
        ),
      ).toEqual(['review']);
    }
  });

  test('counts a glued pattern value, so the first operand stays a file', () => {
    for (const cmd of [
      `grep -eneedle ${SKILL_FIXTURE_HOME}/.agents/skills/review/SKILL.md`,
      `rg -eneedle ${SKILL_FIXTURE_HOME}/.agents/skills/review/SKILL.md`,
      `sed -e1,80p ${SKILL_FIXTURE_HOME}/.agents/skills/review/SKILL.md`,
    ]) {
      // The pattern is glued to the flag, so the skill path really is the file.
      expect(
        extractCodexSkillExecObservation(JSON.stringify({ cmd }), 'call_glued', codexContext).observations.map(
          ({ skillName }) => skillName,
        ),
      ).toEqual(['review']);
    }
  });

  test('lets a valued flag at the end of a short cluster consume the next token', () => {
    for (const cmd of [
      `grep -nm 1 ${SKILL_FIXTURE_HOME}/.agents/skills/review/SKILL.md transcript.txt`,
      `rg -im 1 ${SKILL_FIXTURE_HOME}/.agents/skills/review/SKILL.md transcript.txt`,
    ]) {
      // `-nm 1` is `-n -m 1`: the cluster's last letter takes the value, so the
      // skill path is still the pattern operand.
      expect(
        extractCodexSkillExecObservation(JSON.stringify({ cmd }), 'call_cluster', codexContext).observations,
      ).toEqual([]);
    }
  });

  test('assumes an unknown long flag on a scripted verb consumes its value', () => {
    for (const cmd of [
      `grep --label label ${SKILL_FIXTURE_HOME}/.agents/skills/review/SKILL.md transcript.txt`,
      `rg --sort path ${SKILL_FIXTURE_HOME}/.agents/skills/review/SKILL.md transcript.txt`,
    ]) {
      // Arity is unknowable, so the rule errs toward removing a candidate
      // rather than inventing a read.
      expect(
        extractCodexSkillExecObservation(JSON.stringify({ cmd }), 'call_unknown_long', codexContext).observations,
      ).toEqual([]);
    }
  });

  test('keeps the plain readers free of the unknown-long-flag rule', () => {
    // `cat --show-all file` must still read the file; the assumption is scoped
    // to scripted verbs, whose operand positions actually shift.
    expect(
      extractCodexSkillExecObservation(
        JSON.stringify({ cmd: `cat --show-all ${SKILL_FIXTURE_HOME}/.agents/skills/review/SKILL.md` }),
        'call_plain_long',
        codexContext,
      ).observations.map(({ skillName }) => skillName),
    ).toEqual(['review']);
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

  test('does not attribute a cmd key that lives after the call it follows', () => {
    // The call's own argument names no command; the `cmd` belongs to a later
    // variable. A window that ran to end-of-blob swallowed it.
    const snippet = `exec_command({workdir:"/tmp"}); const note={cmd:"cat ${SKILL_FIXTURE_HOME}/.agents/skills/decoy/SKILL.md"}`;

    expect(decodeCodexCommands(snippet)).toEqual([]);
    expect(extractCodexSkillExecObservation(snippet, 'call_decoy', codexContext).observations).toEqual([]);
  });

  test('does not fall back to a whole-blob scan when a call yields no command', () => {
    const snippet = [
      `const a = await tools.exec_command({cmd:"cat ${SKILL_FIXTURE_HOME}/.agents/skills/real/SKILL.md"});`,
      `exec_command({workdir:"/tmp"});`,
      `const leftover = {cmd:"cat ${SKILL_FIXTURE_HOME}/.agents/skills/decoy/SKILL.md"};`,
    ].join('\n');

    expect(
      extractCodexSkillExecObservation(snippet, 'call_no_fallback', codexContext).observations.map((o) => o.skillName),
    ).toEqual(['real']);
  });

  test('does not attribute a cmd key that belongs to no exec call', () => {
    const snippet = `const note = {cmd:"cat ${SKILL_FIXTURE_HOME}/.agents/skills/decoy/SKILL.md"};\nconst r = await tools.exec_command({cmd:"cat ${SKILL_FIXTURE_HOME}/.agents/skills/real/SKILL.md"});`;

    expect(
      extractCodexSkillExecObservation(snippet, 'call_scoped', codexContext).observations.map((o) => o.skillName),
    ).toEqual(['real']);
  });

  test('does not retain a commented-out cmd key', () => {
    const decoy = `${SKILL_FIXTURE_HOME}/.agents/skills/decoy/SKILL.md`;
    const snippet = `tools.exec_command({/* cmd:"cat ${decoy}", */ cmd:"echo hi"})`;

    // The key scan finds the first `cmd`; a commented one sitting ahead of the
    // real one would win.
    expect(decodeCodexCommands(snippet)).toEqual(['echo hi']);
    expect(extractCodexSkillExecObservation(snippet, 'call_comment', codexContext).observations).toEqual([]);
  });

  test('does not retain a cmd key hidden in a line comment', () => {
    const decoy = `${SKILL_FIXTURE_HOME}/.agents/skills/decoy/SKILL.md`;
    const snippet = `tools.exec_command({\n  // cmd:"cat ${decoy}"\n  cmd:"echo hi"\n})`;

    expect(decodeCodexCommands(snippet)).toEqual(['echo hi']);
    expect(extractCodexSkillExecObservation(snippet, 'call_line_comment', codexContext).observations).toEqual([]);
  });

  test('rejects a call whose delimiters are mismatched rather than merely balanced', () => {
    const snippet = `tools.exec_command({cmd:"cat ${SKILL_FIXTURE_HOME}/.agents/skills/decoy/SKILL.md"]`;

    // A depth counter accepts this: one opener, one closer. Types must match.
    expect(decodeCodexCommands(snippet)).toEqual([]);
    expect(extractCodexSkillExecObservation(snippet, 'call_mismatch', codexContext).observations).toEqual([]);
  });

  test('ends the command at an unquoted shell comment', () => {
    const cmd = `cat /etc/hostname # cat ${SKILL_FIXTURE_HOME}/.agents/skills/decoy/SKILL.md`;

    expect(extractCodexSkillExecObservation(JSON.stringify({ cmd }), 'call_hash', codexContext).observations).toEqual(
      [],
    );
  });

  test('does not split a command on a separator inside a quoted string', () => {
    const cmd = `printf 'x;cat ' ${SKILL_FIXTURE_HOME}/.agents/skills/decoy/SKILL.md`;

    // Splitting on `;` before tokenizing invents a segment whose verb came out
    // of a quoted string; the real verb here is `printf`, which reads nothing.
    expect(
      extractCodexSkillExecObservation(JSON.stringify({ cmd }), 'call_quoted_sep', codexContext).observations,
    ).toEqual([]);
  });

  test('treats every target-taking redirect form as a write', () => {
    const decoy = `${SKILL_FIXTURE_HOME}/.agents/skills/decoy/SKILL.md`;
    for (const cmd of [
      `cat README.md &> ${decoy}`,
      `cat README.md &>> ${decoy}`,
      `cat README.md >& ${decoy}`,
      `cat README.md >| ${decoy}`,
      `cat README.md <> ${decoy}`,
    ]) {
      expect(
        extractCodexSkillExecObservation(JSON.stringify({ cmd }), 'call_redirect_forms', codexContext).observations,
      ).toEqual([]);
    }
  });

  test('abandons a segment that uses an unmodeled flag', () => {
    const decoy = `${SKILL_FIXTURE_HOME}/.agents/skills/decoy/SKILL.md`;
    for (const cmd of [
      // `-j` takes a value on rg but is not modelled: its arity is unknowable,
      // so every operand position after it is too.
      `rg -j 4 ${decoy} transcript.txt`,
      // A plain reader is no safer: the flag's value is the decoy path itself.
      `nl --number-separator ${decoy} /etc/hostname`,
      `cat --unheard-of ${decoy}`,
    ]) {
      expect(
        extractCodexSkillExecObservation(JSON.stringify({ cmd }), 'call_unknown_flag', codexContext).observations,
      ).toEqual([]);
    }
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
