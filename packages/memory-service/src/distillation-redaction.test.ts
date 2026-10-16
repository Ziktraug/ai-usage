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
  // The raw text escapes the key's quotes, so only the structured pass redacts it, whether or not a value
  // changes too.
  for (const [value, expected] of [
    [JSON.stringify({ [`${prefix}"token":x`]: 1 }), JSON.stringify({ [`${prefix}"token": "[REDACTED]"`]: 1 })],
    [
      JSON.stringify({ [`${prefix}"token":x`]: 1, password: 'p' }),
      JSON.stringify({ [`${prefix}"token": "[REDACTED]"`]: 1, password: '[REDACTED]' }),
    ],
  ] as const) {
    const output = redactDistillationText(value);
    expect(output).toBe(expected);
    expect(output).not.toContain(':x');
    expect(redactDistillationText(output)).toBe(output);
  }
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
  // Text that is not JSON as a whole keeps the raw-text rules; a document it embeds past the bound fails
  // closed in place.
  expect(redactDistillationText(`Output:\n${nest('', 300)}`)).toBe(`Output:\n${DISTILLATION_TOO_DEEP_MARKER}`);
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

test('a nested object or array value is masked whole, not just its first token', () => {
  for (const [value, expected, secret] of [
    ['Output: {"password": {"value": "hunter2"}}', 'Output: {"password": "[REDACTED]"}', 'hunter2'],
    ['Output: {"token": ["a", "hunter2"]}', 'Output: {"token": "[REDACTED]"}', 'hunter2'],
    ["Result: {'api_key': {'v': 'hunter2'}} done", `Result: {'api_key': "[REDACTED]"} done`, 'hunter2'],
    [
      'Output:\n{\n  "token": {\n    "value": "hunter2",\n    "items": [1, 2]\n  },\n  "ok": true\n}\n',
      'Output:\n{\n  "token": "[REDACTED]",\n  "ok": true\n}\n',
      'hunter2',
    ],
    // Brackets and quotes inside the value's strings do not end it.
    [
      String.raw`Output: {"token": {"v": "a]b}c\"d", "w": "hunter2"}} done`,
      'Output: {"token": "[REDACTED]"} done',
      'hunter2',
    ],
    [`Output: {'token': ["it's", 'hunter2']} done`, `Output: {'token': "[REDACTED]"} done`, 'hunter2'],
    [
      'Output: {"token": [{"a": 1}, {"b": "hunter2"}], "ok": true} done',
      'Output: {"token": "[REDACTED]", "ok": true} done',
      'hunter2',
    ],
    // Secret keys nested in a plain object get their own slots; inside a covered value they are covered.
    [
      'Output: {"auth": {"password": "hunter2", "api_key": ["x", "hunter3"]}} done',
      'Output: {"auth": {"password": "[REDACTED]", "api_key": "[REDACTED]"}} done',
      'hunter3',
    ],
    ['Output: {"secret": {"password": {"token": "hunter2"}}} done', 'Output: {"secret": "[REDACTED]"} done', 'hunter2'],
    // A secret the shared rules hide elsewhere in the envelope does not stop the value being covered.
    [
      'Output: {"token": ["a", "hunter2"]} Bearer abcdefghijkl',
      'Output: {"token": "[REDACTED]"} [REDACTED]',
      'hunter2',
    ],
    // The structured path masks a nested value inside a JSON string the same way.
    [
      JSON.stringify({ cmd: 'echo {"token": ["a", "hunter2"]}' }),
      String.raw`{"cmd":"echo {\"token\": \"[REDACTED]\"}"}`,
      'hunter2',
    ],
  ] as const) {
    const output = redactDistillationText(value);
    expect(output).toBe(expected);
    expect(output).not.toContain(secret);
    expect(redactDistillationText(output)).toBe(output);
  }
});

test('a nested value that leaves only brackets and separators visible keeps the existing output', () => {
  for (const [value, expected] of [
    ['"token":[redacted]', '"token": "[REDACTED]"]'],
    ['"token":[REDACTED]', '"token":[REDACTED]'],
    ['Output: {"token": []} rest', 'Output: {"token": "[REDACTED]"]} rest'],
    ['Output: {"token": {}} rest', 'Output: {"token": "[REDACTED]"}} rest'],
    ['"token": [ ]', '"token": "[REDACTED]" ]'],
    ['"token":[x]', '"token": "[REDACTED]"]'],
  ] as const) {
    const output = redactDistillationText(value);
    expect(output).toBe(expected);
    expect(redactDistillationText(output)).toBe(output);
  }
});

test('a nested value the slot cannot cover safely keeps the existing output', () => {
  const nest = (inner: string, levels: number): string => `${'['.repeat(levels)}${inner}${']'.repeat(levels)}`;
  for (const [value, expected, secret] of [
    // Truncated or mismatched brackets.
    ['Output: {"token": ["a", "hunter2"', 'Output: {"token": "[REDACTED]", "hunter2"', '"a"'],
    ['Output: {"token": ["a", "hunter2"}] rest', 'Output: {"token": "[REDACTED]", "hunter2"}] rest', '"a"'],
    // A shared-rule match starting inside the value runs past it; hiding its start would expose "def".
    ['"token": [x, password=abc]def', '"token": "[REDACTED]", [REDACTED]', 'def'],
    // A PEM footer inside the value closes a header before the slot; hiding it would expose the body.
    [
      '-----BEGIN RSA PRIVATE KEY-----\nPEMBODY\n"token": [x,\n-----END RSA PRIVATE KEY-----] tail',
      '[REDACTED]] tail',
      'PEMBODY',
    ],
    // A later slot straddles the value's end; cutting it would expose "y".
    ['{"password": [a, "token":x]y}', '{"password": "[REDACTED]", "token": "[REDACTED]"}', 'y}'],
    [
      'Output: {"password": [a, "token":x]hunter2} rest',
      'Output: {"password": "[REDACTED]", "token": "[REDACTED]"} rest',
      'hunter2',
    ],
    // Masked whole, the text becomes JSON nested past the bound, which fails closed; the budget-free extent
    // keeps the head only.
    [nest('{"token":{"a": b c}}', 256), nest('{"token": "[REDACTED]" b c}}', 256), '{"a"'],
    // There the budget-free extent shows a tail the masking without covering absorbs, so that output stands.
    [nest('{"token":{"a":"x]hunter2}" b}}', 256), nest('{"token": "[REDACTED]"}" b}}', 256), 'hunter2'],
  ] as const) {
    const output = redactDistillationText(value);
    expect(output).toBe(expected);
    expect(output).not.toContain(secret);
    expect(redactDistillationText(output)).toBe(output);
  }
  // JSON the Memory domain rejects (an empty key, a non-finite number) is covered like any other.
  for (const [value, expected] of [
    ['{"":1,"token":{"a": b c}}', '{"":1,"token": "[REDACTED]"}'],
    ['{"":1,"token":{"a":"x]hunter2}" b}}', '{"":1,"token": "[REDACTED]"}'],
    ['{"n":1e400,"token":{"a":"x]hunter2}" b}}', '{"n":1e400,"token": "[REDACTED]"}'],
    [nest('{"token":{"a": b c}}', 255), nest('{"token": "[REDACTED]"}', 255)],
  ] as const) {
    const output = redactDistillationText(value);
    expect(output).toBe(expected);
    expect(redactDistillationText(output)).toBe(output);
  }
});

