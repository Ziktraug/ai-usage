import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';
import { parseCommand } from './cli';
import { applyPullTokenEnvOverride } from './sync';

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

  test('parses setup web command', () => {
    expect(Effect.runSync(parseCommand(['setup', '--local', '--port', '8080']))).toEqual({
      _tag: 'Setup',
      args: { files: [], local: true, port: 8080 },
    });
  });

  test('parses serve command with defaults', () => {
    expect(Effect.runSync(parseCommand(['serve']))).toEqual({
      _tag: 'Serve',
      args: { host: 'localhost', port: 3847, token: null, harness: null, cursor: true },
    });
  });

  test('parses serve command with LAN options', () => {
    expect(Effect.runSync(parseCommand(['serve', '--host', '0.0.0.0', '--port', '9999', '--token', 's3cret']))).toEqual(
      {
        _tag: 'Serve',
        args: { host: '0.0.0.0', port: 9999, token: 's3cret', harness: null, cursor: true },
      },
    );
  });

  test('serve rejects LAN binding without token', () => {
    const error = Effect.runSync(Effect.flip(parseCommand(['serve', '--host', '0.0.0.0'])));
    expect(error.message).toBe('serve requires --token when binding outside localhost');
  });

  test('parses merge --remote', () => {
    expect(
      Effect.runSync(parseCommand(['merge', '--remote', 'http://mac:3847/snapshot', '--token', 'abc', '--local'])),
    ).toMatchObject({
      _tag: 'Merge',
      args: { remote: ['http://mac:3847/snapshot'], token: 'abc', local: true },
    });
  });

  test('merge rejects no input', () => {
    const error = Effect.runSync(Effect.flip(parseCommand(['merge'])));
    expect(error.message).toBe('merge expects files, --remote, or --local');
  });

  test('parses sync commands', () => {
    expect(
      Effect.runSync(
        parseCommand([
          'sync',
          'add',
          'macbook',
          'http://192.168.1.63:3847/snapshot',
          '--token-env',
          'AI_USAGE_SYNC_MACBOOK_TOKEN',
        ]),
      ),
    ).toEqual({
      _tag: 'Sync',
      args: {
        action: 'add',
        name: 'macbook',
        url: 'http://192.168.1.63:3847/snapshot',
        tokenEnv: 'AI_USAGE_SYNC_MACBOOK_TOKEN',
      },
    });
    expect(Effect.runSync(parseCommand(['sync', 'pull', 'macbook']))).toEqual({
      _tag: 'Sync',
      args: { action: 'pull', name: 'macbook', all: false, remote: null, tokenEnv: null },
    });
    expect(Effect.runSync(parseCommand(['sync', 'pull', 'macbook', '--token-env', 'AI_USAGE_SYNC_TOKEN']))).toEqual({
      _tag: 'Sync',
      args: { action: 'pull', name: 'macbook', all: false, remote: null, tokenEnv: 'AI_USAGE_SYNC_TOKEN' },
    });
    expect(Effect.runSync(parseCommand(['sync', 'watch', '--all', '--interval', '60s']))).toEqual({
      _tag: 'Sync',
      args: { action: 'watch', name: null, all: true, intervalMs: 60_000 },
    });
  });

  test('sync pull token env overrides configured remotes without mutating storage shape', () => {
    expect(
      applyPullTokenEnvOverride([{ name: 'macbook', url: 'http://mac:3847/snapshot' }], 'AI_USAGE_SYNC_TOKEN'),
    ).toEqual([{ name: 'macbook', url: 'http://mac:3847/snapshot', tokenEnv: 'AI_USAGE_SYNC_TOKEN' }]);
    expect(
      applyPullTokenEnvOverride(
        [{ name: 'macbook', url: 'http://mac:3847/snapshot', tokenEnv: 'CONFIGURED_TOKEN' }],
        'AI_USAGE_SYNC_TOKEN',
      ),
    ).toEqual([{ name: 'macbook', url: 'http://mac:3847/snapshot', tokenEnv: 'AI_USAGE_SYNC_TOKEN' }]);
  });

  test('sync watch rejects too-small intervals', () => {
    const error = Effect.runSync(Effect.flip(parseCommand(['sync', 'watch', '--interval', '5s'])));
    expect(error.message).toBe('sync watch --interval must be at least 30s');
  });
});
