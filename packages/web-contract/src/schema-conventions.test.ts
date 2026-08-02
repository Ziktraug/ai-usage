import { describe, expect, test } from 'bun:test';
import { safeParse } from 'valibot';
import {
  emptyInputSchema,
  isJsonWireValue,
  jsonWireValueSchema,
  publicMessageSchema,
  publicReasonSchema,
} from './schema-conventions';

describe('contract schema conventions', () => {
  test('accepts exact finite JSON values without changing their serialization', () => {
    const value = {
      active: true,
      count: 3,
      nested: [
        { id: 'a', value: null },
        { id: 'b', value: 1.5 },
      ],
    } as const;

    const result = safeParse(jsonWireValueSchema, value);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(JSON.stringify(result.output)).toBe(JSON.stringify(value));
    }
    expect(isJsonWireValue(value)).toBe(true);
  });

  test('rejects non-JSON numbers, values, cycles, sparse arrays, files, and runtime objects', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const sparse: unknown[] = [];
    sparse.length = 2;
    const cases: readonly unknown[] = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      undefined,
      1n,
      cyclic,
      sparse,
      new Date('2026-08-02T00:00:00.000Z'),
      new Blob(['private bytes']),
      new Response('private response'),
      new ReadableStream(),
      new Uint8Array([1, 2, 3]),
    ];

    for (const value of cases) {
      expect(safeParse(jsonWireValueSchema, value).success).toBe(false);
      expect(isJsonWireValue(value)).toBe(false);
    }
  });

  test('rejects accessors and symbol-keyed data instead of invoking or dropping them', () => {
    let reads = 0;
    const accessor = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get: () => {
        reads += 1;
        return 'private';
      },
    });
    const symbolKeyed = { [Symbol('secret')]: 'private' };

    expect(safeParse(jsonWireValueSchema, accessor).success).toBe(false);
    expect(safeParse(jsonWireValueSchema, symbolKeyed).success).toBe(false);
    expect(reads).toBe(0);
  });

  test('keeps empty inputs closed and public text bounded', () => {
    expect(safeParse(emptyInputSchema, {}).success).toBe(true);
    expect(safeParse(emptyInputSchema, { ignored: true }).success).toBe(false);
    expect(safeParse(publicMessageSchema, 'A stable public message.').success).toBe(true);
    expect(safeParse(publicMessageSchema, '').success).toBe(false);
    expect(safeParse(publicMessageSchema, 'x'.repeat(513)).success).toBe(false);
    expect(safeParse(publicReasonSchema, 'revision-expired').success).toBe(true);
    expect(safeParse(publicReasonSchema, '/private/path').success).toBe(false);
  });
});