test('a value the slot cannot cover safely keeps its extent while a later one is still covered', () => {
  for (const [value, expected, hidden] of [
    // A shared-rule match starting inside the value runs past it.
    [
      '"token": [x, password=abc]def Output: {"api_key": ["a", "hunter3"]}',
      '"token": "[REDACTED]", [REDACTED] Output: {"api_key": "[REDACTED]"}',
      'def',
    ],
    // A PEM footer inside the value closes a header before the slot.
    [
      '-----BEGIN RSA PRIVATE KEY-----\nPEMBODY\n"token": [x,\n-----END RSA PRIVATE KEY-----] tail Output: {"api_key": ["a", "hunter3"]}',
      '[REDACTED]] tail Output: {"api_key": "[REDACTED]"}',
      'PEMBODY',
    ],
    // A later slot straddles the value's end.
    [
      'Output: {"password": [a, "token":x]hunter2} rest Output: {"api_key": ["a", "hunter3"]}',
      'Output: {"password": "[REDACTED]", "token": "[REDACTED]"} rest Output: {"api_key": "[REDACTED]"}',
      'hunter2',
    ],
  ] as const) {
    const output = redactDistillationText(value);
    expect(output).toBe(expected);
    expect(output).not.toContain(hidden);
    expect(output).not.toContain('hunter3');
    expect(redactDistillationText(output)).toBe(output);
  }
});

test('the previous output stands unless covering only removes text after slots and settles', () => {
  const nest = (inner: string, levels: number): string => `${'['.repeat(levels)}${inner}${']'.repeat(levels)}`;
  for (const [value, expected, hidden] of [
    // The value's closer left after its head closes the object: the next step's structured pass redacts it.
    [
      '{"db.password":"hunter2","token":{"type":"bearer","value":"x"}',
      '{"db.password":"[REDACTED]","token":"[REDACTED]","value":"x"}',
      'hunter2',
    ],
    [
      '[{"auth token":"hunter2","secret":[{"a":1},2]',
      '[{"auth token":"[REDACTED]","secret":"[REDACTED]"},2]',
      'hunter2',
    ],
    [
      String.raw`{"k":"a \"password\": hunter2","token":{"a":1,"x":1}`,
      String.raw`{"k":"a \"password\": \"[REDACTED]\"","token":"[REDACTED]","x":1}`,
      'hunter2',
    ],
    // An empty key does not change that: event JSON is not held to the Memory domain's limits.
    [
      '{"":1,"db.password":"hunter2","token":{"a":1,"x":1}',
      '{"":1,"db.password":"[REDACTED]","token":"[REDACTED]","x":1}',
      'hunter2',
    ],
    // The same closer makes JSON nested past the bound, which fails closed.
    [nest('{"db.password":"hunter2","token":{"a":1,"x":1}', 256), DISTILLATION_TOO_DEEP_MARKER, 'hunter2'],
    // A later pass of the URL rule eats the stray quote, so the text becomes JSON only with the closer.
    [
      '{"db.password":"hunter2","u":"http://a:x"http://b:p@@","token":{"type":"bearer","value":"x"}',
      '{"db.password":"[REDACTED]","u":"[REDACTED]","token":"[REDACTED]","value":"x"}',
      'hunter2',
    ],
    // The URL rule runs from inside the value to a later "@" and hides what lies between.
    [
      '"token":{"a":1,"url":"https://h:8443"},"mirror":"https://bob:pw@MARK@y"',
      '"token": "[REDACTED]","url":"[REDACTED]y"',
      'MARK',
    ],
    ['"token":{a http://u:x}http://v:p@MARK@', '"token": "[REDACTED]" [REDACTED]', 'MARK'],
    [
      `{"cmd":"curl 'token': [1, 'https://h:8443']","email":"bob@example.com"}`,
      `{"cmd":"curl 'token': "[REDACTED]"", '[REDACTED]example.com"}`,
      '"email":"bob@',
    ],
    // The closer makes JSON whose structured pass hides a value that also shows elsewhere, or has no words.
    [
      '{"db.password":"hunter2","user":"hunter2","token":{"type":"bearer","value":"x"}',
      '{"db.password":"[REDACTED]","user":"hunter2","token":"[REDACTED]","value":"x"}',
      '"db.password":"hunter2"',
    ],
    [
      '{"spring.datasource.password":"password","token":{"type":"bearer","value":"x"}',
      '{"spring.datasource.password":"[REDACTED]","token":"[REDACTED]","value":"x"}',
      '"spring.datasource.password":"password"',
    ],
    [
      '{"db.user":"postgres","db.password":"postgres","token":{"type":"bearer","value":"x"}',
      '{"db.user":"postgres","db.password":"[REDACTED]","token":"[REDACTED]","value":"x"}',
      '"db.password":"postgres"',
    ],
    [
      '{"db.password":"%$#!","token":{"type":"bearer","value":"x"}',
      '{"db.password":"[REDACTED]","token":"[REDACTED]","value":"x"}',
      '%$#!',
    ],
    [
      '[{"auth token":"admin-admin","user":"admin","secret":[{"a":1},2]',
      '[{"auth token":"[REDACTED]","user":"admin","secret":"[REDACTED]"},2]',
      'admin-admin',
    ],
    // Covered, a later pass makes JSON nested past the bound and the text fails closed: no slot is left.
    [
      nest('{"password":{"a": x y},"u":"http://a:x"http://b:hunter2@@"}', 256),
      nest('{"password": "[REDACTED]" x y},"u":"[REDACTED]"}', 256),
      'hunter2',
    ],
    // Within the bound, and with an empty key, the covered output settles and stands.
    [
      '{"password":{"a": x y},"u":"http://a:x"http://b:hunter2@@","":1}',
      '{"password": "[REDACTED]","u":"[REDACTED]","":1}',
      'hunter2',
    ],
  ] as const) {
    const output = redactDistillationText(value);
    expect(output).toBe(expected);
    expect(output).not.toContain(hidden);
    expect(redactDistillationText(output)).toBe(output);
  }
  // Covered whole, these texts become JSON whose escaped URL chain unwinds one level per step past the
  // step limit, so the output without covering stands. The nested pass then judges the escaped literal
  // decoded, and the next round of the rules unwinds the chain within the limit: it ends in a slot.
  const chain = (levels: number, host: string, user: string): string =>
    `${String.raw`http:\/\/${host}:`.repeat(levels)}${user}${'@'.repeat(levels)}`;
  for (const [value, expected] of [
    [`{"token":{"a": x y},"u":"${chain(7, 'a', 'p')}"}`, '{"token": "[REDACTED]" x y},"u":"[REDACTED]"}'],
    [`{"token":{"a": x y},"u":"${chain(6, 'a', 'p')}"}`, '{"token": "[REDACTED]" x y},"u":"[REDACTED]"}'],
    [
      `{"u":"http://a:x"http://b:p@@","v":"${chain(7, 'c', 'q')}","token":{"a":1,"b":2}}`,
      '{"u":"[REDACTED]","v":"[REDACTED]","token": "[REDACTED]","b":2}}',
    ],
    [
      `{"u":"http://a:x"http://b:p@@","v":"${chain(5, 'c', 'q')}","token":{"a":1,"b":2}}`,
      '{"u":"[REDACTED]","v":"[REDACTED]","token": "[REDACTED]","b":2}}',
    ],
  ] as const) {
    const output = redactDistillationText(value);
    expect(output).toBe(expected);
    expect(output).not.toContain('p@');
    expect(redactDistillationText(output)).toBe(output);
  }
  // A chain in a key the nested pass reaches as a literal gets the key text rules a document gives its
  // keys, so it unwinds the same way.
  const keyed = `{"token":{"a": x y},"${chain(7, 'a', 'p')}":1}`;
  expect(redactDistillationText(keyed)).toBe('{"token": "[REDACTED]" x y},"[REDACTED]":1}');
  // A chain longer than the rounds can unwind is replaced outright.
  expect(redactDistillationText(`{"token":{"a": x y},"u":"${chain(12, 'a', 'p')}"}`)).toBe('[REDACTED]');
});

