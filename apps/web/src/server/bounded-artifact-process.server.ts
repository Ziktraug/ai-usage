import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { chmod, mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MAX_REPORT_RUNNER_ARTIFACT_BYTES } from '@ai-usage/report-data/report-payload-artifact';

const ARTIFACT_READ_CHUNK_BYTES = 64 * 1024;
const MAX_STDERR_TAIL_BYTES = 64 * 1024;
const artifactCreateFlags =
  // biome-ignore lint/suspicious/noBitwiseOperators: Node file-open flags are a documented bitmask API.
  fs.constants.O_WRONLY |
  fs.constants.O_CREAT |
  fs.constants.O_EXCL |
  fs.constants.O_NOFOLLOW |
  fs.constants.O_NONBLOCK;
// biome-ignore lint/suspicious/noBitwiseOperators: Node file-open flags are a documented bitmask API.
const artifactReadFlags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;

const hasOwnerOnlyPermissions = (mode: number): boolean => {
  // biome-ignore lint/suspicious/noBitwiseOperators: Unix permission bits are a documented bitmask API.
  return (mode & 0o077) === 0;
};

const isOwnedByCurrentUser = (uid: number): boolean => process.getuid === undefined || uid === process.getuid();

const appendBoundedTail = (tail: Buffer, chunk: Buffer): Buffer => {
  if (chunk.byteLength >= MAX_STDERR_TAIL_BYTES) {
    return Buffer.from(chunk.subarray(chunk.byteLength - MAX_STDERR_TAIL_BYTES));
  }
  const combinedLength = tail.byteLength + chunk.byteLength;
  if (combinedLength <= MAX_STDERR_TAIL_BYTES) {
    return Buffer.concat([tail, chunk], combinedLength);
  }
  const bytesToKeepFromTail = MAX_STDERR_TAIL_BYTES - chunk.byteLength;
  return Buffer.concat([tail.subarray(tail.byteLength - bytesToKeepFromTail), chunk], MAX_STDERR_TAIL_BYTES);
};

export class BoundedArtifactProcessError extends Error {
  readonly stderrTail: string;

  constructor(message: string, stderrTail: Buffer) {
    const decodedTail = stderrTail.toString('utf8');
    super(decodedTail.trim() ? `${message}: ${decodedTail.trim()}` : message);
    this.name = 'BoundedArtifactProcessError';
    this.stderrTail = decodedTail;
  }
}

const readArtifact = async (artifactPath: string): Promise<{ bytes: number; payload: string }> => {
  const artifact = await open(artifactPath, artifactReadFlags);
  try {
    const artifactStat = await artifact.stat();
    const privateRegularFile = artifactStat.isFile() && hasOwnerOnlyPermissions(artifactStat.mode);
    if (!(privateRegularFile && isOwnedByCurrentUser(artifactStat.uid))) {
      throw new Error('Process artifact must be a private regular file owned by the current user');
    }
    if (artifactStat.size > MAX_REPORT_RUNNER_ARTIFACT_BYTES) {
      throw new Error(`Process artifact exceeds the ${MAX_REPORT_RUNNER_ARTIFACT_BYTES}-byte limit`);
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes <= MAX_REPORT_RUNNER_ARTIFACT_BYTES) {
      const remainingBytes = MAX_REPORT_RUNNER_ARTIFACT_BYTES + 1 - totalBytes;
      const buffer = Buffer.alloc(Math.min(ARTIFACT_READ_CHUNK_BYTES, remainingBytes));
      const { bytesRead } = await artifact.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) {
        break;
      }
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      totalBytes += bytesRead;
    }
    if (totalBytes > MAX_REPORT_RUNNER_ARTIFACT_BYTES) {
      throw new Error(`Process artifact exceeds the ${MAX_REPORT_RUNNER_ARTIFACT_BYTES}-byte limit`);
    }
    return {
      bytes: totalBytes,
      payload: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, totalBytes)),
    };
  } finally {
    await artifact.close();
  }
};

export const runBoundedArtifactProcess = async (options: {
  args: readonly string[];
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<{ artifactBytes: number; serializedPayload: string; stderrTail: string }> => {
  const artifactDirectory = await mkdtemp(path.join(tmpdir(), 'ai-usage-process-artifact-'));
  try {
    await chmod(artifactDirectory, 0o700);
    const artifactPath = path.join(artifactDirectory, 'payload.json');
    const artifact = await open(artifactPath, artifactCreateFlags, 0o600);
    await artifact.close();
    await chmod(artifactPath, 0o600);

    const child = spawn(options.command, [...options.args, artifactPath], {
      cwd: options.cwd,
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderrTail: Buffer = Buffer.alloc(0);
    child.stdout.on('data', () => undefined);
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderrTail = appendBoundedTail(stderrTail, typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    });
    await new Promise<void>((resolve, reject) => {
      child.once('error', (error) => reject(new BoundedArtifactProcessError(error.message, stderrTail)));
      child.once('close', (code, childSignal) => {
        if (code === 0) {
          resolve();
          return;
        }
        const exitDescription = childSignal ? `signal ${childSignal}` : `code ${code ?? 'unknown'}`;
        reject(new BoundedArtifactProcessError(`Artifact process exited with ${exitDescription}`, stderrTail));
      });
    });
    const result = await readArtifact(artifactPath);
    return {
      artifactBytes: result.bytes,
      serializedPayload: result.payload,
      stderrTail: stderrTail.toString('utf8'),
    };
  } finally {
    await rm(artifactDirectory, { force: true, recursive: true });
  }
};
