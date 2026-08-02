import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  measureCommand,
  parseDiskSectorsWritten,
  parseLinuxProcessStat,
  parseLinuxProcessStatus,
  parseProcessIo,
} from './measure-process-tree-io';

describe('process-tree I/O measurement parsers', () => {
  test('parses Linux process group and CPU fields with parentheses in the command', () => {
    const parsed = parseLinuxProcessStat(
      '123 (bun worker (fixture)) S 1 123 123 0 -1 0 0 0 0 0 101 11 0 0 20 0 3 0 9001 0 0 0',
    );

    expect(parsed).toEqual({ cpuTicks: 112, parentPid: 1, processGroupId: 123, startTimeTicks: 9001 });
  });

  test('parses write bytes, resident memory, and threads', () => {
    expect(parseProcessIo('rchar: 10\nwrite_bytes: 4096\ncancelled_write_bytes: 0\n')).toBe(4096);
    expect(parseLinuxProcessStatus('Name:\tbun\nVmRSS:\t  2048 kB\nThreads:\t7\n')).toEqual({
      residentBytes: 2_097_152,
      threads: 7,
    });
  });

  test('parses the selected block device sector counter', () => {
    const diskstats = '253 0 dm-0 1 2 3 4 5 6 777 8 9 10 11 12 13 14 15 16\n';
    expect(parseDiskSectorsWritten(diskstats, 'dm-0')).toBe(777);
    expect(parseDiskSectorsWritten(diskstats, 'missing')).toBeUndefined();
  });

  test('terminates a signal-resistant descendant after the measured root exits', async () => {
    if (process.platform !== 'linux') {
      return;
    }
    const fixture = await mkdtemp(path.join(tmpdir(), 'plan052-process-tree-cleanup-'));
    const pidPath = path.join(fixture, 'descendant.pid');
    let descendantPid: number | undefined;
    try {
      const rootScript = `
        const descendant = Bun.spawn(
          [process.execPath, '-e', 'process.on("SIGTERM", () => {}); await Bun.sleep(10000)'],
          { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
        );
        await Bun.write(Bun.argv[1], String(descendant.pid));
        process.exit(0);
      `;
      const result = await measureCommand([process.execPath, '-e', rootScript, pidPath], 'dm-0');
      const measuredDescendantPid = Number(await readFile(pidPath, 'utf8'));
      descendantPid = measuredDescendantPid;

      expect(result.exitCode).toBe(0);
      expect(() => process.kill(measuredDescendantPid, 0)).toThrow();
    } finally {
      if (descendantPid) {
        try {
          process.kill(descendantPid, 'SIGKILL');
        } catch {
          // The required path is that the sampler already reaped it.
        }
      }
      await rm(fixture, { force: true, recursive: true });
    }
  });
});