test('covering keeps every other slot and the text between covered values', () => {
  for (const [value, expected, secret] of [
    // An unrelated slot before the covered value.
    [
      'Output: {"password": "hunter1", "token": ["a", "hunter2"]}',
      'Output: {"password": "[REDACTED]", "token": "[REDACTED]"}',
      'hunter2',
    ],
    // Two covered values with text between them.
    [
      'Output: {"token": ["a", "hunter2"]} then {"secret": {"v": "hunter3"}} done',
      'Output: {"token": "[REDACTED]"} then {"secret": "[REDACTED]"} done',
      'hunter3',
    ],
    // Covered values inside a serialized JSON string.
    [
      JSON.stringify({ cmd: 'echo {"token": ["a", "hunter2"]} && echo {"secret": {"v": "hunter3"}}' }),
      String.raw`{"cmd":"echo {\"token\": \"[REDACTED]\"} && echo {\"secret\": \"[REDACTED]\"}"}`,
      'hunter3',
    ],
  ] as const) {
    const output = redactDistillationText(value);
    expect(output).toBe(expected);
    expect(output).not.toContain('hunter2');
    expect(output).not.toContain(secret);
    expect(redactDistillationText(output)).toBe(output);
  }
});

test('nested values have their own budget and never change tail absorption', () => {
  // The 1500-slot tail text from the rescan budget test, behind a nested value that is masked whole and
  // one whose unterminated string scans to the end: either way the slots absorb exactly the same tails.
  const slots = '"token":x]y '.repeat(1500);
  const plain = redactDistillationText(`out: "token": x ${slots}`);
  expect(plain.split('"token": "[REDACTED]"]y ').length - 1).toBeGreaterThan(0);
  expect(redactDistillationText(`out: "token": [a, b] ${slots}`)).toBe(plain);
  expect(redactDistillationText(`out: "token": [' ${slots}`)).toBe(redactDistillationText(`out: "token": x' ${slots}`));
  // Many nested values in one text: the first are masked whole; past the allowance the rest keep the
  // extent they had before.
  for (const [value, last] of [
    [`out: ${'"token": [\' '.repeat(20_000)}`, '"token": "[REDACTED]" '],
    [`out: ${'"token": ["a", "hunter2"] '.repeat(5000)}`, '"token": "[REDACTED]", "hunter2"] '],
  ] as const) {
    const started = performance.now();
    const output = redactDistillationText(value);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(1000);
    expect(output.startsWith('out: "token": "[REDACTED]" "token": "[REDACTED]" ')).toBe(true);
    expect(output.endsWith(last)).toBe(true);
    expect(output).not.toContain(': [');
    expect(redactDistillationText(output)).toBe(output);
  }
});

// Escaped JSON the raw-text rules cannot see: a password inside a JSON string inside a JSON document.
const escapedSecret = JSON.stringify({ args: JSON.stringify({ password: 'hunter2' }) });
const escapedSlot = JSON.stringify({ args: '{"password": "[REDACTED]"}' });

test('JSON embedded in tool envelopes is judged by the JSON pipeline', () => {
  const chunk = 'Chunk ID: synthetic\nProcess exited with code 0\nOutput:\n';
  for (const [value, expected] of [
    [`Final output:\n${escapedSecret}`, `Final output:\n${escapedSlot}`],
    [`${chunk}${escapedSecret}`, `${chunk}${escapedSlot}`],
    [
      `Final output:\n${JSON.stringify({ args: JSON.stringify({ password: 'hunter2' }) }, null, 2)}`,
      `Final output:\n${escapedSlot}`,
    ],
    [`Output:\n[${escapedSecret}]`, `Output:\n[${escapedSlot}]`],
    [
      `Output:\n${escapedSecret}${JSON.stringify({ cmd: JSON.stringify({ token: 'hunter2' }) })}`,
      `Output:\n${escapedSlot}${JSON.stringify({ cmd: '{"token": "[REDACTED]"}' })}`,
    ],
    [`${chunk}${escapedSecret}\nWall time: 0.1 seconds`, `${chunk}${escapedSlot}\nWall time: 0.1 seconds`],
  ] as const) {
    const output = redactDistillationText(value);
    expect(output).toBe(expected);
    expect(output).not.toContain('hunter2');
    expect(redactDistillationText(output)).toBe(output);
  }
});

