import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { executeBoundedProcess } from '@ai-usage/local-machine/bounded-process';

/**
 * Process evidence for a lost review attempt (ADR 0055). The engine records, before any spawn, the
 * session id it passes to the harness as `--session-id`; the launched process carries it in its
 * argument vector for its whole life. Looking for that pair answers "does the harness process this
 * attempt started still run?" without trusting a pid (pids are reused) or an age (a slow process is
 * not a dead one).
 *
 * Two listings, read-only, spawning nothing but a bounded `ps`:
 *
 * - Linux: `/proc/<pid>/cmdline` for every pid (the operator's own processes are readable);
 * - elsewhere, or when `/proc` cannot be read: `ps -axww -o pid=,command=` through the bounded
 *   runner (no shell, allow-listed environment, deadline and output ceiling).
 *
 * A listing proves an absence only when it shows this engine's own process: a `hidepid` mount or
 * another PID namespace lists processes without listing all of them, and then the answer is
 * `unavailable`, never `absent`. Nothing is inferred and no process is adopted or signalled.
 *
 * The scan reads command lines only, never environments, and keeps nothing but matching pids.
 */
export type ReviewProcessScan =
  | { readonly kind: 'absent' }
  | { readonly kind: 'found'; readonly pids: readonly number[] }
  | { readonly kind: 'unavailable'; readonly reason: string };

export type FindReviewProcesses = (launchSessionId: string) => Promise<ReviewProcessScan>;

export interface ProcessTableOptions {
  /** Test seam for the `ps` listing; defaults to `ps -axww -o pid=,command=` through the bounded runner. */
  readonly listProcesses?: () => Promise<string>;
  readonly platform?: NodeJS.Platform;
  /** Defaults to `/proc`; tests point it at a fixture tree. */
  readonly procRoot?: string;
  /** The pid the listing must show for an absence to count; defaults to this process. */
  readonly selfPid?: number;
}

const PID_ENTRY = /^\d+$/u;
const PS_LINE = /^\s*(\d+)\s+(.*)$/u;
const WHITESPACE = /\s+/u;
const SESSION_ID_FLAG = '--session-id';
const PS_TIMEOUT_MS = 5000;
const PS_MAXIMUM_OUTPUT_BYTES = 16 * 1024 * 1024;

interface Listing {
  /** Pids whose command line carries the marker. */
  readonly matches: readonly number[];
  readonly sawSelf: boolean;
}

const carriesLaunchSession = (args: readonly string[], launchSessionId: string): boolean => {
  for (let index = 0; index + 1 < args.length; index++) {
    if (args[index] === SESSION_ID_FLAG && args[index + 1] === launchSessionId) {
      return true;
    }
  }
  return false;
};

/** `null` when `/proc` cannot be listed at all; then `ps` is tried. */
const listProcTable = async (root: string, selfPid: number, launchSessionId: string): Promise<Listing | null> => {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return null;
  }
  const matches: number[] = [];
  let sawSelf = false;
  for (const entry of entries) {
    if (!PID_ENTRY.test(entry)) {
      continue;
    }
    let cmdline: Buffer;
    try {
      cmdline = await readFile(path.join(root, entry, 'cmdline'));
    } catch {
      // The process ended between the listing and the read, or belongs to a hidden user.
      continue;
    }
    const pid = Number(entry);
    sawSelf ||= pid === selfPid;
    if (carriesLaunchSession(cmdline.toString('utf8').split('\u0000'), launchSessionId)) {
      matches.push(pid);
    }
  }
  return { matches, sawSelf };
};

/** `ps` joins the argument vector with spaces; a UUID has none, so the pair is two adjacent tokens. */
const listPsOutput = (output: string, selfPid: number, launchSessionId: string): Listing => {
  const matches: number[] = [];
  let sawSelf = false;
  for (const line of output.split('\n')) {
    const row = PS_LINE.exec(line);
    if (row === null) {
      continue;
    }
    const pid = Number(row[1]);
    sawSelf ||= pid === selfPid;
    if (carriesLaunchSession((row[2] ?? '').split(WHITESPACE), launchSessionId)) {
      matches.push(pid);
    }
  }
  return { matches, sawSelf };
};

const defaultListProcesses = async (): Promise<string> =>
  (
    await executeBoundedProcess({
      args: ['-axww', '-o', 'pid=,command='],
      command: 'ps',
      maximumOutputBytes: PS_MAXIMUM_OUTPUT_BYTES,
      timeoutMs: PS_TIMEOUT_MS,
    })
  ).stdout;

const conclude = (listing: Listing, source: string): ReviewProcessScan => {
  if (listing.matches.length > 0) {
    return { kind: 'found', pids: listing.matches };
  }
  return listing.sawSelf
    ? { kind: 'absent' }
    : {
        kind: 'unavailable',
        reason: `${source} does not show this engine's own process, so it cannot prove an absence`,
      };
};

export const createProcessTableScanner =
  (options: ProcessTableOptions = {}): FindReviewProcesses =>
  async (launchSessionId) => {
    const platform = options.platform ?? process.platform;
    const selfPid = options.selfPid ?? process.pid;
    if (platform === 'linux') {
      const proc = await listProcTable(options.procRoot ?? '/proc', selfPid, launchSessionId);
      if (proc !== null) {
        return conclude(proc, '/proc');
      }
    }
    let output: string;
    try {
      output = await (options.listProcesses ?? defaultListProcesses)();
    } catch (error) {
      return {
        kind: 'unavailable',
        reason: `no readable process table on ${platform} (ps: ${error instanceof Error ? error.name : 'failed'})`,
      };
    }
    return conclude(listPsOutput(output, selfPid, launchSessionId), 'ps');
  };
