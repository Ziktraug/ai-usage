import { expect, test } from 'bun:test';
import {
  DISTILLATION_JSON_MAX_DEPTH,
  DISTILLATION_TOO_DEEP_MARKER,
  redactDistillationText,
} from './distillation-redaction';
import { MEMORY_REDACTION_RULE_SET_VERSION } from './domain';

test('masks structured tool arguments and string secrets before model input', () => {
  const secret = 'sk-test-SYNTHETIC-ONLY-NOT-A-CREDENTIAL-0123456789';
  for (const input of [
    `token=${secret}`,
    JSON.stringify({ password: 'synthetic-password', data: { api_key: secret } }),
    `Bearer ${secret}`,
  ]) {
    const output = redactDistillationText(input);
    expect(output).not.toContain(secret);
    expect(output).not.toContain('synthetic-password');
    expect(output).toContain('[REDACTED]');
  }
  expect(redactDistillationText('bun test src/cache.test.ts')).toBe('bun test src/cache.test.ts');
});

test('masks JSON inside exec envelopes and nested command strings', () => {
  const secret = 'synthetic-review-secret';
  for (const value of [
    `Chunk ID: synthetic\nProcess exited with code 0\nFinal output:\n{"password":"${secret}"}`,
    JSON.stringify({ cmd: `cat <<EOF\n{"password":"${secret}"}\nEOF` }),
    `Output:\n{ "service_api_key" : "${secret}", "ok": true }`,
  ]) {
    const masked = redactDistillationText(value);
    expect(masked).not.toContain(secret);
    expect(masked).toContain('[REDACTED]');
  }
});

test('leaves already-redacted placeholders untouched so redaction is idempotent', () => {
  for (const value of [
    '"risk_level":"low","user_authorization":"[REDACTED]","outcome":"allow"',
    '{"password": "[REDACTED]"}',
    '"password" : "[REDACTED]"',
    "'password': '[REDACTED]'",
    '"token":[REDACTED]',
    '{"password": "[REDACTED]", "ok": true}',
    JSON.stringify({ password: '[REDACTED]', ok: true }, null, 2),
    'Process exited with code 0\nOutput:\n{"password":"[REDACTED]","ok":true}',
    JSON.stringify({ cmd: 'cat <<EOF\n{"password":"[REDACTED]"}\nEOF' }),
  ]) {
    expect(redactDistillationText(value)).toBe(value);
  }
});

test('JSON members dropped by the parser never survive in the raw text', () => {
  for (const [value, expected] of [
    ['{"my.token":"hunter2","my.token":"[REDACTED]"}', '{"my.token":"[REDACTED]"}'],
    ['{"auth token":["hunter2"],"auth token":"[REDACTED]"}', '{"auth token":"[REDACTED]"}'],
    ['{"token":{"v": "hunter 2"},"token":"[REDACTED]"}', '{"token":"[REDACTED]"}'],
    [
      String.raw`{"cmd":"{\"password\":\"hunter2\"}","cmd":"{\"password\":\"[REDACTED]\"}"}`,
      String.raw`{"cmd":"{\"password\": \"[REDACTED]\"}"}`,
    ],
    [
      String.raw`{"x":{"my.token":"hunter2"},"x":"{\"password\":\"[REDACTED]\"}"}`,
      String.raw`{"x":"{\"password\": \"[REDACTED]\"}"}`,
    ],
  ] as const) {
    const output = redactDistillationText(value);
    expect(output).toBe(expected);
    expect(output).not.toContain('hunter2');
    expect(output).not.toContain('hunter 2');
  }
  expect(redactDistillationText('{"token=abc":1}')).not.toContain('abc');
});

test('text holding a genuine secret keeps the original output exactly', () => {
  for (const [value, expected] of [
    ['"password":"[REDACTED]" "token":"hunter2"', '"password": "[REDACTED]" "token": "[REDACTED]"'],
    [
      String.raw`{"note":"\"password\":\"[REDACTED]\"","token":"hunter2"}`,
      String.raw`{"note":"\"password\": \"[REDACTED]\"","token":"[REDACTED]"}`,
    ],
    ['"token":[redacted]', '"token": "[REDACTED]"]'],
  ] as const) {
    const output = redactDistillationText(value);
    expect(output).toBe(expected);
    expect(output).not.toContain('hunter2');
  }
});

