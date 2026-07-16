import path from 'node:path';
import {
  type ProviderQuotaHistoryRequest,
  type ProviderQuotaHistoryResult,
  parseProviderQuotaHistoryRequest,
  parseProviderQuotaHistoryResult,
} from '@ai-usage/report-core/provider-quota';
import { runBoundedArtifactProcess } from './bounded-artifact-process.server';
import { resolveReportRuntimePaths } from './report-runtime-paths.server';

const configuredRoot = process.env.AI_USAGE_ROOT_DIR;
const { rootDir } = resolveReportRuntimePaths({
  cwd: process.cwd(),
  ...(configuredRoot === undefined ? {} : { configuredRoot }),
});
const runnerPath = path.join(rootDir, 'packages', 'report-data', 'src', 'provider-quota-history-runner.ts');

export const runProviderQuotaHistoryForServer = async (
  input: ProviderQuotaHistoryRequest,
): Promise<ProviderQuotaHistoryResult> => {
  const request = parseProviderQuotaHistoryRequest(input);
  const result = await runBoundedArtifactProcess({
    args: [runnerPath, JSON.stringify(request)],
    command: 'bun',
    cwd: rootDir,
    signal: AbortSignal.timeout(30_000),
  });
  return parseProviderQuotaHistoryResult(JSON.parse(result.serializedPayload) as unknown);
};
