import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Process evidence for a lost review attempt (ADR 0055). The engine records, before any spawn, the
 * session id it passes to the harness as `--session-id`; the launched process carries it in its
 * argument vector for its whole life. Looking for that pair answers "does the harness process this
 * attempt started still run?" without trusting a pid (pids are reused) or an age (a slow process is
 * not a dead one).
 *
 * Only Linux exposes the argument vectors the engine can read without spawning anything
 * (`/proc/<pid>/cmdline`, readable for the operator's own processes). Elsewhere the answer is
 * `unavailable` and the reservation stays held; nothing is inferred.
 *
 * The scan reads command lines only, never environments, and keeps nothing but matching pids.
 */
export type ReviewProcessScan =
  | { readonly kind: 'absent' }
  | { readonly kind: 'found'; readonly pids: readonly number[] }
  | { readonly kind: 'unavailable'; readonly reason: string };

export type FindReviewProcesses = (launchSessionId: string) => Promise<ReviewProcessScan>;

export interface ProcessTableOptions {
  readonly platform?: NodeJS.Platform;
  /** Defaults to `/proc`; tests point it at a fixture tree. */
  readonly procRoot?: string;
}

const PID_ENTRY = /^\d+$/u;
const SESSION_ID_FLAG = '--session-id';

const carriesLaunchSession = (cmdline: Buffer, launchSessionId: string): boolean => {
  const args = cmdline.toString('utf8').split('\u0000');
  for (let index = 0; index + 1 < args.length; index++) {
    if (args[index] === SESSION_ID_FLAG && args[index + 1] === launchSessionId) {
      return true;
    }
  }
  return false;
};

export const createProcessTableScanner =
  (options: ProcessTableOptions = {}): FindReviewProcesses =>
  async (launchSessionId) => {
    const platform = options.platform ?? process.platform;
    if (platform !== 'linux') {
      return { kind: 'unavailable', reason: `no readable process table on ${platform}` };
    }
    const root = options.procRoot ?? '/proc';
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      return { kind: 'unavailable', reason: `${root} is not readable` };
    }
    const pids: number[] = [];
    let processes = 0;
    for (const entry of entries) {
      if (!PID_ENTRY.test(entry)) {
        continue;
      }
      processes += 1;
      let cmdline: Buffer;
      try {
        cmdline = await readFile(path.join(root, entry, 'cmdline'));
      } catch {
        // The process ended between the listing and the read, or belongs to a hidden user; the
        // operator's own processes stay readable, and they are the only ones a launch creates.
        continue;
      }
      if (carriesLaunchSession(cmdline, launchSessionId)) {
        pids.push(Number(entry));
      }
    }
    if (processes === 0) {
      return { kind: 'unavailable', reason: `${root} lists no process` };
    }
    return pids.length > 0 ? { kind: 'found', pids } : { kind: 'absent' };
  };
