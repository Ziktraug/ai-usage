import { describe, expect, test } from 'bun:test';
import { parseClaudeSessionFacts } from './claude-session-facts';

const THREAD = '11111111-2222-4333-8444-555555555555';
const OTHER_THREAD = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const at = (second: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
const call = (command: string, id = 'launch', second = 1, name = 'Bash') => ({
  type: 'assistant',
  timestamp: at(second),
  uuid: `assistant-${id}-${second}`,
  parentUuid: 'prompt',
  message: {
    id: `message-${id}`,
    model: 'claude-sonnet-4-6',
    usage: { input_tokens: 1, output_tokens: 1 },
    content: [{ type: 'tool_use', id, name, input: { command } }],
  },
});
const result = (content: unknown, toolUseId = 'launch', second = 2, isError = false) => ({
  type: 'user',
  timestamp: at(second),
  uuid: `result-${toolUseId}-${second}`,
  message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }] },
});
const parse = (...records: unknown[]) => {
  const facts = parseClaudeSessionFacts({
    records: [{ type: 'user', timestamp: at(0), uuid: 'prompt', message: { content: 'Synthetic task' } }, ...records],
    repository: null,
    sourceSessionId: 'claude-parent',
  });
  if (!facts) {
    throw new Error('Expected synthetic Claude facts');
  }
  return facts;
};

