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

    expect(Effect.runSync(parseCommand(['--payload-json']))).toMatchObject({
      _tag: 'Report',
      args: { format: 'payload' },
    });

    const error = Effect.runSync(Effect.flip(parseCommand(['--csv', '--html'])));
    expect(error.message).toBe('--json, --csv, --html, and --payload-json are mutually exclusive');
  });

  test('parses snapshot export command', () => {
    expect(Effect.runSync(parseCommand(['snapshot', '--out', 'usage.json', '--harness', 'codex']))).toEqual({
      _tag: 'Snapshot',
      args: { out: 'usage.json', harness: 'codex', cursor: true },
    });
  });

  test('parses merge command with files and local rows', () => {
    expect(Effect.runSync(parseCommand(['merge', 'mac.json', '--local', '--html', '--since', '30d']))).toMatchObject({
      _tag: 'Merge',
      args: { files: ['mac.json'], local: true, format: 'html' },
    });
  });

  test('parses machine commands', () => {
    expect(Effect.runSync(parseCommand(['machine']))).toEqual({ _tag: 'Machine' });
    expect(Effect.runSync(parseCommand(['machine', 'set-label', 'MacBook Pro']))).toEqual({
      _tag: 'MachineSetLabel',
      label: 'MacBook Pro',
    });
  });

  test('parses project source discovery', () => {
    expect(Effect.runSync(parseCommand(['projects', 'list', '--paths', 'mac.json', '--local']))).toEqual({
      _tag: 'ProjectsList',
      args: { files: ['mac.json'], local: true, paths: true },
    });
  });

  test('parses Cursor import command', () => {
    expect(Effect.runSync(parseCommand(['cursor', 'import', '/tmp/export.csv']))).toEqual({
      _tag: 'CursorImport',
      args: { file: '/tmp/export.csv' },
    });
  });

  test('parses setup with file inputs and local collection', () => {
    expect(Effect.runSync(parseCommand(['setup', 'mac.json', 'team.json']))).toEqual({
      _tag: 'Setup',
      args: { files: ['mac.json', 'team.json'], local: false, port: 3456 },
    });
    expect(Effect.runSync(parseCommand(['setup', '--local', '--port', '8080']))).toEqual({
      _tag: 'Setup',
      args: { files: [], local: true, port: 8080 },
    });
  });

  test('rejects the stale setup --web spelling', () => {
    const error = Effect.runSync(Effect.flip(parseCommand(['setup', '--web'])));

    expect(error.message).toBe('Unknown option for setup: --web');
  });

  test('merge rejects no input', () => {
    const error = Effect.runSync(Effect.flip(parseCommand(['merge'])));
    expect(error.message).toBe('merge expects files or --local');
  });

  test('rejects retired LAN commands and merge options', () => {
    expect(Effect.runSync(Effect.flip(parseCommand(['serve']))).message).toBe('Unknown option: serve');
    expect(Effect.runSync(Effect.flip(parseCommand(['sync']))).message).toBe('Unknown option: sync');
    expect(Effect.runSync(Effect.flip(parseCommand(['merge', '--remote', 'http://mac:3847/snapshot']))).message).toBe(
      'Unknown option for merge: --remote',
    );
    expect(Effect.runSync(Effect.flip(parseCommand(['merge', '--token', 'secret']))).message).toBe(
      'Unknown option for merge: --token',
    );
  });
});
