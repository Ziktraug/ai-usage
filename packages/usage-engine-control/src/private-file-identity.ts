const PROCESS_START_TIME_INDEX = 19;
const DIGITS_PATTERN = /^\d+$/;
const WHITESPACE_PATTERN = /\s+/;
const DARWIN_PROCESS_START_PATTERN =
  /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+([1-9]|[12]\d|3[01])\s+([01]\d|2[0-3]):([0-5]\d):([0-5]\d)\s+(\d{4})$/;
const DARWIN_MONTHS = new Map(
  ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].map((month, index) => [
    month,
    String(index + 1).padStart(2, '0'),
  ]),
);

export const parseDarwinProcessStartTime = (output: string): string | null => {
  const match = DARWIN_PROCESS_START_PATTERN.exec(output.trim());
  if (!match) {
    return null;
  }
  const [, monthName, dayValue, hour, minute, second, year] = match;
  const month = monthName ? DARWIN_MONTHS.get(monthName) : undefined;
  if (!(month && dayValue && hour && minute && second && year)) {
    return null;
  }
  const day = dayValue.padStart(2, '0');
  const canonical = `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`;
  const timestamp = Date.parse(canonical);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== canonical) {
    return null;
  }
  return `${year}${month}${day}${hour}${minute}${second}`;
};

const readDarwinProcessStartTime = async (pid: number): Promise<string | null> => {
  try {
    const child = Bun.spawn(['/bin/ps', '-o', 'lstart=', '-p', String(pid)], {
      env: { ...process.env, LC_ALL: 'C' },
      stderr: 'ignore',
      stdout: 'pipe',
    });
    const output = await new Response(child.stdout).text();
    if ((await child.exited) !== 0) {
      return null;
    }
    return parseDarwinProcessStartTime(output);
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