describe('Claude Bash attestation of Codex launches', () => {
  test.each([
    'exit 0',
    'exec true',
    'eval "exit 0"',
    'source /tmp/synthetic-control.sh',
    '. /tmp/synthetic-control.sh',
    'builtin exit 0',
    'command exit 0',
    '> /tmp/synthetic.log exit 0',
    'MODE=fixture > /tmp/synthetic.log exec true',
    '! exit 0',
    'time exit 0',
    'set -n',
    'synthetic-unknown-command',
    'fc -s',
    'enable -f /tmp/synthetic-builtin.so synthetic',
    'if true; then exit 0; fi',
    'exit "$SYNTHETIC_STATUS"',
    '$SYNTHETIC_COMMAND',
  ])('does not infer that the final chain ran after shell control: %s', (prefix) => {
    expect(
      parse(call(`${prefix}; codex exec resume ${THREAD}`), result('Synthetic shell exited successfully'))
        .codexLaunches,
    ).toEqual([]);
  });

  test.each([
    `cd /removed && codex exec resume ${THREAD} > log 2>&1; echo "exit=$?" >> err`,
    `false && codex exec resume ${THREAD}; echo done`,
  ])(
    'prefers correctness over supervisor coverage when a later semicolon chain masks the launch status: %s',
    (command) => {
      expect(parse(call(command), result('Synthetic final command succeeded')).codexLaunches).toEqual([]);
    },
  );

  test.each([`{"type":"thread.started","thread_id":"${THREAD}"}`, `session id: ${THREAD}`])(
    'attests a timed-out resume when its own native identity survived: %s',
    (nativeEvidence) => {
      expect(
        parse(
          call(`timeout 600 codex exec resume ${THREAD} --json -`),
          result(`${nativeEvidence}\nSynthetic timeout: exit 124`, 'launch', 2, true),
        ).codexLaunches,
      ).toEqual([{ at: at(1), evidence: 'resume-argument', sourceSessionId: THREAD }]);
    },
  );

  test.each(['User rejected tool use', 'hook error: synthetic PreToolUse blocked execution'])(
    'does not attest a rejected resume: %s',
    (message) => {
      expect(parse(call(`codex exec resume ${THREAD}`), result(message, 'launch', 2, true)).codexLaunches).toEqual([]);
    },
  );

  test('does not attest an interrupted resume with no result or an unrelated successful result', () => {
    expect(parse(call(`codex exec resume ${THREAD}`)).codexLaunches).toEqual([]);
    expect(parse(call(`codex exec resume ${THREAD}`), result('Synthetic success', 'other')).codexLaunches).toEqual([]);
  });

  test.each([
    `cd /tmp/synthetic-work && codex exec resume ${THREAD} -m gpt-6-astra -c sandbox_mode='"workspace-write"' -c model_reasoning_effort='"high"' --json -o out.md "Synthetic prompt" > log.jsonl 2> log.err; echo "exit=$?" >> log.err`,
    `timeout 600 codex exec resume ${THREAD} -m gpt-6-astra --json - < prompt.md`,
    `codex exec resume ${THREAD} 'Synthetic prompt' >> '/tmp/synthetic output.log' 2>&1`,
    `codex exec resume ${THREAD} 'Synthetic prompt' > out.log 2>&1; echo "exit=$?" >> err.log`,
    `codex exec resume ${THREAD} 'Synthetic prompt' 2>&1 > out.log `,
    `MODE=fixture timeout 600 codex exec --config 'model="example"' resume ${THREAD} --model gpt-6-astra --sandbox workspace-write --cd '/tmp/synthetic work' --profile synthetic --image synthetic.png --json - < 'prompt file.md' >'output file.jsonl' 2>'errors file.log'`,
    `echo 'Synthetic setup'; codex exec resume ${THREAD} -s workspace-write -C /tmp/synthetic-work -p synthetic --skip-git-repo-check --ephemeral -i synthetic.png -o out.md - < prompt.md`,
  ])('attests a supervisor launch form with matching native evidence: %s', (command) => {
    expect(parse(call(command), result(`session id: ${THREAD}`)).codexLaunches).toEqual([
      { at: at(1), evidence: 'resume-argument', sourceSessionId: THREAD },
    ]);
  });

  test('requires matching native evidence for the masked status-echo form despite reduced supervisor coverage', () => {
    const command = `cd /tmp/synthetic-work && codex exec resume ${THREAD} > log 2>&1; echo "exit=$?" >> err`;
    expect(parse(call(command), result(`{"type":"thread.started","thread_id":"${THREAD}"}`)).codexLaunches).toEqual([
      { at: at(1), evidence: 'resume-argument', sourceSessionId: THREAD },
    ]);
    expect(parse(call(command), result(`session id: ${OTHER_THREAD}`)).codexLaunches).toEqual([]);
  });

  test.each([
    `false && codex exec resume ${THREAD}; echo 'session id: ${THREAD}'`,
    `cd /removed && codex exec resume ${THREAD}; cat /tmp/old.log`,
    `codex exec resume ${THREAD}; echo 'session id: ${THREAD}'`,
    `codex exec resume ${THREAD}; cat /tmp/old.log`,
  ])('never uses arbitrary mixed output as native corroboration for a masked resume: %s', (command) => {
    expect(parse(call(command), result(`session id: ${THREAD}`)).codexLaunches).toEqual([]);
    expect(parse(call(command), result(`session id: ${THREAD}`, 'launch', 2, true)).codexLaunches).toEqual([]);
  });

  test('keeps exit status scoped to the last semicolon chain and native evidence scoped to its exact id', () => {
    const command = `codex exec resume ${THREAD}; codex exec resume ${OTHER_THREAD}`;
    expect(parse(call(command), result('Synthetic successful exit')).codexLaunches).toEqual([
      { at: at(1), evidence: 'resume-argument', sourceSessionId: OTHER_THREAD },
    ]);
    expect(parse(call(command), result(`session id: ${THREAD}`)).codexLaunches).toEqual([
      { at: at(1), evidence: 'resume-argument', sourceSessionId: THREAD },
      { at: at(1), evidence: 'resume-argument', sourceSessionId: OTHER_THREAD },
    ]);
    expect(parse(call(command), result(`session id: ${THREAD}`, 'launch', 2, true)).codexLaunches).toEqual([
      { at: at(1), evidence: 'resume-argument', sourceSessionId: THREAD },
    ]);
  });

  test('does not confuse a trailing or quoted semicolon with a later command chain', () => {
    for (const command of [
      `codex exec resume ${THREAD};`,
      `codex exec resume ${THREAD} 'Synthetic ; prompt'`,
      `echo 'Synthetic setup'; codex exec resume ${THREAD} && echo 'Synthetic finish'`,
    ]) {
      expect(parse(call(command), result('Synthetic successful exit')).codexLaunches).toEqual([
        { at: at(1), evidence: 'resume-argument', sourceSessionId: THREAD },
      ]);
    }
  });

  test('matches native resume identities case-insensitively and deduplicates result blocks', () => {
    const facts = parse(
      call(`timeout 600 codex exec resume ${OTHER_THREAD.toUpperCase()} --json -`),
      result(`{"type":"thread.started","thread_id":"${OTHER_THREAD}"}`, 'launch', 2, true),
      result(`session id: ${OTHER_THREAD}`, 'launch', 3, true),
    );
    expect(facts.codexLaunches).toEqual([{ at: at(1), evidence: 'resume-argument', sourceSessionId: OTHER_THREAD }]);
  });

  test('rejects mismatched native evidence on error and ignores later conflicting identities', () => {
    const command = `timeout 600 codex exec resume ${THREAD} --json -`;
    expect(parse(call(command), result(`session id: ${OTHER_THREAD}`, 'launch', 2, true)).codexLaunches).toEqual([]);
    expect(
      parse(
        call(command),
        result(`session id: ${OTHER_THREAD}\nsession id: ${THREAD}`, 'launch', 2, true),
        result(`session id: ${THREAD}`, 'launch', 3, true),
      ).codexLaunches,
    ).toEqual([]);
  });

  test('accepts a correlated successful result without an is_error field', () => {
    const successfulResult = {
      type: 'user',
      timestamp: at(2),
      message: { content: [{ type: 'tool_result', tool_use_id: 'launch', content: 'Synthetic successful exit' }] },
    };
    expect(parse(call(`codex exec resume ${THREAD}`), successfulResult).codexLaunches).toEqual([
      { at: at(1), evidence: 'resume-argument', sourceSessionId: THREAD },
    ]);
  });

  test('keeps result-id evidence for an execution that later fails', () => {
    expect(
      parse(
        call('timeout 600 codex exec --json - < prompt.md'),
        result(`{"type":"thread.started","thread_id":"${THREAD}"}`, 'launch', 2, true),
      ).codexLaunches,
    ).toEqual([{ at: at(2), evidence: 'thread-started', sourceSessionId: THREAD }]);
  });

  test.each([
    `codex exec resume ${THREAD}`,
    `codex exec -c 'model="example"' resume '${THREAD}' 'Synthetic prompt'`,
    `codex exec --config 'model="example"' --json resume "${THREAD}"`,
    `codex exec --config='model="example"' resume --json ${THREAD}`,
    `MODE=fixture codex exec resume ${THREAD}`,
    `MODE="synthetic fixture" codex exec resume ${THREAD}`,
    `env MODE=fixture codex exec resume ${THREAD}`,
    `env -i MODE=fixture /opt/bin/codex exec resume ${THREAD}`,
    `cd '/tmp/synthetic fixture' && codex exec -c 'model="example"' resume ${THREAD}`,
    `echo 'Synthetic start' && codex exec resume ${THREAD} && echo 'Synthetic finish'`,
    `"codex" 'exec' resume '${THREAD}'`,
    `codex exec resume -- ${THREAD}`,
  ])('attests the literal resume argument: %s', (command) => {
    const facts = parse(call(command), result('Synthetic successful exit'));
    expect(facts.codexLaunches).toEqual([{ at: at(1), evidence: 'resume-argument', sourceSessionId: THREAD }]);
    expect(facts.codexLaunchesTruncated).toBe(false);
    expect(facts.source.delegatedSessions).toEqual([{ harness: 'codex', sourceSessionId: THREAD }]);
    expect(facts.detailFacts.children).toEqual([]);
    expect(facts.detailFacts.interactions).toEqual([]);
  });

  test.each([
    { content: `Synthetic output\n{"type":"thread.started","thread_id":"${THREAD}"}\n`, evidence: 'thread-started' },
    { content: `Synthetic banner\nsession id: ${THREAD}\n`, evidence: 'session-id-header' },
    {
      content: [{ type: 'text', text: `{"type":"thread.started","thread_id":"${THREAD}"}` }],
      evidence: 'thread-started',
    },
  ])('attests correlated result evidence: $evidence', ({ content, evidence }) => {
    const facts = parse(call('codex exec --json "Synthetic task"'), result(content));
    expect(facts.codexLaunches).toEqual([{ at: at(2), evidence, sourceSessionId: THREAD }]);
  });

  test.each([
    'codex --help',
    'codex login status',
    'codex exec --help',
    'codex exec --version',
    `codex exec resume ${THREAD} --help`,
    'codex exec "Synthetic prompt" --help',
    `"MODE=fixture" codex exec resume ${THREAD}`,
    `'MODE=fixture' codex exec resume ${THREAD}`,
    `MO"DE"=fixture codex exec resume ${THREAD}`,
    `codex exec resume ${THREAD} --config`,
    `codex\u00a0exec resume ${THREAD}`,
    `codex\u2003exec resume ${THREAD}`,
    `echo codex exec resume ${THREAD}`,
    `printf 'codex exec resume ${THREAD}'`,
    `grep 'codex exec resume ${THREAD}' /tmp/synthetic.log`,
    `not-codex exec resume ${THREAD}`,
    `bash -c 'codex exec resume ${THREAD}'`,
    `codex exec -c 'resume ${THREAD}' --help`,
    `codex exec --unknown-option resume ${THREAD}`,
    `codex exec resume '${THREAD}`,
    'codex exec resume $THREAD',
    `echo "$(codex exec resume ${THREAD})"`,
    `# codex exec resume ${THREAD}`,
    `cat prompt.md | codex exec resume ${THREAD}`,
    `codex exec resume ${THREAD} | cat`,
    `echo $(false; codex exec resume ${THREAD})`,
    `echo \`false; codex exec resume ${THREAD}\``,
    `echo text # comment; codex exec resume ${THREAD}`,
    `echo "Synthetic text; codex exec resume ${THREAD}"`,
    `codex exec resume ${THREAD} >`,
    `codex exec resume ${THREAD} > out.log --unknown-option`,
    `codex exec resume ${THREAD} --unknown-option > out.log`,
    `codex exec resume ${THREAD} << prompt.md`,
    `codex exec resume ${THREAD} > $(echo out.log)`,
    `codex exec resume ${THREAD} 2>&1suffix`,
    `timeout --signal=KILL 600 codex exec resume ${THREAD}`,
    `timeout not-a-number codex exec resume ${THREAD}`,
  ])('rejects commands that do not establish a literal launch: %s', (command) => {
    const facts = parse(call(command), result(`session id: ${THREAD}`));
    expect(facts.codexLaunches).toEqual([]);
    expect(facts.source).not.toHaveProperty('delegatedSessions');
  });

  test.each([
    `codex exec 'resume ${THREAD}'`,
    `codex exec -- resume ${THREAD}`,
    `codex exec 'Synthetic prompt' resume ${THREAD}`,
    `codex exec -c 'resume=${THREAD}' 'Synthetic prompt'`,
    'codex exec resume not-a-uuid',
  ])('does not mistake a prompt or option value for a resume id: %s', (command) => {
    expect(parse(call(command), result('Synthetic successful exit')).codexLaunches).toEqual([]);
  });

  test.each([
    `codex exec resume > ${THREAD}`,
    `codex exec > resume < ${THREAD}`,
    `echo Synthetic > codex; echo exec resume ${THREAD}`,
    `codex exec 'resume ${THREAD}; Synthetic text' > out.log`,
  ])('never reads redirect filenames or quoted text as resume arguments: %s', (command) => {
    expect(parse(call(command), result('Synthetic successful exit')).codexLaunches).toEqual([]);
  });

  test('keeps a quoted redirect operator as the literal prompt', () => {
    expect(
      parse(call(`codex exec resume ${THREAD} '>' > out.log`), result('Synthetic successful exit')).codexLaunches,
    ).toEqual([{ at: at(1), evidence: 'resume-argument', sourceSessionId: THREAD }]);
  });

  test('ignores an id from a later unrelated log-read result or a pasted note', () => {
    const facts = parse(
      call('codex exec --json "Synthetic task"'),
      result('Synthetic failure', 'launch', 2, true),
      call('cat /tmp/synthetic.log', 'read-log', 3),
      result(`{"type":"thread.started","thread_id":"${THREAD}"}`, 'read-log', 4),
      { type: 'user', timestamp: at(5), message: { content: `session id: ${THREAD}` } },
    );
    expect(facts.codexLaunches).toEqual([]);
  });

  test.each([
    'cat /tmp/synthetic.log && codex exec "Synthetic task"',
    'codex exec "Synthetic task" && cat /tmp/synthetic.log',
    'echo "Synthetic log" && codex exec "Synthetic task"',
    'cat /tmp/synthetic.log; codex exec "Synthetic task"',
    'codex exec "Synthetic task"; cat /tmp/synthetic.log',
    'codex exec "Synthetic task"; echo "exit=$?" >> log.err',
  ])('does not attribute mixed command output to the launching process: %s', (command) => {
    expect(parse(call(command), result(`session id: ${THREAD}`)).codexLaunches).toEqual([]);
  });

  test('retains literal resume evidence in a mixed-output chain without taking result ids', () => {
    const facts = parse(
      call(`cat /tmp/synthetic.log && codex exec resume ${THREAD}`),
      result(`session id: ${OTHER_THREAD}`),
    );
    expect(facts.codexLaunches).toEqual([{ at: at(1), evidence: 'resume-argument', sourceSessionId: THREAD }]);
  });

  test('takes only the first native result identity across output and streamed results', () => {
    const facts = parse(
      call('codex exec "Synthetic task"'),
      result(`session id: ${THREAD}\nSynthetic assistant output\nsession id: ${OTHER_THREAD}`),
      result(`{"type":"thread.started","thread_id":"${OTHER_THREAD}"}`, 'launch', 3),
    );
    expect(facts.codexLaunches).toEqual([{ at: at(2), evidence: 'session-id-header', sourceSessionId: THREAD }]);
  });

  test('keeps explicit resume identity when later output names another thread', () => {
    expect(parse(call(`codex exec resume ${THREAD}`), result(`session id: ${OTHER_THREAD}`)).codexLaunches).toEqual([
      { at: at(1), evidence: 'resume-argument', sourceSessionId: THREAD },
    ]);
  });

  test('requires one execution to attribute output but retains explicit ids from multiple launches', () => {
    expect(
      parse(call('codex exec "Synthetic task" && codex exec "Another synthetic task"'), result(`session id: ${THREAD}`))
        .codexLaunches,
    ).toEqual([]);
    expect(
      parse(call(`codex exec resume ${THREAD} && codex exec resume ${OTHER_THREAD}`), result(`session id: ${THREAD}`))
        .codexLaunches,
    ).toEqual([
      { at: at(1), evidence: 'resume-argument', sourceSessionId: THREAD },
      { at: at(1), evidence: 'resume-argument', sourceSessionId: OTHER_THREAD },
    ]);
  });

  test('accepts result evidence after a quiet directory setup', () => {
    expect(
      parse(call('cd "/tmp/synthetic fixture" && codex exec --json "Synthetic task"'), result(`session id: ${THREAD}`))
        .codexLaunches,
    ).toEqual([{ at: at(2), evidence: 'session-id-header', sourceSessionId: THREAD }]);
  });

  test('ignores non-Bash tools and unmatched or pre-launch results', () => {
    expect(
      parse(call(`codex exec resume ${THREAD}`, 'launch', 1, 'Read'), result(`session id: ${THREAD}`)).codexLaunches,
    ).toEqual([]);
    expect(
      parse(call('codex exec --json "Synthetic task"'), result(`session id: ${THREAD}`, 'other')).codexLaunches,
    ).toEqual([]);
    expect(
      parse(result(`session id: ${THREAD}`, 'launch', 1), call('codex exec --json "Synthetic task"', 'launch', 2))
        .codexLaunches,
    ).toEqual([]);
  });

  test('requires a complete correctly typed result id, including for failed results', () => {
    for (const content of [
      'Synthetic failure',
      '{"type":"thread.started","thread_id":42}',
      '{"type":"thread.started","thread_id":"not-a-uuid"}',
      `Synthetic note session id: ${THREAD}`,
      '{incomplete',
    ]) {
      expect(
        parse(call('codex exec --json "Synthetic task"'), result(content, 'launch', 2, true)).codexLaunches,
      ).toEqual([]);
    }
  });

  test('deduplicates streamed tool uses, repeated results and resumed session identities', () => {
    const facts = parse(
      call(`codex exec resume ${THREAD}`),
      call(`codex exec resume ${OTHER_THREAD}`, 'launch', 2),
      result(`session id: ${THREAD}`, 'launch', 3),
      result(`session id: ${THREAD}`, 'launch', 4),
      call(`codex exec resume ${THREAD}`, 'resume-again', 5),
    );
    expect(facts.codexLaunches).toEqual([{ at: at(1), evidence: 'resume-argument', sourceSessionId: THREAD }]);
  });

  test('orders mixed argument/result evidence by time and keeps the earliest evidence', () => {
    const facts = parse(
      call(`codex exec resume ${THREAD}`, 'resume', 5),
      call('codex exec --json "Synthetic task"', 'new', 1),
      result(`{"type":"thread.started","thread_id":"${OTHER_THREAD}"}`, 'new', 2),
      call(`codex exec resume ${OTHER_THREAD}`, 'resume-other', 4),
      result('Synthetic successful exit', 'resume-other', 5),
      result('Synthetic successful exit', 'resume', 6),
    );
    expect(facts.codexLaunches).toEqual([
      { at: at(2), evidence: 'thread-started', sourceSessionId: OTHER_THREAD },
      { at: at(5), evidence: 'resume-argument', sourceSessionId: THREAD },
    ]);
  });

  test('retains 32 unique launches and reports exact omitted count and partial coverage', () => {
    const records = Array.from({ length: 35 }, (_, index) =>
      call(
        `codex exec resume 11111111-2222-4333-8444-${String(index).padStart(12, '0')}`,
        `launch-${index}`,
        index + 1,
      ),
    );
    const results = Array.from({ length: 35 }, (_, index) =>
      result('Synthetic successful exit', `launch-${index}`, index + 36),
    );
    const facts = parse(...records, records[34], ...results);
    expect(facts.codexLaunches).toHaveLength(32);
    expect(facts.source.delegatedSessions).toHaveLength(32);
    expect(facts.codexLaunches[31]?.at).toBe(at(32));
    expect(facts.codexLaunchesTruncated).toBe(true);
    expect(facts.detailFacts.coverage.childDiscovery).toEqual({
      omittedCount: 3,
      reasons: ['child-budget'],
      status: 'partial',
    });
    expect(facts.projection.partial).toBe(true);
  });
});
