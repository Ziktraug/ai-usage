import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';
import { type CliCommand, helpText, parseCommand, type QuotaArgs } from './cli';

const quotaCommand = (overrides: Partial<QuotaArgs> = {}): CliCommand => ({
  _tag: 'Quota',
  color: null,
  history: null,
  json: false,
  stored: false,
  ...overrides,
});

describe('CLI command parsing', () => {
  test('parses quota output policy without leaking raw argv to main', () => {
    expect(Effect.runSync(parseCommand(['quota', '--no-color']))).toEqual(quotaCommand({ color: false }));
    expect(Effect.runSync(parseCommand(['quota', '--color']))).toEqual(quotaCommand({ color: true }));
  });

  test('defaults a bare quota --history to 7d and accepts every supported range', () => {
    expect(Effect.runSync(parseCommand(['quota', '--history']))).toEqual(quotaCommand({ history: '7d' }));
    for (const range of ['24h', '7d', '30d'] as const) {
      expect(Effect.runSync(parseCommand(['quota', '--history', range]))).toEqual(quotaCommand({ history: range }));
    }
  });

  test('reads the token after quota --history as a flag rather than a range', () => {
    expect(Effect.runSync(parseCommand(['quota', '--history', '--color']))).toEqual(
      quotaCommand({ color: true, history: '7d' }),
    );
  });

  test('rejects an unsupported quota history range', () => {
    const error = Effect.runSync(Effect.flip(parseCommand(['quota', '--history', '90d'])));

    expect(error.message).toBe('Unknown quota history range: 90d (expected 24h, 7d, or 30d)');
  });

  test('rejects unknown quota options as typed Effect failures', () => {
    const error = Effect.runSync(Effect.flip(parseCommand(['quota', '--wide'])));

    expect(error.message).toBe('Unknown option for quota: --wide');
  });

  test('parses the stored quota read and the JSON feed independently and together', () => {
    expect(Effect.runSync(parseCommand(['quota', '--stored']))).toEqual(quotaCommand({ stored: true }));
    expect(Effect.runSync(parseCommand(['quota', '--json']))).toEqual(quotaCommand({ json: true }));
    expect(Effect.runSync(parseCommand(['quota', '--stored', '--json']))).toEqual(
      quotaCommand({ json: true, stored: true }),
    );
    expect(Effect.runSync(parseCommand(['quota', '--json', '--stored']))).toEqual(
      quotaCommand({ json: true, stored: true }),
    );
  });

  test('accepts a colour policy beside the quota JSON feed, as report --json does', () => {
    expect(Effect.runSync(parseCommand(['quota', '--json', '--no-color']))).toEqual(
      quotaCommand({ color: false, json: true }),
    );
    expect(Effect.runSync(parseCommand(['quota', '--stored', '--json', '--color']))).toEqual(
      quotaCommand({ color: true, json: true, stored: true }),
    );
  });

  test('rejects quota --history combined with the JSON feed or the stored read as typed failures', () => {
    const cases = [
      { argv: ['quota', '--history', '--json'], flag: '--json' },
      { argv: ['quota', '--json', '--history', '24h'], flag: '--json' },
      { argv: ['quota', '--history', '30d', '--stored'], flag: '--stored' },
      { argv: ['quota', '--stored', '--history'], flag: '--stored' },
      { argv: ['quota', '--history', '--stored', '--json'], flag: '--json' },
    ] as const;
    for (const { argv, flag } of cases) {
      const error = Effect.runSync(Effect.flip(parseCommand([...argv])));

      expect(error._tag).toBe('CliArgumentError');
      expect(error.message).toStartWith(`quota --history cannot be combined with ${flag}`);
    }
  });

  test('still rejects report-only flags on quota', () => {
    for (const flag of ['--csv', '--payload-json', '--harness']) {
      const error = Effect.runSync(Effect.flip(parseCommand(['quota', '--stored', '--json', flag])));

      expect(error.message).toBe(`Unknown option for quota: ${flag}`);
    }
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

  test('parses work context with exactly one scope and rejects anything else', () => {
    expect(Effect.runSync(parseCommand(['work', 'context', '--checkout', '.', '--json']))).toEqual({
      _tag: 'WorkContext',
      args: { json: true, scope: { checkoutPath: '.', kind: 'checkout' } },
    });
    expect(Effect.runSync(parseCommand(['work', 'context', '--project-label', 'ai-usage']))).toEqual({
      _tag: 'WorkContext',
      args: { json: false, scope: { kind: 'project-label', projectLabel: 'ai-usage' } },
    });
    const failure = (argv: string[]) => Effect.runSync(Effect.flip(parseCommand(argv))).message;
    expect(failure(['work', 'context'])).toBe('work context expects exactly one of --checkout or --project-label');
    expect(failure(['work', 'context', '--checkout', '/a', '--project-label', 'b'])).toBe(
      'work context expects exactly one of --checkout or --project-label',
    );
    expect(failure(['work', 'context', '--checkout'])).toBe('--checkout expects a value');
    expect(failure(['work', 'context', '--checkout', '/a', '--refresh'])).toBe(
      'Unknown option for work context: --refresh',
    );
    expect(failure(['work', 'attention'])).toBe('Unknown work subcommand: attention');
    expect(failure(['work'])).toBe('Unknown work subcommand:');
  });

  test('parses the delegation subcommands with their flags', () => {
    const jobId = '7d5a1b2c-3e4f-4a5b-8c6d-7e8f9a0b1c2d';
    const qualificationId = '0c1d2e3f-4a5b-4c6d-8e9f-a0b1c2d3e4f5';
    expect(Effect.runSync(parseCommand(['delegation', 'qualify', '--request', 'review.json']))).toEqual({
      _tag: 'DelegationQualify',
      args: { json: false, request: 'review.json', simulation: false },
    });
    expect(Effect.runSync(parseCommand(['delegation', 'qualify', '--request', '-', '--simulation', '--json']))).toEqual(
      {
        _tag: 'DelegationQualify',
        args: { json: true, request: '-', simulation: true },
      },
    );
    expect(
      Effect.runSync(
        parseCommand([
          'delegation',
          'start',
          '--request',
          'review.json',
          '--qualification',
          qualificationId,
          '--route',
          'route-a',
          '--confidence',
          '0.8',
          '--key',
          'cli:review-7',
        ]),
      ),
    ).toEqual({
      _tag: 'DelegationStart',
      args: {
        json: false,
        key: 'cli:review-7',
        qualification: qualificationId,
        request: 'review.json',
        selection: { confidence: 0.8, kind: 'route', routeId: 'route-a', selectorVersion: 'operator/ai-usage-cli' },
      },
    });
    expect(
      Effect.runSync(
        parseCommand([
          'delegation',
          'start',
          '--request',
          '-',
          '--qualification',
          qualificationId,
          '--abstain',
          'keep-with-caller',
          '--key',
          'cli:review-8',
          '--json',
        ]),
      ),
    ).toEqual({
      _tag: 'DelegationStart',
      args: {
        json: true,
        key: 'cli:review-8',
        qualification: qualificationId,
        request: '-',
        selection: { kind: 'abstain', reason: 'keep-with-caller' },
      },
    });
    expect(Effect.runSync(parseCommand(['delegation', 'status', jobId]))).toEqual({
      _tag: 'DelegationStatus',
      args: { jobId, json: false },
    });
    expect(Effect.runSync(parseCommand(['delegation', 'cancel', jobId, '--json']))).toEqual({
      _tag: 'DelegationCancel',
      args: { jobId, json: true },
    });
    expect(Effect.runSync(parseCommand(['delegation', 'list']))).toEqual({
      _tag: 'DelegationList',
      args: { json: false, limit: null, live: false },
    });
    expect(Effect.runSync(parseCommand(['delegation', 'list', '--live', '--limit', '5', '--json']))).toEqual({
      _tag: 'DelegationList',
      args: { json: true, limit: 5, live: true },
    });
  });

  test('rejects delegation arguments that the engine would refuse later, before any process runs', () => {
    const qualificationId = '0c1d2e3f-4a5b-4c6d-8e9f-a0b1c2d3e4f5';
    const failure = (argv: string[]) => Effect.runSync(Effect.flip(parseCommand(argv))).message;
    expect(failure(['delegation'])).toBe('Unknown delegation subcommand:');
    expect(failure(['delegation', 'evaluate'])).toBe('Unknown delegation subcommand: evaluate');
    expect(failure(['delegation', 'qualify'])).toBe('delegation qualify expects --request <file|->');
    expect(failure(['delegation', 'qualify', '--request', 'r.json', '--route', 'x'])).toBe(
      'Unknown option for delegation qualify: --route',
    );
    expect(failure(['delegation', 'start', '--request', 'r.json', '--route', 'route-a'])).toBe(
      'delegation start expects --request <file|->, --qualification <id> and --key <idempotency-key>',
    );
    const base = [
      'delegation',
      'start',
      '--request',
      'r.json',
      '--qualification',
      qualificationId,
      '--key',
      'cli:review-7',
    ];
    expect(failure(base)).toBe('delegation start expects exactly one of --route <id> or --abstain <reason>');
    expect(failure([...base, '--route', 'a', '--abstain', 'keep-with-caller'])).toBe(
      'delegation start expects exactly one of --route <id> or --abstain <reason>',
    );
    expect(failure([...base, '--abstain', 'because'])).toBe(
      '--abstain expects one of: keep-with-caller, no-suitable-route, insufficient-confidence, task-unsuitable',
    );
    expect(failure([...base, '--abstain', 'task-unsuitable', '--confidence', '0.5'])).toBe(
      '--selector-version and --confidence describe a route choice; they cannot accompany --abstain',
    );
    expect(failure([...base, '--route', 'a', '--confidence', '1.5'])).toBe('--confidence expects a number from 0 to 1');
    expect(
      failure(['delegation', 'start', '--request', 'r.json', '--qualification', 'Q-1', '--key', 'cli:review-7']),
    ).toBe('--qualification expects the lowercase UUID of a qualification');
    expect(
      failure(['delegation', 'start', '--request', 'r.json', '--qualification', qualificationId, '--key', 'short']),
    ).toBe('--key expects 8 to 128 characters of letters, digits, dots, underscores, colons or dashes');
    expect(failure(['delegation', 'status'])).toBe('delegation status expects a job id');
    expect(failure(['delegation', 'status', 'JOB-7'])).toBe('delegation status expects the lowercase UUID of a job');
    expect(failure(['delegation', 'cancel', qualificationId, '--force'])).toBe(
      'Unknown option for delegation cancel: --force',
    );
    expect(failure(['delegation', 'list', '--limit', '51'])).toBe('--limit expects an integer from 1 to 50');
    expect(failure(['delegation', 'list', '--all'])).toBe('Unknown option for delegation list: --all');
  });

  test('rejects the retired setup command and no longer documents it', () => {
    expect(Effect.runSync(Effect.flip(parseCommand(['setup', '--local']))).message).toBe('Unknown option: setup');
    expect(helpText).not.toContain('setup');
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
