const PROCESS_START_TIME_INDEX = 19;
const DIGITS_PATTERN = /^\d+$/;
const WHITESPACE_PATTERN = /\s+/;

const readDarwinProcessStartTime = async (pid: number): Promise<string | null> => {
  try {
    const child = Bun.spawn(['/bin/ps', '-o', 'lstart=', '-p', String(pid)], {
      stderr: 'ignore',
      stdout: 'pipe',
    });
    const output = await new Response(child.stdout).text();
    if ((await child.exited) !== 0) {
      return null;
    }
    const startTimeMs = Date.parse(output.trim());
    return Number.isFinite(startTimeMs) ? String(startTimeMs) : null;
  } catch {
    return null;
  }
};

export interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

export const errorHasCode = (error: unknown, code: string): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === code;

export const sameFileIdentity = (left: FileIdentity, right: FileIdentity): boolean =>
  left.dev === right.dev && left.ino === right.ino;

export const hasCurrentOwner = (uid: number): boolean =>
  typeof process.getuid !== 'function' || uid === process.getuid();

export const isOwnerOnly = (mode: number): boolean => process.platform === 'win32' || mode % 0o100 === 0;

export const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !errorHasCode(error, 'ESRCH');
  }
};

export const isProcessStartTimeTicks = (value: unknown): value is string =>
  typeof value === 'string' && DIGITS_PATTERN.test(value);

export const readProcessStartTimeTicks = async (pid: number): Promise<string | null> => {
  if (process.platform === 'darwin') {
    return readDarwinProcessStartTime(pid);
  }
  if (process.platform !== 'linux') {
    return null;
  }
  try {
    const stat = await Bun.file(`/proc/${pid}/stat`).text();
    const commandEnd = stat.lastIndexOf(')');
    if (commandEnd < 0) {
      return null;
    }
    const fields = stat
      .slice(commandEnd + 2)
      .trim()
      .split(WHITESPACE_PATTERN);
    const startTime = fields[PROCESS_START_TIME_INDEX];
    return isProcessStartTimeTicks(startTime) ? startTime : null;
  } catch {
    return null;
  }
};
