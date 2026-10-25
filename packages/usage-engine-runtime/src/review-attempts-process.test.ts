import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createProcessTableScanner } from './review-attempts-process';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const MARKER = '6f1c1d4e-2b3a-4c5d-8e9f-0a1b2c3d4e5f';
const SELF = 4100;

/** A fake `/proc`: one directory per pid with its NUL-separated argument vector. */
const procTree = async (processes: Readonly<Record<number, readonly string[]>>): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'review-process-table-'));
  roots.push(root);
  for (const [pid, argv] of Object.entries(processes)) {
    await mkdir(path.join(root, pid));
    await writeFile(path.join(root, pid, 'cmdline'), `${argv.join('\0')}\0`);
  }
  return root;
};

const psListing = (rows: readonly (readonly [number, string])[]): string =>
  rows.map(([pid, command]) => `${String(pid).padStart(7)} ${command}`).join('\n');

describe('review process scan (ADR 0055)', () => {
  test('on Linux reads the argument vectors and finds the marker or proves it absent', async () => {
    const procRoot = await procTree({
      [SELF]: ['bun', 'usage-engine'],
      4242: ['claude', '-p', 'prompt', '--session-id', MARKER],
      4300: ['vim', 'notes.txt'],
    });
    const scan = createProcessTableScanner({ platform: 'linux', procRoot, selfPid: SELF });
    expect(await scan(MARKER)).toEqual({ kind: 'found', pids: [4242] });
    expect(await scan('00000000-0000-4000-8000-000000000000')).toEqual({ kind: 'absent' });
  });

  test('a table that does not show this engine itself cannot prove an absence', async () => {
    // A hidepid mount or another PID namespace: processes are listed, but not all of them.
    const procRoot = await procTree({ 4300: ['vim', 'notes.txt'] });
    const scan = createProcessTableScanner({ platform: 'linux', procRoot, selfPid: SELF });
    const result = await scan(MARKER);
    expect(result.kind).toBe('unavailable');
    expect(result.kind === 'unavailable' ? result.reason : '').toContain('does not show this engine');
  });

  test('without /proc (macOS) lists processes with ps and still requires seeing itself', async () => {
    const listings: string[] = [];
    const ps = (listing: string) => () => {
      listings.push(listing);
      return Promise.resolve(listing);
    };
    const found = createProcessTableScanner({
      listProcesses: ps(
        psListing([
          [SELF, '/usr/local/bin/bun usage-engine'],
          [4242, `/usr/local/bin/claude -p Read-only review --session-id ${MARKER} --safe-mode`],
        ]),
      ),
      platform: 'darwin',
      selfPid: SELF,
    });
    expect(await found(MARKER)).toEqual({ kind: 'found', pids: [4242] });
    const absent = createProcessTableScanner({
      listProcesses: ps(psListing([[SELF, '/usr/local/bin/bun usage-engine']])),
      platform: 'darwin',
      selfPid: SELF,
    });
    expect(await absent(MARKER)).toEqual({ kind: 'absent' });
    // A marker that is only a prefix of another argument is not the marker.
    const prefix = createProcessTableScanner({
      listProcesses: ps(
        psListing([
          [SELF, 'bun usage-engine'],
          [4242, `claude --session-id ${MARKER}-other`],
        ]),
      ),
      platform: 'darwin',
      selfPid: SELF,
    });
    expect(await prefix(MARKER)).toEqual({ kind: 'absent' });
    const blind = createProcessTableScanner({
      listProcesses: ps(psListing([[4242, 'claude --version']])),
      platform: 'darwin',
      selfPid: SELF,
    });
    expect((await blind(MARKER)).kind).toBe('unavailable');
    const failing = createProcessTableScanner({
      listProcesses: () => Promise.reject(new Error('ps unavailable')),
      platform: 'darwin',
      selfPid: SELF,
    });
    expect(await failing(MARKER)).toMatchObject({ kind: 'unavailable' });
    expect(listings).toHaveLength(4);
  });

  test('falls back to ps on Linux when /proc cannot be read', async () => {
    const scan = createProcessTableScanner({
      listProcesses: () =>
        Promise.resolve(
          psListing([
            [SELF, 'bun usage-engine'],
            [4242, `claude --session-id ${MARKER}`],
          ]),
        ),
      platform: 'linux',
      procRoot: '/nonexistent-proc-root',
      selfPid: SELF,
    });
    expect(await scan(MARKER)).toEqual({ kind: 'found', pids: [4242] });
  });

  test('the real process table of this machine shows this test process', async () => {
    const scan = createProcessTableScanner();
    expect(await scan('00000000-0000-4000-8000-000000000000')).toEqual({ kind: 'absent' });
  });
});