test('substrings of a redacted packet event stay fixed points', () => {
  const raw =
    '{"risk_level":"low","user_authorization":"synthetic-authorization-value","outcome":"allow","rationale":"Synthetic read-only command."}';
  const packet = redactDistillationText(raw);
  expect(packet).toBe(
    '{"risk_level":"low","user_authorization":"[REDACTED]","outcome":"allow","rationale":"Synthetic read-only command."}',
  );
  expect(redactDistillationText(packet)).toBe(packet);
  const quote = '"risk_level":"low","user_authorization":"[REDACTED]","outcome":"allow"';
  expect(packet).toContain(quote);
  expect(redactDistillationText(quote)).toBe(quote);
});

test('still masks genuine secrets with the existing output shape', () => {
  expect(redactDistillationText('"password":"synthetic-pass"')).toBe('"password": "[REDACTED]"');
  expect(redactDistillationText('"password":"[REDACTED]hunter2"')).not.toContain('hunter2');
  expect(redactDistillationText('{"password":"real-synthetic-secret"}')).toBe('{"password":"[REDACTED]"}');
});

test('bare values run past closing brackets unless another token could start after them', () => {
  for (const [value, expected, secret] of [
    ['"token":abc]hunter2', '"token": "[REDACTED]"', 'hunter2'],
    ['"password":x}hunter2 rest', '"password": "[REDACTED]" rest', 'hunter2'],
    ["Output: {'api_key': sk_live]tail}", `Output: {'api_key': "[REDACTED]"}`, 'sk_live'],
    ['"token":[REDACTED]]hunter2', '"token": "[REDACTED]"', 'hunter2'],
    ['"token":[REDACTED]x', '"token": "[REDACTED]"', '[REDACTED]x'],
    ['"token":abc]', '"token": "[REDACTED]"]', 'abc'],
    ['"token":123}', '"token": "[REDACTED]"}', '123'],
    ['{"token":123}{"password": "hunter2"}', '{"token": "[REDACTED]"}{"password": "[REDACTED]"}', 'hunter2'],
    [
      '{"token":null}Response:{"password": "synthetic-password"}',
      '{"token": "[REDACTED]"{"password": "[REDACTED]"}',
      'synthetic-password',
    ],
    ["{'token': None}Result:{'password': 'x'}", `{'token': "[REDACTED]"{'password': "[REDACTED]"}`, "'x'"],
    // Text the shared rules match right after the bracket is left to them.
    ['{"token":null}Bearer hunter2abcdef', '{"token": "[REDACTED]"}[REDACTED]', 'hunter2'],
    ['{"token":1}password = hunter2', '{"token": "[REDACTED]"}[REDACTED]', 'hunter2'],
    [
      '"token":x}-----BEGIN RSA PRIVATE KEY-----\nPEMBODY\n-----END RSA PRIVATE KEY-----',
      '"token": "[REDACTED]"}[REDACTED]',
      'PEMBODY',
    ],
    ['{"token":true}Authorization:Bearer hunter2abcdef', '{"token": "[REDACTED]"}[REDACTED]', 'hunter2'],
    ["{'token': None}Bearer hunter2abcdef", `{'token': "[REDACTED]"}[REDACTED]`, 'hunter2'],
    ['{"token":1}password:"hunter2"', '{"token": "[REDACTED]"}[REDACTED]', 'hunter2'],
    [`{"token":1}https://u:p'q4ss@h`, '{"token": "[REDACTED]"}[REDACTED]h', 'q4ss'],
  ] as const) {
    const output = redactDistillationText(value);
    expect(output).toBe(expected);
    expect(output).not.toContain(secret);
    expect(redactDistillationText(output)).toBe(output);
  }
  // A quote after the closing bracket starts a new token, so the value ends at the bracket.
  const boundary = redactDistillationText('"token":abc]"hunter2"');
  expect(boundary).toBe('"token": "[REDACTED]"]"hunter2"');
  expect(redactDistillationText(boundary)).toBe(boundary);
  for (const clean of ['"token":[REDACTED]', '"token":[REDACTED]]', '"token":[REDACTED]}, "ok": true']) {
    expect(redactDistillationText(clean)).toBe(clean);
  }
});

