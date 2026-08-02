import { readdir } from 'node:fs/promises';

const DEFAULT_BLOCK_DEVICE = 'dm-0';
const KIBIBYTE_BYTES = 1024;
const MAX_COMMAND_DURATION_MS = 240_000;
const PROCESS_GROUP_EXIT_DEADLINE_MS = 3000;
const PROCESS_GROUP_GRACEFUL_EXIT_MS = 500;
const PROCESS_GROUP_GRACE_MS = 250;
const POLL_INTERVAL_MS = 50;
const PROCESS_DIRECTORY_PATTERN = /^\d+$/;
const STATUS_RSS_PATTERN = /^VmRSS:\s+(\d+)\s+kB$/m;
const STATUS_THREADS_PATTERN = /^Threads:\s+(\d+)$/m;
const WRITE_BYTES_PATTERN = /^write_bytes:\s+(\d+)$/m;
const WHITESPACE_PATTERN = /\s+/;

export interface LinuxProcessStat {
  cpuTicks: number;
  parentPid: number;
  processGroupId: number;
  startTimeTicks: number;
}

interface LinuxProcessStatus {
  residentBytes: number;
  threads: number;
}

interface MutableProcessMeasurement {
  command: string;
  maxCpuTicks: number;
  maxWriteBytes: number;
  pid: number;
}

interface ProcessTreeIoMeasurement {
  blockDevice: string;
  blockDeviceWriteBytes: number | null;
  command: readonly string[];
  durationMs: number;
  exitCode: number;
  peakResidentBytes: number;
  peakThreads: number;
  processes: MutableProcessMeasurement[];
  totalCpuTicks: number;
  totalWriteBytes: number;
}

export const parseLinuxProcessStat = (text: string): LinuxProcessStat | undefined => {
  const commandEnd = text.lastIndexOf(')');
  if (commandEnd < 0) {
    return;
  }
  const fieldsAfterCommand = text
    .slice(commandEnd + 1)
    .trim()
    .split(WHITESPACE_PATTERN);
  const parentPid = Number(fieldsAfterCommand[1]);
  const processGroupId = Number(fieldsAfterCommand[2]);
  const userCpuTicks = Number(fieldsAfterCommand[11]);
  const systemCpuTicks = Number(fieldsAfterCommand[12]);
  const startTimeTicks = Number(fieldsAfterCommand[19]);
  if (![parentPid, processGroupId, userCpuTicks, systemCpuTicks, startTimeTicks].every(Number.isSafeInteger)) {
    return;
  }
  return { cpuTicks: userCpuTicks + systemCpuTicks, parentPid, processGroupId, startTimeTicks };
};

export const parseLinuxProcessStatus = (text: string): LinuxProcessStatus | undefined => {
  const residentKibibytes = Number(text.match(STATUS_RSS_PATTERN)?.[1]);
  const threads = Number(text.match(STATUS_THREADS_PATTERN)?.[1]);
  if (!(Number.isSafeInteger(residentKibibytes) && Number.isSafeInteger(threads))) {
    return;
  }
  return { residentBytes: residentKibibytes * KIBIBYTE_BYTES, threads };
};

export const parseProcessIo = (text: string): number | undefined => {
  const writeBytes = Number(text.match(WRITE_BYTES_PATTERN)?.[1]);
  return Number.isSafeInteger(writeBytes) ? writeBytes : undefined;
};

export const parseDiskSectorsWritten = (text: string, device: string): number | undefined => {
  for (const line of text.split('\n')) {
    const fields = line.trim().split(WHITESPACE_PATTERN);
    if (fields[2] !== device) {
      continue;
    }
    const sectorsWritten = Number(fields[9]);
    return Number.isSafeInteger(sectorsWritten) ? sectorsWritten : undefined;
  }
  return;
};

const readText = async (filePath: string): Promise<string | undefined> => {
  try {
    return await Bun.file(filePath).text();
  } catch {
    return;
  }
};

const readBlockDeviceSectors = async (device: string): Promise<number | undefined> => {
  const diskstats = await readText('/proc/diskstats');
  return diskstats ? parseDiskSectorsWritten(diskstats, device) : undefined;
};

const signalProcessGroup = (pid: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH')) {
      throw error;
    }
  }
};

const processGroupIsAlive = (processGroupId: number): boolean => {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH') {
      return false;
    }
    throw error;
  }
};

const stopProcessGroups = async (child: Bun.Subprocess, processGroupIds: ReadonlySet<number>): Promise<void> => {
  const liveGroups = (): number[] => [...processGroupIds].filter(processGroupIsAlive);
  for (const processGroupId of liveGroups()) {
    signalProcessGroup(processGroupId, 'SIGTERM');
  }
  const gracefulDeadline = Date.now() + PROCESS_GROUP_GRACEFUL_EXIT_MS;
  while (liveGroups().length > 0 && Date.now() < gracefulDeadline) {
    await Bun.sleep(25);
  }
  for (const processGroupId of liveGroups()) {
    signalProcessGroup(processGroupId, 'SIGKILL');
  }
  await Promise.race([
    child.exited,
    Bun.sleep(PROCESS_GROUP_EXIT_DEADLINE_MS).then(() => {
      throw new Error(`Measured root process ${child.pid} did not exit after SIGKILL.`);
    }),
  ]);
  const forcedDeadline = Date.now() + PROCESS_GROUP_EXIT_DEADLINE_MS;
  while (liveGroups().length > 0 && Date.now() < forcedDeadline) {
    await Bun.sleep(25);
  }
  const survivors = liveGroups();
  if (survivors.length > 0) {
    throw new Error(`Measured process groups survived SIGKILL: ${survivors.join(', ')}`);
  }
};

