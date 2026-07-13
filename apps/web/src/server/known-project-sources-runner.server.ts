import { spawn } from 'node:child_process';
import type { KnownLocalProjectSourcesRequest, KnownLocalProjectSourcesResult } from '@ai-usage/report-data';
import { resolveReportRuntimePaths } from './report-runtime-paths.server';

const DEFAULT_MAX_STDOUT_BYTES = 512 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const RUNNER_TIMEOUT_MS = 120_000;

interface KnownProjectSourcesRunnerOptions {
  env?: NodeJS.ProcessEnv;
  executable?: string;
  maxStdoutBytes?: number;
  onStderr?: (chunk: string) => void;
  runnerPath?: string;
  timeoutMs?: number;
}

const appendBounded = (
  chunks: Buffer[],
  chunk: Buffer,
  retainedBytes: number,
  maxBytes: number,
): { retainedBytes: number; truncated: boolean } => {
  const remainingBytes = Math.max(0, maxBytes - retainedBytes);
  if (remainingBytes > 0) {
    chunks.push(chunk.subarray(0, remainingBytes));
  }
  return {
    retainedBytes: retainedBytes + Math.min(chunk.byteLength, remainingBytes),
    truncated: chunk.byteLength > remainingBytes,
  };
};

const isKnownLocalProjectSourcesResult = (input: unknown): input is KnownLocalProjectSourcesResult => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return false;
  }
  const result = input as Record<string, unknown>;
  return Array.isArray(result.projectGroups) && Array.isArray(result.sources) && Array.isArray(result.warnings);
};

export const runKnownProjectSourcesRunner = (
  request: KnownLocalProjectSourcesRequest,
  options: KnownProjectSourcesRunnerOptions = {},
): Promise<KnownLocalProjectSourcesResult> => {
  const configuredRoot = process.env.AI_USAGE_ROOT_DIR;
  const runnerPath =
    options.runnerPath ??
    resolveReportRuntimePaths({
      cwd: process.cwd(),
      ...(configuredRoot === undefined ? {} : { configuredRoot }),
    }).knownProjectSourcesRunner;
  const executable = options.executable ?? 'bun';
  const maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;
  const timeoutMs = options.timeoutMs ?? RUNNER_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const child = spawn(executable, [runnerPath, JSON.stringify(request)], {
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutOverflow = false;
    let stderrTruncated = false;
    const timeout = setTimeout(() => child.kill('SIGKILL'), timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdoutOverflow) {
        return;
      }
      const appended = appendBounded(stdoutChunks, chunk, stdoutBytes, maxStdoutBytes);
      stdoutBytes = appended.retainedBytes;
      stdoutOverflow = appended.truncated;
      if (stdoutOverflow) {
        child.kill('SIGKILL');
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      options.onStderr?.(chunk.toString('utf8'));
      if (stderrTruncated) {
        return;
      }
      const appended = appendBounded(stderrChunks, chunk, stderrBytes, MAX_STDERR_BYTES);
      stderrBytes = appended.retainedBytes;
      stderrTruncated = appended.truncated;
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (exitCode, signal) => {
      clearTimeout(timeout);
      if (stdoutOverflow) {
        reject(new Error(`Known project-source runner exceeded ${maxStdoutBytes} stdout bytes.`));
        return;
      }
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      if (exitCode !== 0) {
        const detail = stderr ? `: ${stderr}${stderrTruncated ? '\n[stderr truncated]' : ''}` : '';
        reject(new Error(`Known project-source runner failed (${signal ?? `exit ${exitCode}`})${detail}`));
        return;
      }
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(stdoutChunks).toString('utf8'));
        if (!isKnownLocalProjectSourcesResult(parsed)) {
          throw new Error('runner returned an invalid result');
        }
        resolve(parsed);
      } catch (error) {
        reject(new Error(`Could not parse known project-source runner output: ${String(error)}`));
      }
    });
  });
};