test('duplicate JSON members are redacted from what the parser kept, never from the raw text', () => {
  for (const [value, expected, secret] of [
    [
      String.raw`{"cmd":"{\"password\":\"hunter2\"}","cmd":"{\"ok\":true}"}`,
      String.raw`{"cmd":"{\"ok\":true}"}`,
      'hunter2',
    ],
    // Shared rules that change the raw lossy text fail closed: every kept string and every
    // non-sensitive key becomes the placeholder, which collapses members.
    ['{"token=abc":1,"token=abc":2}', '{"[REDACTED]":"[REDACTED]"}', 'abc'],
    [
      '{"k":["-----BEGIN RSA PRIVATE KEY-----","SYNTHETIC-PEM-BODY","-----END RSA PRIVATE KEY-----"],"d":1,"d":2}',
      '{"[REDACTED]":"[REDACTED]"}',
      'SYNTHETIC-PEM-BODY',
    ],
    // Masking in the raw fallback can itself produce duplicate keys; the next pass settles them.
    ['{"aaaaaaaa.bbbbbbbb.cccccccc":1,"aaaaaaaa.bbbbbbbb.dddddddd":2}', '{"[REDACTED]":1,"[REDACTED]":2}', 'cccccccc'],
    ['{"a":1,"a":2,"c":"token=a"b" x"}', '{"a":1,"a":2,"c":"[REDACTED] x"}', 'token=a'],
    [
      '{"line":"-----BEGIN RSA PRIVATE KEY-----","line":"SYNTHETIC_PRIVATE_KEY_BODY","end":"-----END RSA PRIVATE KEY-----"}',
      '{"[REDACTED]":"[REDACTED]"}',
      'SYNTHETIC_PRIVATE_KEY_BODY',
    ],
    [
      String.raw`{"cmd":"{\"password\":\"hunter2\"}","cmd":"{\"ok\":true}","p":"Enter password:"}`,
      '{"[REDACTED]":"[REDACTED]"}',
      'hunter2',
    ],
    [
      '{"line":"-----BEGIN RSA PRIVATE KEY-----","line":"SYNTHETIC_PRIVATE_KEY_BODY","end":"-----END RSA PRIVATE KEY-----","p":"Enter password:"}',
      '{"[REDACTED]":"[REDACTED]"}',
      'SYNTHETIC_PRIVATE_KEY_BODY',
    ],
    [
      '[{"line":"-----BEGIN RSA PRIVATE KEY-----","line":"SYNTHETIC_PRIVATE_KEY_BODY"},"-----END RSA PRIVATE KEY-----"]',
      '[{"[REDACTED]":"[REDACTED]"},"[REDACTED]"]',
      'SYNTHETIC_PRIVATE_KEY_BODY',
    ],
    [
      '[{"line":"-----BEGIN RSA PRIVATE KEY-----","line":"SYNTHETIC_[REDACTED]_BODY"},"-----END RSA PRIVATE KEY-----"]',
      '[{"[REDACTED]":"[REDACTED]"},"[REDACTED]"]',
      'SYNTHETIC_',
    ],
    [
      String.raw`[{"line":"-----BEGIN RSA PRIVATE KEY-----","line":"SYNTHETIC_PRIVATE_KEY_BODY"},"-----END RSA PRIVATE KEY-----",{"p":"caf\u00e9password:"}]`,
      '[{"[REDACTED]":"[REDACTED]"},"[REDACTED]",{"[REDACTED]":"[REDACTED]"}]',
      'SYNTHETIC_PRIVATE_KEY_BODY',
    ],
    // Sensitivity is judged on the parsed keys, never on keys the raw rules rewrote.
    [
      '{"settings.database.password":"hunter2","x":1,"x":2}',
      '{"settings.database.password":"[REDACTED]","[REDACTED]":"[REDACTED]"}',
      'hunter2',
    ],
    [
      '{"Bearer aaaaaaaa_token":"hunter2","x":1,"x":2}',
      '{"Bearer aaaaaaaa_token":"[REDACTED]","[REDACTED]":"[REDACTED]"}',
      'hunter2',
    ],
    [
      '{"a.bbbbbbbb.cccccccc.password":"hunter2","x":1,"x":2}',
      '{"a.bbbbbbbb.cccccccc.password":"[REDACTED]","[REDACTED]":"[REDACTED]"}',
      'hunter2',
    ],
    [
      '{"ghp_SYNTHETICTOKEN0000000000_token":"hunter2","x":1,"x":2}',
      '{"ghp_SYNTHETICTOKEN0000000000_token":"[REDACTED]","[REDACTED]":"[REDACTED]"}',
      'hunter2',
    ],
    [
      `{"${'a'.repeat(245)}-token:x ":1,"a":1,"a":2,"password":"p"}`,
      '{"[REDACTED]":"[REDACTED]","password":"[REDACTED]"}',
      '-token:x',
    ],
  ] as const) {
    const output = redactDistillationText(value);
    expect(output).toBe(expected);
    expect(output).not.toContain(secret);
    expect(redactDistillationText(output)).toBe(output);
  }
});