export const measureCommand = async (
  command: readonly string[],
  blockDevice: string,
): Promise<ProcessTreeIoMeasurement> => {
  if (process.platform !== 'linux') {
    throw new Error('Process-tree I/O measurement requires Linux /proc.');
  }
  if (command.length === 0) {
    throw new Error('Pass a command after --.');
  }

  const sectorsBefore = await readBlockDeviceSectors(blockDevice);
  const child = Bun.spawn([...command], {
    cwd: process.cwd(),
    detached: true,
    env: process.env,
    stderr: 'inherit',
    stdin: 'ignore',
    stdout: 'inherit',
  });
  const startedAt = performance.now();
  const deadline = Date.now() + MAX_COMMAND_DURATION_MS;
  const processMeasurements = new Map<number, MutableProcessMeasurement>();
  const processGroupIds = new Set([child.pid]);
  let peakResidentBytes = 0;
  let peakThreads = 0;

  const sampleProcessGroup = async (): Promise<void> => {
    const entries = await readdir('/proc', { withFileTypes: true });
    const processStats = new Map<number, LinuxProcessStat>();
    for (const entry of entries) {
      if (!(entry.isDirectory() && PROCESS_DIRECTORY_PATTERN.test(entry.name))) {
        continue;
      }
      const pid = Number(entry.name);
      const stat = parseLinuxProcessStat((await readText(`/proc/${pid}/stat`)) ?? '');
      if (stat) {
        processStats.set(pid, stat);
      }
    }
    const measuredPids = new Set([child.pid]);
    let foundDescendant = true;
    while (foundDescendant) {
      foundDescendant = false;
      for (const [pid, stat] of processStats) {
        if (!measuredPids.has(pid) && (stat.processGroupId === child.pid || measuredPids.has(stat.parentPid))) {
          measuredPids.add(pid);
          foundDescendant = true;
        }
      }
    }
    let aggregateResidentBytes = 0;
    let aggregateThreads = 0;
    for (const pid of measuredPids) {
      const stat = processStats.get(pid);
      if (!stat) {
        continue;
      }
      processGroupIds.add(stat.processGroupId);
      const [commandName, io, status] = await Promise.all([
        readText(`/proc/${pid}/comm`),
        readText(`/proc/${pid}/io`),
        readText(`/proc/${pid}/status`),
      ]);
      const parsedStatus = parseLinuxProcessStatus(status ?? '');
      aggregateResidentBytes += parsedStatus?.residentBytes ?? 0;
      aggregateThreads += parsedStatus?.threads ?? 0;
      const existing = processMeasurements.get(pid);
      processMeasurements.set(pid, {
        command: commandName?.trim() || existing?.command || 'unknown',
        maxCpuTicks: Math.max(existing?.maxCpuTicks ?? 0, stat.cpuTicks),
        maxWriteBytes: Math.max(existing?.maxWriteBytes ?? 0, parseProcessIo(io ?? '') ?? 0),
        pid,
      });
    }
    peakResidentBytes = Math.max(peakResidentBytes, aggregateResidentBytes);
    peakThreads = Math.max(peakThreads, aggregateThreads);
  };

  let commandDurationMs: number | undefined;
  let commandExitCode: number | undefined;
  let operationError: unknown;
  try {
    await sampleProcessGroup();
    while (child.exitCode === null && Date.now() < deadline) {
      await Bun.sleep(POLL_INTERVAL_MS);
      await sampleProcessGroup();
    }
    if (child.exitCode === null) {
      throw new Error(`Measured command exceeded ${MAX_COMMAND_DURATION_MS}ms.`);
    }
    commandExitCode = await child.exited;
    commandDurationMs = performance.now() - startedAt;
    const descendantGraceDeadline = Date.now() + PROCESS_GROUP_GRACE_MS;
    while ([...processGroupIds].some(processGroupIsAlive) && Date.now() < descendantGraceDeadline) {
      await Bun.sleep(POLL_INTERVAL_MS);
      await sampleProcessGroup();
    }
  } catch (error) {
    operationError = error;
  }

  let cleanupError: unknown;
  try {
    await stopProcessGroups(child, processGroupIds);
  } catch (error) {
    cleanupError = error;
  }
  const failures = [operationError, cleanupError].filter(
    (failure): failure is NonNullable<unknown> => failure !== undefined,
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Process-tree I/O measurement failed.');
  }
  if (commandDurationMs === undefined || commandExitCode === undefined) {
    throw new Error('Process-tree I/O measurement completed without a command result.');
  }

  const sectorsAfter = await readBlockDeviceSectors(blockDevice);
  const processes = [...processMeasurements.values()].sort((left, right) => left.pid - right.pid);
  return {
    blockDevice,
    blockDeviceWriteBytes:
      sectorsBefore === undefined || sectorsAfter === undefined ? null : (sectorsAfter - sectorsBefore) * 512,
    command,
    durationMs: commandDurationMs,
    exitCode: commandExitCode,
    peakResidentBytes,
    peakThreads,
    processes,
    totalCpuTicks: processes.reduce((total, measurement) => total + measurement.maxCpuTicks, 0),
    totalWriteBytes: processes.reduce((total, measurement) => total + measurement.maxWriteBytes, 0),
  };
};

if (import.meta.main) {
  const separatorIndex = Bun.argv.indexOf('--', 2);
  const optionArguments = separatorIndex < 0 ? [] : Bun.argv.slice(2, separatorIndex);
  const command = separatorIndex < 0 ? Bun.argv.slice(2) : Bun.argv.slice(separatorIndex + 1);
  const deviceOption = optionArguments.find((argument) => argument.startsWith('--device='));
  const blockDevice = deviceOption?.slice('--device='.length) || DEFAULT_BLOCK_DEVICE;
  try {
    const result = await measureCommand(command, blockDevice);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.exitCode;
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