test('escaped JSON is judged at every nesting level', () => {
  for (const [value, expected] of [
    [
      JSON.stringify({ args: JSON.stringify({ x: JSON.stringify({ password: 'hunter2' }) }) }),
      JSON.stringify({ args: JSON.stringify({ x: '{"password": "[REDACTED]"}' }) }),
    ],
    [
      JSON.stringify({ output: `Final output:\n${escapedSecret}` }),
      JSON.stringify({ output: `Final output:\n${escapedSlot}` }),
    ],
    [
      `Output:\n${JSON.stringify({ a: JSON.stringify({ b: JSON.stringify({ password: 'hunter2' }) }) })}`,
      `Output:\n${JSON.stringify({ a: JSON.stringify({ b: '{"password": "[REDACTED]"}' }) })}`,
    ],
    [
      `Output:\n${JSON.stringify({ a: JSON.stringify({ b: JSON.stringify({ c: JSON.stringify({ token: 'hunter2' }) }) }) })}`,
      `Output:\n${JSON.stringify({ a: JSON.stringify({ b: JSON.stringify({ c: '{"token": "[REDACTED]"}' }) }) })}`,
    ],
    // Keys are documents too.
    [JSON.stringify({ [escapedSecret]: 1 }), JSON.stringify({ [escapedSlot]: 1 })],
  ] as const) {
    const output = redactDistillationText(value);
    expect(output).toBe(expected);
    expect(output).not.toContain('hunter2');
    expect(redactDistillationText(output)).toBe(output);
  }
});

test('sensitive keys the raw-text rules miss are judged inside envelopes', () => {
  for (const [value, expected] of [
    ['Output:\n{"my.token":"hunter2"}', 'Output:\n{"my.token":"[REDACTED]"}'],
    ['Output:\n{"Secret Token":"hunter2","ok":true} done', 'Output:\n{"Secret Token":"[REDACTED]","ok":true} done'],
    [
      JSON.stringify({ log: 'Output:\n{"my.token":"hunter2"}' }),
      JSON.stringify({ log: 'Output:\n{"my.token":"[REDACTED]"}' }),
    ],
  ] as const) {
    const output = redactDistillationText(value);
    expect(output).toBe(expected);
    expect(output).not.toContain('hunter2');
    expect(redactDistillationText(output)).toBe(output);
  }
});

test('duplicate-key documents are judged for nested secrets in every member', () => {
  const dropped = `{"cmd":${JSON.stringify(escapedSecret)},"cmd":"ok"}`;
  for (const [value, expected] of [
    [`Output:\n${dropped}`, 'Output:\n{"cmd":"ok"}'],
    [dropped, '{"cmd":"ok"}'],
    [`{"cmd":"ok","cmd":${JSON.stringify(escapedSecret)}}`, JSON.stringify({ cmd: escapedSlot })],
  ] as const) {
    const output = redactDistillationText(value);
    expect(output).toBe(expected);
    expect(output).not.toContain('hunter2');
    expect(redactDistillationText(output)).toBe(output);
  }
  for (const clean of [
    'Output:\n{"status":"retry","status":"success"}',
    `{"cmd":"ok","cmd":${JSON.stringify(escapedSlot)}}`,
  ]) {
    expect(redactDistillationText(clean)).toBe(clean);
  }
  // The members a nested duplicate-key document keeps are judged in the same pass, so a chain deeper
  // than the step limit is still redacted rather than replaced outright.
  let chain = escapedSecret;
  let expected = escapedSlot;
  for (let level = 0; level < 8; level += 1) {
    chain = `{"c":"ok","c":${JSON.stringify(chain)}}`;
    expected = JSON.stringify({ c: expected });
  }
  const output = redactDistillationText(`Output:\n${chain}`);
  expect(output).toBe(`Output:\n${expected}`);
  expect(redactDistillationText(output)).toBe(output);
});

test('a long chain of nested duplicate-key documents judges each member once', () => {
  // Each level judges its members to find them unclean and again in its kept form; without remembering
  // the first judgement the work doubles per level and the pass runs out of budget.
  const pad = ' '.repeat(100_000);
  for (const [inner, judged] of [
    [
      JSON.stringify({ p: pad, args: JSON.stringify({ password: 'hunter2' }) }),
      JSON.stringify({ p: pad, args: '{"password": "[REDACTED]"}' }),
    ],
    [`[${'['.repeat(256)}${pad}${']'.repeat(256)}]`, DISTILLATION_TOO_DEEP_MARKER],
  ] as const) {
    let chain: string = inner;
    let expected: string = judged;
    for (let level = 0; level < 12; level += 1) {
      chain = `{"a":1,"a":${JSON.stringify(chain)}}`;
      expected = JSON.stringify({ a: expected });
    }
    const started = performance.now();
    const output = redactDistillationText(`Output:\n${chain}`);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(output).toBe(`Output:\n${expected}`);
    expect(redactDistillationText(output)).toBe(output);
  }
});

test('redacted envelopes and the quotes taken from them stay fixed points', () => {
  for (const value of [
    `Final output:\n${escapedSlot}`,
    escapedSlot,
    String.raw`"args":"{\"password\": \"[REDACTED]\"}"`,
    String.raw`{\"password\": \"[REDACTED]\"}`,
    'Output:\n{"my.token":"[REDACTED]"}',
    JSON.stringify({ args: JSON.stringify({ x: '{"password": "[REDACTED]"}' }) }),
    JSON.stringify({ output: `Final output:\n${escapedSlot}` }),
  ]) {
    expect(redactDistillationText(value)).toBe(value);
  }
});

test('envelopes the raw-text rules already settle keep their exact output', () => {
  for (const [value, expected] of [
    ['Output:\n{"ok":true,"n":1.0}', 'Output:\n{"ok":true,"n":1.0}'],
    [
      `Output:\n${String.raw`{"cmd":"{\"ok\":true}", "n": 1.0}`}`,
      `Output:\n${String.raw`{"cmd":"{\"ok\":true}", "n": 1.0}`}`,
    ],
    ['Output:\n{"token":"hunter2"} trailing', 'Output:\n{"token": "[REDACTED]"} trailing'],
    ['Output:\n{\n  "password": "hunter2"\n}', 'Output:\n{\n  "password": "[REDACTED]"\n}'],
    [
      'if (ready) { return [a, b]; } else { throw {code: 1}; }',
      'if (ready) { return [a, b]; } else { throw {code: 1}; }',
    ],
    [
      JSON.stringify({ cmd: 'cat <<EOF\n{"ok": true, "n": [1, 2.0]}\nEOF' }),
      JSON.stringify({ cmd: 'cat <<EOF\n{"ok": true, "n": [1, 2.0]}\nEOF' }),
    ],
  ] as const) {
    const output = redactDistillationText(value);
    expect(output).toBe(expected);
    expect(output).not.toContain('hunter2');
    expect(redactDistillationText(output)).toBe(output);
  }
});

