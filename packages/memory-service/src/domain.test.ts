import { describe, expect, test } from 'bun:test';
import { type MemoryJsonValue, parseMemoryJsonValue, stableMemoryJson } from './domain';
import { redactMemoryValue } from './redaction';

// Built through JSON.parse: an object literal with a "__proto__" key sets the prototype instead of
// creating an own property, so only a parsed document carries the key the way persisted JSON does.
const withProtoKey = (): unknown => JSON.parse('{"__proto__":42,"kept":"ok"}');

describe('Memory JSON values', () => {
  test('keeps a "__proto__" key as an own property through validation, normalization, and redaction', () => {
    const parsed = parseMemoryJsonValue(withProtoKey());
    expect(Object.hasOwn(parsed as object, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(JSON.stringify(parsed)).toBe('{"__proto__":42,"kept":"ok"}');
    expect(stableMemoryJson(parsed)).toBe('{"__proto__":42,"kept":"ok"}');
    expect(stableMemoryJson(parsed)).not.toBe(stableMemoryJson({ kept: 'ok' }));

    const nested = parseMemoryJsonValue(JSON.parse('{"outer":{"__proto__":{"inner":true}}}'));
    expect(JSON.stringify(nested)).toBe('{"outer":{"__proto__":{"inner":true}}}');

    const redacted = redactMemoryValue(parsed, 'normal');
    expect(redacted.redacted).toBe(false);
    expect(JSON.stringify(redacted.value)).toBe('{"__proto__":42,"kept":"ok"}');
    const redactedSecret = redactMemoryValue(
      parseMemoryJsonValue(JSON.parse('{"__proto__":"x","token":"abc"}')) as MemoryJsonValue,
      'normal',
    );
    expect(JSON.stringify(redactedSecret.value)).toBe('{"__proto__":"x","token":"[REDACTED]"}');
  });
});
