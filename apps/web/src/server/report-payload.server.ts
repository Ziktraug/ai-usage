import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { UsageReportPayload } from '@ai-usage/report-core/report-data';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const reportingPayloadRunner = path.join(rootDir, 'packages/report-data/src/report-payload-runner.ts');
const execFileAsync = promisify(execFile);

export const runReportPayloadRunner = async () => {
  const { stdout } = await execFileAsync('bun', [reportingPayloadRunner, rootDir], {
    cwd: rootDir,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
};

export const runReportPayloadCollection = async (): Promise<UsageReportPayload> =>
  JSON.parse(await runReportPayloadRunner()) as UsageReportPayload;