test('embedded JSON outside the Memory domain limits is judged like any other', () => {
  const deep = (inner: string): string => `${'['.repeat(41)}${inner}${']'.repeat(41)}`;
  for (const [value, expected] of [
    [`Output:\n${deep(escapedSecret)}`, `Output:\n${deep(escapedSlot)}`],
    [`Output:\n{"${'a'.repeat(300)}":1,"x":${escapedSecret}}`, `Output:\n{"${'a'.repeat(300)}":1,"x":${escapedSlot}}`],
    [`Output:\n[${escapedSecret}${',0'.repeat(10_001)}]`, `Output:\n[${escapedSlot}${',0'.repeat(10_001)}]`],
    // A re-emitted document writes a non-finite number as JSON.stringify does.
    [`Output:\n{"n":1e400,"x":${escapedSecret}}`, `Output:\n{"n":null,"x":${escapedSlot}}`],
    [JSON.stringify({ log: deep(escapedSecret) }), JSON.stringify({ log: deep(escapedSlot) })],
  ] as const) {
    const output = redactDistillationText(value);
    expect(output).toBe(expected);
    expect(output).not.toContain('hunter2');
    expect(redactDistillationText(output)).toBe(output);
  }
  for (const value of [
    `Output:\n${deep('1')}`,
    `Output:\n{"":${escapedSlot}}`,
    `Output:\n[${',0'.repeat(10_001).slice(1)}]`,
    'Output:\n{"n":1e400,"ok":true}',
  ]) {
    expect(redactDistillationText(value)).toBe(value);
  }
});

test('pathological embedded JSON finishes within the budget as a fixed point', () => {
  let strings = 'x';
  while (strings.length < 200_000) {
    strings = JSON.stringify(strings);
  }
  for (const value of [
    '['.repeat(262_144),
    '{"a":'.repeat(52_000),
    '["x",'.repeat(52_000),
    `Output:\n${'{'.repeat(262_000)}`,
    `Output:\n${'{"a":[1,'.repeat(32_000)}`,
    `Output:\n${'{"'.repeat(87_000)}`,
    strings,
  ]) {
    const started = performance.now();
    const output = redactDistillationText(value);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(1000);
    expect(output).toBe(value);
  }
  // A document that closes past the bound fails closed in place.
  const started = performance.now();
  const output = redactDistillationText(`Output:\n${'['.repeat(131_000)}${']'.repeat(131_000)}`);
  expect(performance.now() - started).toBeLessThan(1000);
  expect(output).toBe(`Output:\n${DISTILLATION_TOO_DEEP_MARKER}`);
  expect(redactDistillationText(output)).toBe(output);
  let objects = escapedSecret;
  let expected = escapedSlot;
  while (objects.length < 200_000) {
    objects = JSON.stringify({ a: objects });
    expected = JSON.stringify({ a: expected });
  }
  const begun = performance.now();
  const chain = redactDistillationText(objects);
  const elapsed = performance.now() - begun;
  expect(elapsed).toBeLessThan(1000);
  expect(chain).toBe(expected);
  expect(redactDistillationText(chain)).toBe(chain);
});

// An escaped document printed as a JSON string literal, as jq or a logger prints it.
const printedSecret = JSON.stringify(JSON.stringify({ password: 'hunter2' }));
const printedSlot = JSON.stringify('{"password": "[REDACTED]"}');

test('escaped JSON string literals in non-JSON text are judged by the JSON pipeline', () => {
  for (const [value, expected] of [
    // The raw-text rules break the document (the value runs through its closing quote); the escaped
    // literal after it is still judged.
    [
      `Output:\n${JSON.stringify({ cmd: 'export TOKEN=abc', args: JSON.stringify({ password: 'hunter2' }) })}`,
      `Output:\n{"cmd":"export [REDACTED],"args":${printedSlot}}`,
    ],
    [`Output:\n${printedSecret}`, `Output:\n${printedSlot}`],
    [`Output:\n${printedSecret}\nexit status 0`, `Output:\n${printedSlot}\nexit status 0`],
    // A closing quote taken as an opening one pairs with the literal's opening quote; the literal is
    // still found, also when the mispaired span is itself an escaped literal.
    [`say "x" then ${printedSecret}`, `say "x" then ${printedSlot}`],
    [String.raw`width: 1" a\tb ${printedSecret}`, String.raw`width: 1" a\tb ${printedSlot}`],
    [
      `Output:\n${JSON.stringify(JSON.stringify({ args: JSON.stringify({ token: 'hunter2' }) }))} done`,
      `Output:\n${JSON.stringify(JSON.stringify({ args: '{"token": "[REDACTED]"}' }))} done`,
    ],
  ] as const) {
    const output = redactDistillationText(value);
    expect(output).toBe(expected);
    expect(output).not.toContain('hunter2');
    expect(redactDistillationText(output)).toBe(output);
  }
});

test('string literals the JSON pipeline judges clean leave the text byte-identical', () => {
  for (const value of [
    'Output:\n"plain" and "text"',
    `Output:\n${String.raw`"{\"ok\":true}"`}`,
    String.raw`dir C:\Users\"me" /s`,
    String.raw`copy "C:\Users\me" "D:\backup" and "C:\\Users\\me"`,
    `Output:\n{"cmd":"export [REDACTED],"args":${printedSlot}}`,
    `Output:\n${printedSlot}\nexit status 0`,
    printedSlot,
    String.raw`\"password\": \"[REDACTED]\"`,
    String.raw`"args":"{\"password\": \"[REDACTED]\"}"}`,
    String.raw`\"[REDACTED]\"}"`,
  ]) {
    expect(redactDistillationText(value)).toBe(value);
  }
});

test('pathological string literals finish within the budget as fixed points', () => {
  for (const value of [
    String.raw`"a\"b" `.repeat(37_449),
    String.raw`\"`.repeat(131_072),
    `${'"'.repeat(1023)}\n`.repeat(256),
    '\\'.repeat(262_144),
    `${'\\'.repeat(62)}"`.repeat(4161),
    `${'\\'.repeat(63)}"`.repeat(4096),
  ]) {
    const started = performance.now();
    const output = redactDistillationText(value);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(1000);
    expect(output).toBe(value);
  }
});

