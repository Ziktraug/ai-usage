import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';
import { parseCommand } from './cli';

describe('CLI command parsing', () => {
  test('parses quota output policy without leaking raw argv to main', () => {
    expect(Effect.runSync(parseCommand(['quota', '--no-color']))).toEqual({
      _tag: 'Quota',
      color: false,
    });
    expect(Effect.runSync(parseCommand(['quota', '--color']))).toEqual({
      _tag: 'Quota',
      color: true,
    });
  });

  test('rejects unknown quota options as typed Effect failures', () => {
    const error = Effect.runSync(Effect.flip(parseCommand(['quota', '--wide'])));

    expect(error.message).toBe('Unknown option for quota: --wide');
  });

  test('parses harness keys from metadata', () => {
    expect(Effect.runSync(parseCommand(['--harness', 'cursor']))).toMatchObject({
      _tag: 'Report',
      args: { harness: 'cursor' },
    });
  });

  test('parses html as an exclusive output format', () => {
    expect(Effect.runSync(parseCommand(['--html']))).toMatchObject({
      _tag: 'Report',
      args: { format: 'html' },
    });

    const error = Effect.runSync(Effect.flip(parseCommand(['--csv', '--html'])));
    expect(error.message).toBe('--json, --csv, and --html are mutually exclusive');
  });
});
