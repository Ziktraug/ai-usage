/**
 * Dump everything a wedged process can still tell us from the outside.
 *
 * The hang leaves Vite alive but unresponsive, and its event loop stops
 * scheduling even signal handlers -- so nothing the process itself would print
 * can be trusted to arrive. Every source here is read *about* the process
 * rather than *from* it:
 *
 * - /proc/<pid>/task/<tid>/stat gives each thread's scheduler state and its
 *   accumulated user/system time. Sampled twice, that separates a spinning
 *   loop (time climbing, state R) from a thread parked in a syscall (time
 *   flat, state S). That distinction alone splits the plausible defects in
 *   half, and no stack trace is needed to read it.
 * - wchan names the kernel function a sleeping thread is parked in;
 *   futex_wait, epoll_wait and pipe_write imply very different bugs.
 * - gdb backtraces name the userspace frames, which is what an upstream
 *   report ultimately needs.
 *
 * gdb is best-effort: it needs to be installed and ptrace_scope must allow
 * attaching to a non-descendant. A capture without it is still worth having,
 * so every step degrades to a recorded error instead of throwing.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const THREAD_SAMPLE_GAP_MS = 1000;
const GDB_TIMEOUT_MS = 20_000;
const CLOCK_TICKS_PER_SECOND = 100;

interface ThreadSample {
  readonly name: string;
  readonly state: string;
  readonly systemTicks: number;
  readonly threadId: string;
  readonly userTicks: number;
  readonly wchan: string;
}

const readOrError = async (file: string): Promise<string> => {
  try {
    return (await readFile(file, 'utf8')).trim();
  } catch (error) {
    return `<unreadable: ${error instanceof Error ? error.message : String(error)}>`;
  }
};

/**
 * /proc stat puts the comm field in parentheses and it may itself contain
 * spaces, so the fields after it are located from the last ')' rather than by
 * splitting the whole line.
 */
const parseThreadStat = (raw: string, threadId: string, wchan: string): ThreadSample | undefined => {
  const commEnd = raw.lastIndexOf(')');
  const commStart = raw.indexOf('(');
  if (commEnd === -1 || commStart === -1) {
    return;
  }
  const name = raw.slice(commStart + 1, commEnd);
  const fields = raw.slice(commEnd + 2).split(' ');
  // Fields after comm are 1-indexed from state: state=0, then utime is the
  // 12th and stime the 13th (proc(5) fields 14 and 15).
  return {
    name,
    state: fields[0] ?? '?',
    systemTicks: Number(fields[12] ?? '0'),
    threadId,
    userTicks: Number(fields[11] ?? '0'),
    wchan,
  };
};

const sampleThreads = async (pid: number): Promise<ThreadSample[]> => {
  let threadIds: string[] = [];
  try {
    threadIds = await readdir(`/proc/${pid}/task`);
  } catch {
    return [];
  }
  const samples = await Promise.all(
    threadIds.map(async (threadId) => {
      const base = `/proc/${pid}/task/${threadId}`;
      const [raw, wchan] = await Promise.all([readOrError(`${base}/stat`), readOrError(`${base}/wchan`)]);
      return parseThreadStat(raw, threadId, wchan);
    }),
  );
  return samples.filter((sample): sample is ThreadSample => sample !== undefined);
};

const formatThreadDelta = (before: readonly ThreadSample[], after: readonly ThreadSample[]): string => {
  const beforeById = new Map(before.map((sample) => [sample.threadId, sample]));
  const lines = [
    `tid      name                 state  wchan                 user+sys ticks over ${THREAD_SAMPLE_GAP_MS}ms`,
  ];
  for (const sample of after) {
    const previous = beforeById.get(sample.threadId);
    const delta = previous
      ? sample.userTicks + sample.systemTicks - (previous.userTicks + previous.systemTicks)
      : Number.NaN;
    const deltaMs = Number.isNaN(delta) ? '?' : `${(delta * (1000 / CLOCK_TICKS_PER_SECOND)).toFixed(0)}ms`;
    lines.push(
      `${sample.threadId.padEnd(8)} ${sample.name.padEnd(20)} ${sample.state.padEnd(6)} ${sample.wchan.padEnd(21)} ${deltaMs}`,
    );
  }
  const busy = after.filter((sample) => sample.state === 'R').length;
  lines.push('', busy > 0 ? `${busy} thread(s) runnable: spinning, not parked.` : 'No runnable thread: all parked.');
  return lines.join('\n');
};

const runCommand = async (command: readonly string[], timeoutMs: number): Promise<string> => {
  try {
    const child = Bun.spawn([...command], { stderr: 'pipe', stdout: 'pipe' });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    await child.exited;
    clearTimeout(timer);
    return `$ ${command.join(' ')}\n${stdout}${stderr}`;
  } catch (error) {
    return `$ ${command.join(' ')}\n<failed: ${error instanceof Error ? error.message : String(error)}>`;
  }
};

export const captureProcessState = async (pid: number, outputFile: string): Promise<void> => {
  const before = await sampleThreads(pid);
  await Bun.sleep(THREAD_SAMPLE_GAP_MS);
  const after = await sampleThreads(pid);

  const [status, cmdline, stack, backtrace, openFiles] = await Promise.all([
    readOrError(`/proc/${pid}/status`),
    readOrError(`/proc/${pid}/cmdline`),
    readOrError(`/proc/${pid}/stack`),
    runCommand(['gdb', '-p', String(pid), '-batch', '-ex', 'thread apply all bt'], GDB_TIMEOUT_MS),
    runCommand(['ls', '-l', `/proc/${pid}/fd`], 5000),
  ]);

  const sections = [
    `# Wedged process capture: pid ${pid}`,
    '',
    '## Thread scheduler states (the spinning-vs-parked discriminator)',
    formatThreadDelta(before, after),
    '',
    '## gdb backtrace, all threads',
    backtrace,
    '',
    '## /proc/<pid>/status',
    status,
    '',
    '## /proc/<pid>/cmdline',
    cmdline.replaceAll('\0', ' '),
    '',
    '## /proc/<pid>/stack (needs privileges; often unreadable)',
    stack,
    '',
    '## Open file descriptors',
    openFiles,
  ];
  await writeFile(outputFile, `${sections.join('\n')}\n`, 'utf8');
};

/** Youngest matching pid: the freshly spawned server, not a stale leftover. */
export const findProcessByCommand = async (pattern: string): Promise<number | undefined> => {
  const output = await runCommand(['pgrep', '-f', pattern], 5000);
  const pids = output
    .split('\n')
    .slice(1)
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid);
  return pids.at(-1);
};

export const captureFileName = (logDirectory: string, iteration: number, label: string): string =>
  path.join(logDirectory, `capture-${String(iteration).padStart(3, '0')}-${label}.txt`);