test('large documents that cannot parse, or nest past the bound, do not exhaust the budget before a trailing secret', () => {
  const tail = (secret: string): string => `\nFinal output:\n${secret}`;
  let large: unknown = { k: 1 };
  for (let level = 0; level < 40; level += 1) {
    large = { a: large, items: Array.from({ length: 200 }, (_, k) => ({ k, v: `value-${k}` })) };
  }
  for (const [head, expected] of [
    // Nested past the bound: the marker, before anything inside is read.
    [`${'['.repeat(1500)}${']'.repeat(1500)}`, DISTILLATION_TOO_DEEP_MARKER],
    [`${'{"a":'.repeat(1500)}1${'}'.repeat(1500)}`, DISTILLATION_TOO_DEEP_MARKER],
    // Truncated: never closes.
    ['{"a":['.repeat(43_000), '{"a":['.repeat(43_000)],
    // Within the bound and clean, however large.
    [JSON.stringify(large), JSON.stringify(large)],
  ] as const) {
    const started = performance.now();
    const output = redactDistillationText(`${head}${tail(escapedSecret)}`);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(1000);
    expect(output).toBe(`${expected}${tail(escapedSlot)}`);
    expect(redactDistillationText(output)).toBe(output);
  }
});

test('embedded documents within the nesting bound are judged whole, whatever their size', () => {
  // A sensitive member shows that the outer document was judged: only then does its value become the
  // placeholder.
  const deep = (arrays: number, secret: string): string => `${'['.repeat(arrays)}${secret}${']'.repeat(arrays)}`;
  const wide = (zeros: number, secret: string): string => `[${secret}${',0'.repeat(zeros)}]`;
  for (const [value, expected] of [
    // Depth 32 and 33 (the escaped string under the arrays, an object and the outer object).
    [
      `Output:\n{"my.token":1,"x":${deep(30, escapedSecret)}}`,
      `Output:\n{"my.token":"[REDACTED]","x":${deep(30, escapedSlot)}}`,
    ],
    [
      `Output:\n{"my.token":1,"x":${deep(31, escapedSecret)}}`,
      `Output:\n{"my.token":"[REDACTED]","x":${deep(31, escapedSlot)}}`,
    ],
    // 10 000 nodes, then 10 001.
    [
      `Output:\n{"my.token":1,"x":${wide(9995, escapedSecret)}}`,
      `Output:\n{"my.token":"[REDACTED]","x":${wide(9995, escapedSlot)}}`,
    ],
    [
      `Output:\n{"my.token":1,"x":${wide(9996, escapedSecret)}}`,
      `Output:\n{"my.token":"[REDACTED]","x":${wide(9996, escapedSlot)}}`,
    ],
    // A duplicate key drops the deep member; the document the parser keeps is judged, also when the
    // keys are equal only once decoded.
    [`Output:\n{"x":${deep(40, '1')},"x":1,"my.token":1}`, 'Output:\n{"x":1,"my.token":"[REDACTED]"}'],
    [`Output:\n{"\\u0078":${deep(40, '1')},"x":1,"my.token":1}`, 'Output:\n{"x":1,"my.token":"[REDACTED]"}'],
  ] as const) {
    const output = redactDistillationText(value);
    expect(output).toBe(expected);
    expect(output).not.toContain('hunter2');
    expect(redactDistillationText(output)).toBe(output);
  }
});

test('a string literal followed by a colon is judged as a key, the same as inside its document', () => {
  // The raw text escapes the credential in the key; the document's rules redact it as key text, and so do a
  // prefix cut after the key and one cut before its colon, so quotes of either output stay fixed points.
  for (const [value, expected] of [
    ['Output:\n{"https:\\/\\/u:hunter2@h\\/x":1}', 'Output:\n{"[REDACTED]h/x":1}'],
    ['Output:\n{"https:\\/\\/u:hunter2@h\\/x":1', 'Output:\n{"[REDACTED]h/x":1'],
    ['Output:\n{"https:\\/\\/u:hunter2@h\\/x"', 'Output:\n{"[REDACTED]h/x"'],
  ] as const) {
    const output = redactDistillationText(value);
    expect(output).toBe(expected);
    expect(output).not.toContain('hunter2');
    for (let end = 1; end <= output.length; end += 1) {
      const quote = output.slice(0, end);
      expect(redactDistillationText(quote)).toBe(quote);
    }
  }
  for (const [value, expected] of [
    [`Output:\n{${JSON.stringify(escapedSecret)}:1}`, `Output:\n{${JSON.stringify(escapedSlot)}:1}`],
    [`Output:\n{${JSON.stringify(escapedSecret)}:1`, `Output:\n{${JSON.stringify(escapedSlot)}:1`],
    [`Output:\n{${JSON.stringify(escapedSecret)} : 1`, `Output:\n{${JSON.stringify(escapedSlot)} : 1`],
  ] as const) {
    const output = redactDistillationText(value);
    expect(output).toBe(expected);
    expect(output).not.toContain('hunter2');
    expect(redactDistillationText(output)).toBe(output);
  }
});

test('sensitive keys are judged for embedded documents and stay sensitive', () => {
  const key = `${escapedSecret}token`;
  const redactedKey = `${escapedSlot}token`;
  const expected = JSON.stringify({ [redactedKey]: '[REDACTED]' });
  for (const [value, result] of [
    [JSON.stringify({ [key]: '[REDACTED]' }), expected],
    [`{${JSON.stringify(key)}:"[REDACTED]",${JSON.stringify(key)}:"[REDACTED]"}`, expected],
    [`Output:\n${JSON.stringify({ [key]: '[REDACTED]' })}`, `Output:\n${expected}`],
  ] as const) {
    const output = redactDistillationText(value);
    expect(output).toBe(result);
    expect(output).not.toContain('hunter2');
    expect(redactDistillationText(output)).toBe(output);
  }
  // The key keeps its sensitive ending, so its member keeps the placeholder.
  expect(redactedKey.endsWith('token')).toBe(true);
  expect(redactDistillationText(JSON.stringify(redactedKey))).toBe(JSON.stringify(redactedKey));
});

