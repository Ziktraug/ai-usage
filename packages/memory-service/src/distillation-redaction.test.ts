import { expect, test } from 'bun:test';
import { redactDistillationText } from './distillation-redaction';

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
