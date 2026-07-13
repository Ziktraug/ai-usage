import { describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeReportPayloadArtifact } from './report-payload-artifact';

const createPrivateArtifact = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-usage-runner-writer-'));
  await chmod(directory, 0o700);
  const artifactPath = path.join(directory, 'payload.json');
  await writeFile(artifactPath, '', { mode: 0o600 });
  await chmod(artifactPath, 0o600);
  return { artifactPath, directory };
};

describe('writeReportPayloadArtifact', () => {
  test('writes an existing owner-only artifact without changing its permissions', async () => {
    const { artifactPath, directory } = await createPrivateArtifact();
    try {
      const serializedPayload = JSON.stringify({ rows: [] });

      await expect(writeReportPayloadArtifact(artifactPath, serializedPayload)).resolves.toBe(
        Buffer.byteLength(serializedPayload),
      );
      expect(await readFile(artifactPath, 'utf8')).toBe(serializedPayload);
      const artifactStat = await stat(artifactPath);
      // biome-ignore lint/suspicious/noBitwiseOperators: Unix permission bits are a documented bitmask API.
      expect(artifactStat.mode & 0o777).toBe(0o600);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test('rejects a payload before writing when it exceeds the configured ceiling', async () => {
    const { artifactPath, directory } = await createPrivateArtifact();
    try {
      await expect(writeReportPayloadArtifact(artifactPath, 'eleven-byte', { maximumBytes: 10 })).rejects.toThrow(
        '10-byte limit',
      );
      expect(await readFile(artifactPath, 'utf8')).toBe('');
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test('rejects permissive, non-empty, and non-regular output paths', async () => {
    const permissive = await createPrivateArtifact();
    const nonEmpty = await createPrivateArtifact();
    const directoryArtifactRoot = await mkdtemp(path.join(tmpdir(), 'ai-usage-runner-writer-directory-'));
    await chmod(directoryArtifactRoot, 0o700);
    const directoryArtifact = path.join(directoryArtifactRoot, 'payload.json');
    await mkdir(directoryArtifact, { mode: 0o700 });
    try {
      await chmod(permissive.artifactPath, 0o644);
      await expect(writeReportPayloadArtifact(permissive.artifactPath, '{}')).rejects.toThrow(
        'empty private regular file',
      );

      await writeFile(nonEmpty.artifactPath, 'occupied');
      await expect(writeReportPayloadArtifact(nonEmpty.artifactPath, '{}')).rejects.toThrow(
        'empty private regular file',
      );

      await expect(writeReportPayloadArtifact(directoryArtifact, '{}')).rejects.toThrow();
    } finally {
      await Promise.all([
        rm(permissive.directory, { force: true, recursive: true }),
        rm(nonEmpty.directory, { force: true, recursive: true }),
        rm(directoryArtifactRoot, { force: true, recursive: true }),
      ]);
    }
  });
});