test('candidates that cannot parse are never parsed, and large clean ones are judged, before a trailing secret', () => {
  const finalSecret = '\nFinal output:\n';
  // 32 levels whose innermost one carries the defect, padded so every level spans about 125 KB.
  const padded = (defect: string, wrap: (inner: string) => string): string => {
    let document = `{"pad":"${'x'.repeat(125_000)}",${defect}}`;
    for (let level = 0; level < 31; level += 1) {
      document = wrap(document);
    }
    return document;
  };
  const nest = (inner: string): string => `{"a":${inner}}`;
  for (const [head, tail, expected] of [
    // A value after a closer without a comma.
    [
      `${'['.repeat(2000)}${']0'.repeat(2000)}`,
      '\nFinal: {"my.token":"hunter2"}',
      '\nFinal: {"my.token":"[REDACTED]"}',
    ],
    [padded('"q":1,', (inner) => `{"a":${inner},}`), `${finalSecret}${escapedSecret}`, `${finalSecret}${escapedSlot}`],
    // Outside the Memory domain limits, yet JSON: judged and left as it is.
    [padded('"":1', nest), `${finalSecret}${escapedSecret}`, `${finalSecret}${escapedSlot}`],
    [padded(`"${'k'.repeat(256)}\\u006b":1`, nest), `${finalSecret}${escapedSecret}`, `${finalSecret}${escapedSlot}`],
    [padded('"n":1e400', nest), `${finalSecret}${escapedSecret}`, `${finalSecret}${escapedSlot}`],
  ] as const) {
    const started = performance.now();
    const output = redactDistillationText(`${head}${tail}`);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(1000);
    expect(output).toBe(`${head}${expected}`);
    expect(output).not.toContain('hunter2');
    expect(redactDistillationText(output)).toBe(output);
  }
});

test('a key the nested pass leaves unchanged keeps its text at any length', () => {
  const event = `Output:\n{"${'a'.repeat(256)}\\u0062":1}`;
  for (const value of [event, JSON.stringify({ log: event })]) {
    expect(redactDistillationText(value)).toBe(value);
  }
});

test('the scan budget grows with the text, so deep string nesting does not exhaust it before a secret', () => {
  const tail = (secret: string): string => `\nFinal output:\n${secret}`;
  // Content that needs no escaping barely grows per string-nesting level, and every level reads it again.
  let codex = `[${' '.repeat(55_000)}]`;
  for (let level = 0; level < 12; level += 1) {
    codex = `{${JSON.stringify(codex)}:1}`;
  }
  // The deepest nesting that fits in 64 KiB, padded with spaces at the innermost level.
  const deepest = (wrap: (inner: string) => string): string => {
    let best = '';
    for (let levels = 1; ; levels += 1) {
      let overhead = '[]';
      for (let level = 0; level < levels; level += 1) {
        overhead = wrap(overhead);
      }
      const padding = 65_536 - 200 - overhead.length;
      if (padding < 0) {
        return best;
      }
      let head = `[${' '.repeat(padding)}]`;
      for (let level = 0; level < levels; level += 1) {
        head = wrap(head);
      }
      best = head;
    }
  };
  for (const head of [
    codex,
    deepest((inner) => `{${JSON.stringify(inner)}:1}`),
    deepest((inner) => `x ${JSON.stringify(inner)} y`),
    deepest((inner) => `{"a":${JSON.stringify(inner)}}`),
  ]) {
    const started = performance.now();
    const output = redactDistillationText(`Output:\n${head}${tail(escapedSecret)}`);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(1000);
    expect(output).toBe(`Output:\n${head}${tail(escapedSlot)}`);
    expect(output).not.toContain('hunter2');
    expect(redactDistillationText(output)).toBe(output);
  }
});

test('embedded JSON nested past the bound becomes the marker in place', () => {
  const nest = (inner: string, levels: number): string => `${'['.repeat(levels)}${inner}${']'.repeat(levels)}`;
  const marker = DISTILLATION_TOO_DEEP_MARKER;
  for (const [value, expected] of [
    // In an envelope, without and with strings inside.
    [`Output:\n${nest('', 300)} done`, `Output:\n${marker} done`],
    [`Output:\n${nest('{"password":"hunter2"}', 300)}`, `Output:\n${marker}`],
    [`Output:\n${nest('"x"', 257)}`, `Output:\n${marker}`],
    // Inside a JSON string value, as the whole string and embedded in it.
    [JSON.stringify({ log: nest('', 300) }), JSON.stringify({ log: marker })],
    [
      JSON.stringify({ log: `Output:\n${nest('{"password":"hunter2"}', 300)} done` }),
      JSON.stringify({ log: `Output:\n${marker} done` }),
    ],
    // As a JSON key, in a document and in a prefix cut after the key.
    [JSON.stringify({ [nest('', 300)]: 1 }), JSON.stringify({ [marker]: 1 })],
    [`Output:\n{${JSON.stringify(nest('', 300))}:1}`, `Output:\n{${JSON.stringify(marker)}:1}`],
    [`Output:\n{${JSON.stringify(nest('', 300))}:1`, `Output:\n{${JSON.stringify(marker)}:1`],
    // Inside an escaped string literal.
    [`Output:\n${JSON.stringify(nest('"x"', 300))}`, `Output:\n${JSON.stringify(marker)}`],
    [`Output:\n${JSON.stringify(nest('{"password":"hunter2"}', 300))} done`, `Output:\n${JSON.stringify(marker)} done`],
    // In a member a duplicate key drops, and in the one it keeps.
    [`{"cmd":${JSON.stringify(nest('', 300))},"cmd":"ok"}`, '{"cmd":"ok"}'],
    [`{"cmd":"ok","cmd":${JSON.stringify(nest('', 300))}}`, JSON.stringify({ cmd: marker })],
    // Secrets after the document are still redacted.
    [`Output:\n${nest('', 300)}\nFinal output:\n${escapedSecret}`, `Output:\n${marker}\nFinal output:\n${escapedSlot}`],
    [`Output:\n${nest('', 300)} {"password":"hunter2"}`, `Output:\n${marker} {"password": "[REDACTED]"}`],
  ] as const) {
    const output = redactDistillationText(value);
    expect(output).toBe(expected);
    expect(output).not.toContain('hunter2');
    expect(output).not.toContain('[[');
    expect(redactDistillationText(output)).toBe(output);
  }
  // The marker is a fixed point wherever it lands.
  for (const value of [JSON.stringify({ log: marker }), `Output:\n${marker} done`, JSON.stringify({ [marker]: 1 })]) {
    expect(redactDistillationText(value)).toBe(value);
  }
});

