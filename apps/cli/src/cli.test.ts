import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';
import { parseCommand } from './cli';

describe('CLI command parsing', () => {
  test('parses quota output policy without leaking raw argv to main', () => {
    expect(Effect.runSync(parseCommand(['quota', '--no-color']))).toEqual({
      _tag: 'Quota',
      color: false,
      history: null,
    });
    expect(Effect.runSync(parseCommand(['quota', '--color']))).toEqual({
      _tag: 'Quota',
      color: true,
      history: null,
    });
  });

  test('defaults a bare quota --history to 7d and accepts every supported range', () => {
    expect(Effect.runSync(parseCommand(['quota', '--history']))).toEqual({
      _tag: 'Quota',
      color: null,
      history: '7d',
    });
    for (const range of ['24h', '7d', '30d'] as const) {
      expect(Effect.runSync(parseCommand(['quota', '--history', range]))).toEqual({
        _tag: 'Quota',
        color: null,
        history: range,
      });
    }
  });

  test('reads the token after quota --history as a flag rather than a range', () => {
    expect(Effect.runSync(parseCommand(['quota', '--history', '--color']))).toEqual({
      _tag: 'Quota',
      color: true,
      history: '7d',
    });
  });

  test('rejects an unsupported quota history range', () => {
    const error = Effect.runSync(Effect.flip(parseCommand(['quota', '--history', '90d'])));

    expect(error.message).toBe('Unknown quota history range: 90d (expected 24h, 7d, or 30d)');
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

  test('makes stored report reads explicit without changing the fresh default', () => {
    expect(Effect.runSync(parseCommand([]))).toMatchObject({
      _tag: 'Report',
      args: { stored: false },
    });
    expect(Effect.runSync(parseCommand(['report', '--stored', '--json']))).toMatchObject({
      _tag: 'Report',
      args: { format: 'json', stored: true },
    });
    expect(Effect.runSync(Effect.flip(parseCommand(['merge', 'mac.json', '--stored']))).message).toBe(
      'Unknown option for merge: --stored',
    );
  });

  test('parses payload JSON as an exclusive output format and rejects HTML', () => {
    expect(Effect.runSync(parseCommand(['--payload-json']))).toMatchObject({
      _tag: 'Report',
      args: { format: 'payload' },
    });

    expect(Effect.runSync(Effect.flip(parseCommand(['--html']))).message).toBe('Unknown option: --html');
    expect(Effect.runSync(Effect.flip(parseCommand(['merge', 'mac.json', '--html']))).message).toBe(
      'Unknown option for merge: --html',
    );
  });

  test('parses snapshot export command', () => {
    expect(Effect.runSync(parseCommand(['snapshot', '--out', 'usage.json', '--harness', 'codex']))).toEqual({
      _tag: 'Snapshot',
      args: { out: 'usage.json', harness: 'codex', cursor: true },
    });
  });

  test('parses merge command with files and local rows', () => {
    expect(
      Effect.runSync(parseCommand(['merge', 'mac.json', '--local', '--payload-json', '--since', '30d'])),
    ).toMatchObject({
      _tag: 'Merge',
      args: { files: ['mac.json'], local: true, format: 'payload' },
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

  test('parses bounded Memory search modes and scope', () => {
    expect(
      Effect.runSync(
        parseCommand([
          'memory',
          'search',
          'SQLITE_BUSY: database is locked',
          '--literal',
          '--project',
          '0198f179-4837-7000-8000-000000000020',
          '--include-space-wide',
          '--limit',
          '25',
          '--json',
        ]),
      ),
    ).toEqual({
      _tag: 'MemorySearch',
      args: {
        cursor: null,
        includeSpaceWide: true,
        json: true,
        limit: 25,
        matchingMode: 'literal',
        projectId: '0198f179-4837-7000-8000-000000000020',
        query: 'SQLITE_BUSY: database is locked',
      },
    });
  });

  test('rejects unsafe or ambiguous Memory search arguments', () => {
    expect(Effect.runSync(Effect.flip(parseCommand(['memory', 'search']))).message).toBe(
      'memory search expects a query',
    );
    expect(Effect.runSync(Effect.flip(parseCommand(['memory', 'search', 'one', 'two']))).message).toBe(
      'memory search expects one quoted query',
    );
    expect(
      Effect.runSync(Effect.flip(parseCommand(['memory', 'search', 'query', '--include-space-wide']))).message,
    ).toBe('--include-space-wide requires --project');
    expect(Effect.runSync(Effect.flip(parseCommand(['memory', 'search', 'query', '--limit', '26']))).message).toBe(
      '--limit expects an integer from 1 to 25',
    );
  });

  test('parses Cursor import command', () => {
    expect(Effect.runSync(parseCommand(['cursor', 'import', '/tmp/export.csv']))).toEqual({
      _tag: 'CursorImport',
      args: { file: '/tmp/export.csv' },
    });
  });

  test('parses replication status output and rejects mutations', () => {
    expect(Effect.runSync(parseCommand(['replication', 'status']))).toEqual({
      _tag: 'ReplicationStatus',
      args: { json: false },
    });
    expect(Effect.runSync(parseCommand(['replication', 'status', '--json']))).toEqual({
      _tag: 'ReplicationStatus',
      args: { json: true },
    });
    expect(Effect.runSync(Effect.flip(parseCommand(['replication', 'status', '--reset']))).message).toBe(
      'Unknown option for replication status: --reset',
    );
    expect(Effect.runSync(Effect.flip(parseCommand(['replication', 'repair']))).message).toBe(
      'Unknown replication subcommand: repair',
    );
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
    expect(Effect.runSync(parseCommand(['setup', '--local', '--port', '0']))).toEqual({
      _tag: 'Setup',
      args: { files: [], local: true, port: 0 },
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