test('tails absorbed into JSON stay absorbed; past the nesting bound the text fails closed', () => {
  // Outside the Memory domain limits a tail is absorbed as it is in any other JSON.
  for (const value of [
    '{"":1,"token":x}y}',
    `{"a":${'['.repeat(33)}1${']'.repeat(33)},"token":x}y}`,
    '{"n":1e400,"token":x}y}',
  ]) {
    const output = redactDistillationText(value);
    expect(output).toBe(value.replace('"token":x}y}', '"token": "[REDACTED]"}'));
    expect(redactDistillationText(output)).toBe(output);
  }
  // Past the nesting bound, text that masking closes into JSON fails closed whole: keeping the bracket
  // outside would leave the tail visible.
  const deep = `{"a":${'['.repeat(256)}1${']'.repeat(256)}`;
  for (const value of [
    `${deep},"token":x}hunter2}`,
    `${deep},"token":undefined}`,
    `{"a":${'['.repeat(300)}${']'.repeat(300)},"a":1,"token":x}hunter2}`,
  ]) {
    expect(redactDistillationText(value)).toBe(DISTILLATION_TOO_DEEP_MARKER);
  }
});

test('one rescan budget covers every string of a text', () => {
  const value = JSON.stringify({ lines: Array.from({ length: 43 }, () => "'token': x}y ".repeat(386)) });
  const started = performance.now();
  const output = redactDistillationText(value);
  const elapsed = performance.now() - started;
  expect(elapsed).toBeLessThan(1000);
  expect(output).not.toContain(': x}');
  expect(redactDistillationText(output)).toBe(output);
});

test('redaction settles to a fixed point across passes', () => {
  for (const [value, expected, secret] of [
    [
      '{"auth.token":"synthetic-password","token":abc]suffix}',
      '{"auth.token":"[REDACTED]","token":"[REDACTED]"}',
      'synthetic-password',
    ],
    ['{"http://a:http://b:p@x@":1,"password":"p"}', '{"[REDACTED]":1,"password":"[REDACTED]"}', 'b:p@'],
    [
      '{"begin":"-----BEGIN PRIVATE KEY-----","SYNTHETIC_BODY":1,"end":"-----END PRIVATE KEY-----","d":1,"d":2}',
      '{"[REDACTED]":"[REDACTED]"}',
      'SYNTHETIC_BODY',
    ],
    [
      '{"a":"-----BEGIN RSA PRIVATE KEY-----","a":1,"SECRETBODY":"-----END RSA PRIVATE KEY-----"}',
      '{"[REDACTED]":"[REDACTED]"}',
      'SECRETBODY',
    ],
  ] as const) {
    const output = redactDistillationText(value);
    expect(output).toBe(expected);
    expect(output).not.toContain(secret);
    expect(redactDistillationText(output)).toBe(output);
  }
});

test('text still changing after the step limit is replaced outright', () => {
  // Nested URL credentials lose one level per pass; twelve levels need more than eight passes.
  const nested = `${'http://a:'.repeat(12)}p${'@'.repeat(12)}`;
  for (const value of [`{"${nested}":1,"password":"p"}`, nested, `out: ${nested} done`]) {
    expect(redactDistillationText(value)).toBe('[REDACTED]');
  }
  expect(redactDistillationText('[REDACTED]')).toBe('[REDACTED]');
});

test('a PEM footer glued after a bracket tail is left to the shared rules', () => {
  // The tail-overlap reasoning in distillation-redaction.ts assumes memory-redaction-v1's rules;
  // revisit it when the shared rule set changes.
  expect(MEMORY_REDACTION_RULE_SET_VERSION).toBe('memory-redaction-v1');
  const pem = (bracket: string, kind: string): string =>
    `-----BEGIN ${kind}PRIVATE KEY-----\nSYNTHETIC_BODY\n"token":x${bracket}-----END ${kind}PRIVATE KEY-----`;
  for (const [value, expected] of [
    [pem(']', ''), '[REDACTED]'],
    [JSON.stringify({ k: pem(']', '') }), '{"k":"[REDACTED]"}'],
    [pem('}', ''), '[REDACTED]'],
    [pem(']]', 'RSA '), '[REDACTED]'],
  ] as const) {
    const output = redactDistillationText(value);
    expect(output).toBe(expected);
    expect(output).not.toContain('SYNTHETIC_BODY');
    expect(redactDistillationText(output)).toBe(output);
  }
});

