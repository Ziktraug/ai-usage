import { spawn } from 'node:child_process';
import { resolveReportRuntimePaths } from './report-runtime-paths.server';

const MAX_MATERIALIZER_OUTPUT_BYTES = 64 * 1024;
const MATERIALIZER_TIMEOUT_MS = 120_000;

interface SessionQueryMaterializerOptions {
  command?: string;
  cwd?: string;
  runnerPath?: string;
  timeoutMs?: number;
}

export const materializeSessionQueryRevision = (
  revisionDirectory: string,
  options: SessionQueryMaterializerOptions = {},
): Promise<void> => {
  const configuredRoot = process.env.AI_USAGE_ROOT_DIR;
  const runtimePaths = resolveReportRuntimePaths({
    cwd: process.cwd(),
    ...(configuredRoot === undefined ? {} : { configuredRoot }),
  });
  const command = options.command ?? 'bun';
  const runnerPath = options.runnerPath ?? runtimePaths.sessionQueryMaterializeRunner;
  const cwd = options.cwd ?? runtimePaths.rootDir;
  const timeoutMs = options.timeoutMs ?? MATERIALIZER_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const child = spawn(command, [runnerPath, revisionDirectory], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let timedOut = false;
    const append = (target: Buffer[], chunk: Buffer): void => {
      const remaining = Math.max(0, MAX_MATERIALIZER_OUTPUT_BYTES - outputBytes);
      if (remaining > 0) {
        target.push(chunk.subarray(0, remaining));
      }
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_MATERIALIZER_OUTPUT_BYTES) {
        child.kill('SIGKILL');
      }
    };
    child.stdout.on('data', (chunk: Buffer) => append(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => append(stderr, chunk));
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (exitCode, signal) => {
      clearTimeout(timeout);
      const stdoutText = Buffer.concat(stdout).toString('utf8').trim();
      const stderrText = Buffer.concat(stderr).toString('utf8').trim();
      if (timedOut) {
        reject(new Error(`Session query materializer timed out after ${timeoutMs}ms`));
        return;
      }
      if (outputBytes > MAX_MATERIALIZER_OUTPUT_BYTES) {
        reject(new Error(`Session query materializer output exceeded ${MAX_MATERIALIZER_OUTPUT_BYTES} bytes`));
        return;
      }
      if (exitCode !== 0) {
        reject(
          new Error(
            `Session query materializer failed (${signal ?? `exit ${exitCode}`})${stderrText ? `: ${stderrText}` : ''}`,
          ),
        );
        return;
      }
      if (stdoutText !== '') {
        reject(new Error('Session query materializer wrote unexpected stdout'));
        return;
      }
      resolve();
    });
  });
};
