import { describe, expect, test } from 'bun:test';
import { access, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { demoReportPayload } from '../report-data';
import {
  mergeWebReportSlices,
  parseReportRequestFingerprint,
  reportManifestRequestFingerprint,
  reportSliceRequestFingerprint,
  toWebReportPayload,
  type WebReportPayload,
} from '../web-report-payload';
import { createReportRevisionRegistry, type ReportRevisionRegistryOptions } from './report-revision.server';

const privateMode = (mode: number): number => {
  // biome-ignore lint/suspicious/noBitwiseOperators: Unix permission bits are a documented bitmask API.
  return mode & 0o777;
};

const payloadFor = (generatedAt: string, rowCount: number): WebReportPayload => ({
  ...toWebReportPayload(demoReportPayload),
  generatedAt,
  rows: toWebReportPayload(demoReportPayload).rows.slice(0, rowCount),
});

const withRegistry = async <Result>(
  options: ReportRevisionRegistryOptions,
  run: (registry: ReturnType<typeof createReportRevisionRegistry>, rootDirectory: string) => Promise<Result>,
): Promise<Result> => {
  const parent = await mkdtemp(path.join(tmpdir(), 'ai-usage-revision-test-'));
  const rootDirectory = path.join(parent, 'revisions');
  const registry = createReportRevisionRegistry({ ...options, rootDirectory });
  try {
    return await run(registry, rootDirectory);
  } finally {
    await registry.dispose();
    await rm(parent, { force: true, recursive: true });
  }
};

describe('report revision registry', () => {
  test('publishes owner-only immutable slices atomically from one payload capture', async () => {
    await withRegistry(
      {
        materialize: (directory) => writeFile(path.join(directory, 'sessions.sqlite'), 'sqlite', { mode: 0o600 }),
        revisionId: () => 'revision-a',
      },
      async (registry, rootDirectory) => {
        const payload = payloadFor('2026-07-13T12:00:00.000Z', 2);
        const captured = structuredClone(payload);
        const manifest = await registry.publish(payload);
        payload.rows.splice(0, payload.rows.length);

        const rows = await registry.readRows({
          requestFingerprint: reportSliceRequestFingerprint('rows'),
          revision: manifest.revision,
        });
        const support = await registry.readSupport({
          requestFingerprint: reportSliceRequestFingerprint('support'),
          revision: manifest.revision,
        });

        expect(rows.ok).toBe(true);
        expect(support.ok).toBe(true);
        if (!(rows.ok && support.ok)) {
          throw new Error('Expected exact revision slices');
        }
        expect(mergeWebReportSlices(rows.slice, support.slice)).toEqual(captured);
        expect(rows.requestFingerprint).toBe(reportSliceRequestFingerprint('rows'));
        expect(support.requestFingerprint).toBe(reportSliceRequestFingerprint('support'));
        expect(manifest.sessionQueryBytes).toBe(6);

        expect(await readdir(rootDirectory)).toEqual(['revision-a']);
        const revisionDirectory = path.join(rootDirectory, 'revision-a');
        expect(privateMode((await stat(rootDirectory)).mode)).toBe(0o700);
        expect(privateMode((await stat(revisionDirectory)).mode)).toBe(0o500);
        for (const file of ['manifest.json', 'rows.json', 'sessions.sqlite', 'support.json']) {
          expect(privateMode((await stat(path.join(revisionDirectory, file))).mode)).toBe(0o400);
        }
      },
    );
  });

  test('keeps exact prior revisions consistent and never substitutes latest slices', async () => {
    const revisionIds = ['revision-a', 'revision-b'];
    await withRegistry(
      { maxRetainedRevisions: 2, revisionId: () => revisionIds.shift() ?? 'unexpected' },
      async (registry) => {
        const firstPayload = payloadFor('2026-07-13T12:00:00.000Z', 2);
        const secondPayload = payloadFor('2026-07-13T13:00:00.000Z', 1);
        const first = await registry.publish(firstPayload);
        await registry.invalidateLatest();
        expect((await registry.getCurrentManifest()).ok).toBe(false);
        expect(
          (
            await registry.readRows({
              requestFingerprint: reportSliceRequestFingerprint('rows'),
              revision: first.revision,
            })
          ).ok,
        ).toBe(true);
        const second = await registry.publish(secondPayload);
        const firstRows = await registry.readRows({
          requestFingerprint: reportSliceRequestFingerprint('rows'),
          revision: first.revision,
        });
        const firstSupport = await registry.readSupport({
          requestFingerprint: reportSliceRequestFingerprint('support'),
          revision: first.revision,
        });
        const secondRows = await registry.readRows({
          requestFingerprint: reportSliceRequestFingerprint('rows'),
          revision: second.revision,
        });
        const secondSupport = await registry.readSupport({
          requestFingerprint: reportSliceRequestFingerprint('support'),
          revision: second.revision,
        });
        if (!(firstRows.ok && firstSupport.ok && secondRows.ok && secondSupport.ok)) {
          throw new Error('Expected retained exact revisions');
        }

        expect(mergeWebReportSlices(firstRows.slice, firstSupport.slice)).toEqual(firstPayload);
        expect(mergeWebReportSlices(secondRows.slice, secondSupport.slice)).toEqual(secondPayload);
        expect(() => mergeWebReportSlices(firstRows.slice, secondSupport.slice)).toThrow(
          'Report slices must use the same revision',
        );
        const current = await registry.getCurrentManifest();
        expect(current.ok && current.manifest.revision).toBe(second.revision);
      },
    );
  });

  test('renews validated immutable artifacts without rematerializing Session SQLite', async () => {
    let materializations = 0;
    let now = 1000;
    const revisionIds = ['revision-a', 'revision-b'];
    await withRegistry(
      {
        materialize: async (directory) => {
          materializations++;
          await writeFile(path.join(directory, 'sessions.sqlite'), Buffer.from([0, 255, 1, 128]), { mode: 0o600 });
        },
        now: () => now,
        revisionId: () => revisionIds.shift() ?? 'unexpected',
        ttlMs: 120_000,
      },
      async (registry, rootDirectory) => {
        const published = await registry.publish(payloadFor('2026-07-13T12:00:00.000Z', 2));
        now += 60_000;
        const renewed = await registry.renewCurrent();
        if (!renewed.ok) {
          throw new Error('Expected the current report revision to renew');
        }

        expect(materializations).toBe(1);
        expect(renewed.manifest.revision).not.toBe(published.revision);
        expect(renewed.manifest.captureFingerprint).toBe(published.captureFingerprint);
        expect(renewed.manifest.generatedAt).toBe(published.generatedAt);
        expect(renewed.manifest.expiresAt).toBe(now + 120_000);
        for (const artifact of ['rows.json', 'support.json', 'sessions.sqlite']) {
          const original = await readFile(path.join(rootDirectory, String(published.revision), artifact));
          const copy = await readFile(path.join(rootDirectory, String(renewed.manifest.revision), artifact));
          expect(copy).toEqual(original);
          expect(
            privateMode((await stat(path.join(rootDirectory, String(renewed.manifest.revision), artifact))).mode),
          ).toBe(0o400);
        }
      },
    );
  });

  test('returns typed expiry and unavailable results after the TTL', async () => {
    let now = 1000;
    await withRegistry(
      { now: () => now, revisionId: () => 'revision-expiring', ttlMs: 10 },
      async (registry, rootDirectory) => {
        const manifest = await registry.publish(payloadFor('2026-07-13T12:00:00.000Z', 1));
        now += 10;
        const result = await registry.readRows({
          requestFingerprint: reportSliceRequestFingerprint('rows'),
          revision: manifest.revision,
        });

        expect(result).toEqual({
          error: {
            message: expect.stringContaining('request a new manifest'),
            revision: manifest.revision,
            tag: 'RevisionExpired',
          },
          ok: false,
          requestFingerprint: reportSliceRequestFingerprint('rows'),
        });
        expect(await registry.getCurrentManifest()).toEqual({
          error: { message: 'No current report revision is available.', tag: 'RevisionUnavailable' },
          ok: false,
          requestFingerprint: reportManifestRequestFingerprint,
        });
        expect(await readdir(rootDirectory)).toEqual([]);
        expect(await registry.withRevisionDirectory(manifest.revision, () => Promise.resolve('unreachable'))).toEqual({
          error: {
            message: expect.stringContaining('request a new manifest'),
            revision: manifest.revision,
            tag: 'RevisionExpired',
          },
          ok: false,
        });
      },
    );
  });

  test('reports the canonical fingerprint and rejects a mismatched request', async () => {
    await withRegistry({ revisionId: () => 'revision-a' }, async (registry) => {
      const manifest = await registry.publish(payloadFor('2026-07-13T12:00:00.000Z', 1));
      const result = await registry.readRows({
        requestFingerprint: parseReportRequestFingerprint('report-rows:v1:{"page":2}'),
        revision: manifest.revision,
      });

      expect(result).toEqual({
        error: {
          message: 'The report slice request fingerprint does not match the validated request.',
          revision: manifest.revision,
          tag: 'InvalidRequestFingerprint',
        },
        ok: false,
        requestFingerprint: reportSliceRequestFingerprint('rows'),
      });
    });
  });

  test('retains an in-flight prior revision until its reference is released', async () => {
    let releaseRead: (() => void) | undefined;
    const readMayContinue = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let referenceAcquired: (() => void) | undefined;
    const referenceWasAcquired = new Promise<void>((resolve) => {
      referenceAcquired = resolve;
    });
    const revisionIds = ['revision-a', 'revision-b'];
    await withRegistry(
      {
        maxRetainedRevisions: 1,
        revisionId: () => revisionIds.shift() ?? 'unexpected',
      },
      async (registry, rootDirectory) => {
        const first = await registry.publish(payloadFor('2026-07-13T12:00:00.000Z', 2));
        const inFlightRead = registry.withRevisionDirectory(first.revision, async (directory, manifest) => {
          referenceAcquired?.();
          await readMayContinue;
          return { files: await readdir(directory), revision: manifest.revision };
        });
        await referenceWasAcquired;
        await registry.publish(payloadFor('2026-07-13T13:00:00.000Z', 1));
        expect((await readdir(rootDirectory)).sort()).toEqual(['revision-a', 'revision-b']);

        releaseRead?.();
        const result = await inFlightRead;
        expect(result.ok && result.value.revision).toBe(first.revision);
        expect(result.ok && result.value.files.sort()).toEqual(['manifest.json', 'rows.json', 'support.json']);
        expect(await readdir(rootDirectory)).toEqual(['revision-b']);
      },
    );
  });

  test('keeps the published revision and removes staging files when publication fails', async () => {
    await withRegistry({ revisionId: () => 'duplicate-revision' }, async (registry, rootDirectory) => {
      const first = await registry.publish(payloadFor('2026-07-13T12:00:00.000Z', 1));
      await expect(registry.publish(payloadFor('2026-07-13T13:00:00.000Z', 2))).rejects.toThrow();

      const current = await registry.getCurrentManifest();
      expect(current.ok && current.manifest.revision).toBe(first.revision);
      expect(await readdir(rootDirectory)).toEqual(['duplicate-revision']);
    });
  });

  test('disposal removes managed revisions without deleting a caller-owned root', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'ai-usage-revision-owned-root-test-'));
    const rootDirectory = path.join(parent, 'caller-owned');
    const registry = createReportRevisionRegistry({ revisionId: () => 'revision-a', rootDirectory });
    try {
      await mkdir(rootDirectory, { mode: 0o700, recursive: true });
      const sentinelPath = path.join(rootDirectory, 'sentinel');
      await writeFile(sentinelPath, 'keep');
      await registry.publish(payloadFor('2026-07-13T12:00:00.000Z', 1));

      await registry.dispose();

      await access(sentinelPath);
      expect(await readdir(rootDirectory)).toEqual(['sentinel']);
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });
});