test('masking that yields JSON outside the Memory domain limits keeps the masked output', () => {
  const prefix = 'a'.repeat(245);
  for (const [value, expected] of [
    ['{"":1,"token":undefined}', '{"":1,"token": "[REDACTED]"}'],
    [`{"${prefix}-token:x ":"hunter2","a":1,"a":2}`, '{"[REDACTED]":"[REDACTED]"}'],
    // The key grows past 256 characters; its value is not sensitive, as with a short key.
    [`{"${prefix}-token:x ":"hunter2"}`, `{"${prefix}-[REDACTED] ":"hunter2"}`],
    ['{"a-token:x ":"hunter2"}', '{"a-[REDACTED] ":"hunter2"}'],
  ] as const) {
    const output = redactDistillationText(value);
    expect(output).toBe(expected);
    expect(output).not.toContain('token:x');
    expect(output).not.toContain('undefined');
    expect(redactDistillationText(output)).toBe(output);
  }
});

test('secrets inside JSON keys are redacted when a value change emits structured output', () => {
  for (const [value, expected, secret] of [
    ['{"token=abc":1,"password":"x"}', '{"[REDACTED]":1,"password":"[REDACTED]"}', 'abc'],
    // A sensitive key keeps its text so the next pass still sees a sensitive member.
    ['{"secret:token":"hunter2"}', '{"secret:token":"[REDACTED]"}', 'hunter2'],
    [
      '{"k":["Enter password:"],"secret:token":"hunter2"}',
      '{"k":["Enter password:"],"secret:token":"[REDACTED]"}',
      'hunter2',
    ],
  ] as const) {
    const output = redactDistillationText(value);
    expect(output).toBe(expected);
    expect(output).not.toContain(secret);
    expect(redactDistillationText(output)).toBe(output);
  }
  // A key-only finding keeps the raw-text fallback output.
  for (const [value, expected] of [
    ['{"token=abc":1}', '{"[REDACTED]'],
    ['{"nested":[{"token=abc":true}]}', '{"nested":[{"[REDACTED]'],
  ] as const) {
    const output = redactDistillationText(value);
    expect(output).toBe(expected);
    expect(output).not.toContain('abc');
    expect(redactDistillationText(output)).toBe(output);
  }
});

test('a key keeps its redacted text whatever its length', () => {
  const prefix = 'a'.repeat(245);
  const untouched = JSON.stringify({ [`${prefix}"token":x`]: 1 });
  expect(redactDistillationText(untouched)).toBe(untouched);
  const output = redactDistillationText(JSON.stringify({ [`${prefix}"token":x`]: 1, password: 'p' }));
  expect(output).toBe(JSON.stringify({ [`${prefix}"token": "[REDACTED]"`]: 1, password: '[REDACTED]' }));
  expect(output).not.toContain(':x');
  expect(redactDistillationText(output)).toBe(output);
});

test('structured output is emitted without a raw-text pass over the JSON', () => {
  for (const [value, expected, secret] of [
    [
      `{"password":"x","note":"'token': 'abc'","p":"Enter password:","q":1}`,
      String.raw`{"password":"[REDACTED]","note":"'token': \"[REDACTED]\"","p":"Enter password:","q":1}`,
      "'abc'",
    ],
    [
      `{"password":"x","note":"'token': '[REDACTED]'","k":[["-----BEGIN RSA PRIVATE KEY-----"],"-----END RSA PRIVATE KEY-----"]}`,
      String.raw`{"password":"[REDACTED]","note":"'token': \"[REDACTED]\"","k":[["-----BEGIN RSA PRIVATE KEY-----"],"-----END RSA PRIVATE KEY-----"]}`,
      '"x"',
    ],
    [
      '{"password":"p","url":"https://example.com","email":"a@b.c"}',
      '{"password":"[REDACTED]","url":"https://example.com","email":"a@b.c"}',
      '"p"',
    ],
  ] as const) {
    const output = redactDistillationText(value);
    expect(output).toBe(expected);
    expect(output).not.toContain(secret);
    expect(redactDistillationText(output)).toBe(output);
  }
});