test('the nesting bound of an embedded document counts every container, including hidden members', () => {
  const nest = (inner: string, levels: number): string => `${'['.repeat(levels)}${inner}${']'.repeat(levels)}`;
  const marker = DISTILLATION_TOO_DEEP_MARKER;
  for (const [value, expected] of [
    [`Output:\n${nest('', 256)}`, `Output:\n${nest('', 256)}`],
    [`Output:\n${nest('', 257)}`, `Output:\n${marker}`],
    // The object around the arrays is a level: 255 arrays fit, 256 do not.
    [`Output:\n{"my.token":1,"x":${nest('"s"', 255)}}`, `Output:\n{"my.token":"[REDACTED]","x":${nest('"s"', 255)}}`],
    [`Output:\n{"my.token":1,"x":${nest('"s"', 256)}}`, `Output:\n${marker}`],
    // A member a duplicate key hides counts toward the bound.
    [`Output:\n{"a":${nest('', 256)},"a":1}`, `Output:\n${marker}`],
    [`Output:\n{"a":${nest('', 255)},"a":1,"my.token":1}`, 'Output:\n{"a":1,"my.token":"[REDACTED]"}'],
  ] as const) {
    const output = redactDistillationText(value);
    expect(output).toBe(expected);
    expect(redactDistillationText(output)).toBe(output);
  }
});

test('a covered output is kept only when it shows nothing the output without covering hides', () => {
  // Covered whole, the token's value leaves the truncated object unclosed, so the nested pass never judges
  // the dotted key; without covering, the value's closer closes the object, the key is judged, and the
  // value's rest stays visible. Neither output hides everything the other does, so the text fails closed.
  for (const value of [
    'Output: {"db.password":"hunter2","token":{"a":1,"b":2}',
    JSON.stringify({ out: 'Output: {"db.password":"hunter2","token":{"a":1,"b":2}' }),
  ]) {
    expect(redactDistillationText(value)).toBe('[REDACTED]');
  }
  for (const [value, expected] of [
    // Closed, the object is judged either way, and the covered output stands.
    [
      'Output: {"db.password":"hunter2","token":{"a":1,"b":2}}',
      'Output: {"db.password":"[REDACTED]","token":"[REDACTED]"}',
    ],
    // The nested pass re-emits the covered document as the member its duplicate key keeps; every run of
    // the result between placeholders is text the output without covering shows.
    [
      'Script output: {"my.token":[\n  "a",\n  {\n    "apiKey": {\n      "v": "hunter2"\n    }\n  }\n],"my.token":{"token":{"v":"hunter3"}}}\n',
      'Script output: {"my.token":"[REDACTED]"}}\n',
    ],
    [
      'Output: {"token":{"v":"hunter2"}} {"my.token":"hunter3"}',
      'Output: {"token": "[REDACTED]"}} {"my.token":"[REDACTED]"}',
    ],
  ] as const) {
    const output = redactDistillationText(value);
    expect(output).toBe(expected);
    expect(output).not.toContain('hunter');
    expect(redactDistillationText(output)).toBe(output);
  }
});

test('string nesting spelled with \\u escapes cannot grow the output past a bound', () => {
  const literal = (inner: string): string => `"${inner.replaceAll('\\', '\\u005c').replaceAll('"', '\\u0022')}"`;
  // The same through key literals of truncated objects, which only the key path of the pass reaches.
  for (const levels of [24, 32]) {
    let value = '{"db.password":"hunter2"}';
    for (let level = 0; level < levels; level += 1) {
      value = `x {${literal(value)}:1`;
    }
    const started = performance.now();
    const output = redactDistillationText(value);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(output.length).toBeLessThan(4 * value.length + 1024);
    expect(output).not.toContain('hunter2');
    expect(redactDistillationText(output)).toBe(output);
  }
  // Each level encodes the quotes and backslashes of the next as \u escapes, so the input grows linearly
  // per level while re-emission with short escapes would double per level.
  const layered = (levels: number): string => {
    let text = '{"db.password":"hunter2"}';
    for (let level = 0; level < levels; level += 1) {
      text = `"${text.replaceAll('\\', '\\u005c').replaceAll('"', '\\u0022')}"`;
    }
    return text;
  };
  for (const levels of [20, 40]) {
    const value = layered(levels);
    const started = performance.now();
    const output = redactDistillationText(value);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(output.length).toBeLessThan(4 * value.length + 1024);
    expect(output).not.toContain('hunter2');
    expect(redactDistillationText(output)).toBe(output);
  }
});

test('a covered output keeps a partly redacted value only when the other output shows that field too', () => {
  // The value's own placeholders are text, not slots: the covered output shows `hunter2` as part of the
  // password, which the output without covering hides there, so the text fails closed.
  const value =
    'Output: {"db.password":"[REDACTED]hunter2[REDACTED]","token":{"a":1,"b":"hunter2","z":{"c":1,"token":2}}';
  expect(redactDistillationText(value)).toBe('[REDACTED]');
  // Whitespace aside, a pretty-printed envelope compares with its compact re-emission.
  const pretty = 'Output: {\n  "db.password": "x",\n  "token": {\n    "a": 1\n  },\n  "b": 2\n}';
  const output = redactDistillationText(pretty);
  expect(output).toBe('Output: {"db.password":"[REDACTED]","token":"[REDACTED]","b":2}');
  expect(redactDistillationText(output)).toBe(output);
});

test('comparing a covered output costs linear time on long whitespace runs', () => {
  const value = `Output: {"token":{"a":1,"b":2}}${' '.repeat(60_000)}"x"`;
  const started = performance.now();
  const output = redactDistillationText(value);
  expect(performance.now() - started).toBeLessThan(1000);
  expect(output).toBe(`Output: {"token": "[REDACTED]"}${' '.repeat(60_000)}"x"`);
  expect(redactDistillationText(output)).toBe(output);
});

test('a credential inside a sensitive key is redacted while the key stays sensitive', () => {
  for (const [value, expected] of [
    ['Output:\n{"https:\\/\\/u:hunter2@h\\/token":"[REDACTED]"}', 'Output:\n{"[REDACTED]h/token":"[REDACTED]"}'],
    ['Output:\n{"https:\\/\\/u:hunter2@h\\/token":1', 'Output:\n{"[REDACTED]h/token":1'],
    ['Output:\n{"https:\\/\\/u:hunter2@h\\/token"', 'Output:\n{"[REDACTED]h/token"'],
  ] as const) {
    const output = redactDistillationText(value);
    expect(output).toBe(expected);
    for (let end = 1; end <= output.length; end += 1) {
      const quote = output.slice(0, end);
      expect(redactDistillationText(quote)).toBe(quote);
    }
  }
  // Names the shared rules would read as credentials themselves keep their text.
  for (const value of ['{"secret:token":"[REDACTED]"}', '{"settings.database.password":"[REDACTED]"}']) {
    expect(redactDistillationText(value)).toBe(value);
  }
});