test('an escaped filled slot in the raw fallback settles after one pass', () => {
  const output = redactDistillationText(String.raw`{"note":"'token': \"[REDACTED]\"","p":"Enter password:"}`);
  expect(output).toBe(`{"note":"'token': "[REDACTED]""","p":"Enter [REDACTED]`);
  expect(redactDistillationText(output)).toBe(output);
});

test('the JSON fallback does not re-mask escaped quotes on a second pass', () => {
  const output = redactDistillationText('{"a":"x \'password\': y"}');
  expect(output).toBe(String.raw`{"a":"x 'password': \"[REDACTED]\""}`);
  expect(output).not.toContain("': y");
  expect(redactDistillationText(output)).toBe(output);
});

test('lossless non-canonical JSON stays byte-identical', () => {
  for (const value of [
    String.raw`{"n": 1.0, "name": "caf\u00e9", "path": "a\/b"}`,
    '{"password": "[REDACTED]", "n": 1.0}',
    '{"b": 1, "a": 2, "10": 3, "2": 4}',
  ]) {
    expect(redactDistillationText(value)).toBe(value);
  }
});

test('tail rescans are budgeted; past the budget a bare value ends at the bracket', () => {
  // 1500 slots in 18 KiB of text: the rescan budget (1 MiB) runs out after the first few dozen slots,
  // so later slots keep the bracket outside the value until the remaining text fits the budget again.
  const value = `out: ${'"token":x]y '.repeat(1500)}`;
  const started = performance.now();
  const output = redactDistillationText(value);
  const elapsed = performance.now() - started;
  expect(elapsed).toBeLessThan(1000);
  expect(output.startsWith('out: "token": "[REDACTED]" "token"')).toBe(true);
  const kept = output.split('"token": "[REDACTED]"]y ').length - 1;
  expect(kept).toBeGreaterThan(0);
  expect(kept).toBeLessThan(1500);
  expect(output).not.toContain(':x');
  expect(redactDistillationText(output)).toBe(output);
});

test('fail-closed lossy documents replace every leaf', () => {
  for (const [value, expected] of [
    ['{"password:":0,"password:":987654321}', '{"[REDACTED]":"[REDACTED]"}'],
    [
      '[{"a":"-----BEGIN PRIVATE KEY-----","a":1},{"pin":987654321},"-----END PRIVATE KEY-----"]',
      '[{"[REDACTED]":"[REDACTED]"},{"[REDACTED]":"[REDACTED]"},"[REDACTED]"]',
    ],
  ] as const) {
    const output = redactDistillationText(value);
    expect(output).toBe(expected);
    expect(output).not.toContain('987654321');
    expect(redactDistillationText(output)).toBe(output);
  }
});

test('clean duplicate-key JSON stays byte-identical, judged member by member', () => {
  for (const value of [
    '{"status":"retry","status":"success"}',
    `{\n  "status": "retry",\n  "status": "success"\n}`,
    '{"password":"[REDACTED]","password":"[REDACTED]","ok":true}',
  ]) {
    expect(redactDistillationText(value)).toBe(value);
  }
  const event = '{"status":"retry","status":"success","note":"synthetic"}';
  const quote = '"status":"retry","status":"success"';
  expect(redactDistillationText(event)).toBe(event);
  expect(event).toContain(quote);
  expect(redactDistillationText(quote)).toBe(quote);
  // Members JSON.parse would drop are judged too: a secret in one is never returned verbatim.
  for (const [value, expected] of [
    ['{"token":"hunter2","token":"[REDACTED]"}', '{"token":"[REDACTED]"}'],
    [String.raw`{"cmd":"{\"password\":\"hunter2\"}","cmd":"ok"}`, '{"cmd":"ok"}'],
    [String.raw`{"cmd":"ok","cmd":"{\"password\":\"hunter2\"}"}`, String.raw`{"cmd":"{\"password\": \"[REDACTED]\"}"}`],
  ] as const) {
    const output = redactDistillationText(value);
    expect(output).toBe(expected);
    expect(output).not.toContain('hunter2');
    expect(redactDistillationText(output)).toBe(output);
  }
});

test('JSON outside the Memory domain limits is redacted like any other JSON', () => {
  const longKey = 'k'.repeat(300);
  const numbers = Array.from({ length: 10_001 }, (_, index) => index);
  const nest = (inner: string): string => `${'['.repeat(40)}${inner}${']'.repeat(40)}`;
  for (const value of [
    '{"":1}',
    JSON.stringify(numbers),
    nest('1'),
    JSON.stringify({ [longKey]: 1 }),
    '{"a":1e400}',
    '{"": 1, "n": 1e400}',
  ]) {
    expect(redactDistillationText(value)).toBe(value);
  }
  for (const [value, expected] of [
    ['{"":1,"password":"hunter2"}', '{"":1,"password":"[REDACTED]"}'],
    [JSON.stringify([...numbers, { password: 'hunter2' }]), JSON.stringify([...numbers, { password: '[REDACTED]' }])],
    [nest('{"password":"hunter2"}'), nest('{"password":"[REDACTED]"}')],
    [JSON.stringify({ [longKey]: 1, password: 'hunter2' }), JSON.stringify({ [longKey]: 1, password: '[REDACTED]' })],
    ['{"a":1e400,"password":"hunter2"}', '{"a":null,"password":"[REDACTED]"}'],
    // Only the structured walk sees a secret behind escaped quotes.
    [String.raw`{"":"{\"password\":\"hunter2\"}"}`, String.raw`{"":"{\"password\": \"[REDACTED]\"}"}`],
  ] as const) {
    const output = redactDistillationText(value);
    expect(output).toBe(expected);
    expect(output).not.toContain('hunter2');
    expect(redactDistillationText(output)).toBe(output);
  }
});

test('JSON nested past the walk bound is replaced by an explicit marker', () => {
  expect(DISTILLATION_JSON_MAX_DEPTH).toBe(256);
  expect(DISTILLATION_TOO_DEEP_MARKER).toBe('[REDACTED: JSON nested deeper than 256 levels]');
  expect(redactDistillationText(DISTILLATION_TOO_DEEP_MARKER)).toBe(DISTILLATION_TOO_DEEP_MARKER);
  const nest = (inner: string, levels: number): string => `${'['.repeat(levels)}${inner}${']'.repeat(levels)}`;
  expect(redactDistillationText(nest('', 256))).toBe(nest('', 256));
  for (const value of [
    nest('', 257),
    nest('', 60_000),
    nest('{"password":"hunter2"}', 300),
    // Members JSON.parse drops count toward the bound too.
    `{"a":${nest('{"password":"hunter2"}', 300)},"a":1}`,
  ]) {
    expect(redactDistillationText(value)).toBe(DISTILLATION_TOO_DEEP_MARKER);
  }
  // Text that is not JSON as a whole keeps the raw-text rules, whatever it embeds.
  const embedded = `Output:\n${nest('', 300)}`;
  expect(redactDistillationText(embedded)).toBe(embedded);
});

test('JSON at the nesting bound is re-emitted structurally from a deep caller', () => {
  const open = '{"a":'.repeat(255);
  const close = '}'.repeat(255);
  const redactBelow = (frames: number, value: string): string =>
    frames === 0 ? redactDistillationText(value) : redactBelow(frames - 1, value);
  for (const [value, expected] of [
    [`${open}{"password":"hunter2","k":1}${close}`, `${open}{"password":"[REDACTED]","k":1}${close}`],
    [`${open}{"x":1,"x":2,"password":"hunter2"}${close}`, `${open}{"x":2,"password":"[REDACTED]"}${close}`],
    // The fail-closed lossy form replaces every non-sensitive key on the way down.
    [
      `${open}{"x":1,"x":2,"password:":"hunter2"}${close}`,
      `${'{"[REDACTED]":'.repeat(255)}{"[REDACTED]":"[REDACTED]"}${close}`,
    ],
  ] as const) {
    const output = redactBelow(5000, value);
    expect(output).toBe(expected);
    expect(output).not.toContain('hunter2');
    expect(redactBelow(5000, output)).toBe(output);
  }
});

test('large JSON documents redact within the time budget', () => {
  const items = Array.from({ length: 9000 }, (_, index) => ({ id: index, name: 'x' }));
  const value = JSON.stringify(items);
  expect(value.length).toBeGreaterThan(170_000);
  const started = performance.now();
  expect(redactDistillationText(value)).toBe(value);
  const secret = JSON.stringify([...items, { password: 'hunter2' }]);
  expect(redactDistillationText(secret)).toBe(JSON.stringify([...items, { password: '[REDACTED]' }]));
  expect(performance.now() - started).toBeLessThan(1000);
});
