import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sessionRowIdentity } from '@ai-usage/report-core/session-query';
import { demoReportPayload } from '../report-data';
import {
  mergeWebReportSlices,
  parseReportRequestFingerprint,
  reportManifestRequestFingerprint,
  reportSliceRequestFingerprint,
  toWebReportPayload,
  type WebReportPayload,
} from '../web-report-payload';
import {
  createReportRevisionRegistry,
  type ReportRevisionRegistryOptions,
  reportCaptureFingerprintForPayload,
} from './report-revision.server';

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
  test('binds the private row authorities into the capture fingerprint', () => {
    const payload = payloadFor('2026-07-13T12:00:00.000Z', 2);
    const localAuthorities = ['local-observed', 'local-observed'] as const;
    const mixedAuthorities = ['local-observed', 'portable-opaque'] as const;

    expect(reportCaptureFingerprintForPayload(payload, localAuthorities)).not.toBe(
      reportCaptureFingerprintForPayload(payload, mixedAuthorities),
    );
    expect(
      reportCaptureFingerprintForPayload({ ...payload, generatedAt: '2026-07-14T12:00:00.000Z' }, localAuthorities),
    ).toBe(reportCaptureFingerprintForPayload(payload, localAuthorities));
  });

  test('publishes owner-only immutable slices atomically from one payload capture', async () => {
    let materializedAuthorities: unknown;
    await withRegistry(
      {
        materialize: async (directory) => {
          materializedAuthorities = JSON.parse(
            await readFile(path.join(directory, 'row-source-authorities.json'), 'utf8'),
          );
          await writeFile(path.join(directory, 'sessions.sqlite'), 'sqlite', { mode: 0o600 });
        },
        revisionId: () => 'revision-a',
      },
      async (registry, rootDirectory) => {
        const payload = payloadFor('2026-07-13T12:00:00.000Z', 2);
        const captured = structuredClone(payload);
        const manifest = await registry.publish(payload, {
          rowSourceAuthorities: ['local-observed', 'portable-opaque'],
        });
        expect(manifest.captureFingerprint).toBe(reportCaptureFingerprintForPayload(captured));
        expect(manifest.captureFingerprint).not.toBe(
          reportCaptureFingerprintForPayload(captured, ['local-observed', 'portable-opaque']),
        );
        expect(
          (
            await registry.getCurrentManifestForCapture(
              reportCaptureFingerprintForPayload(captured, ['local-observed', 'portable-opaque']),
            )
          ).ok,
        ).toBe(true);
        expect(
          (
            await registry.getCurrentManifestForCapture(
              reportCaptureFingerprintForPayload(captured, ['portable-opaque', 'portable-opaque']),
            )
          ).ok,
        ).toBe(false);
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
        const [firstCapturedRow, secondCapturedRow] = captured.rows;
        if (!(firstCapturedRow && secondCapturedRow)) {
          throw new Error('Expected two captured report rows');
        }
        expect(materializedAuthorities).toEqual([
          { rowId: sessionRowIdentity(firstCapturedRow), sourceAuthority: 'local-observed' },
          { rowId: sessionRowIdentity(secondCapturedRow), sourceAuthority: 'portable-opaque' },
        ]);

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

  test('rejects a tampered Session database before creating its stable snapshot', async () => {
    await withRegistry(
      {
        materialize: (directory) => writeFile(path.join(directory, 'sessions.sqlite'), 'sqlite', { mode: 0o600 }),
        revisionId: () => 'revision-a',
      },
      async (registry, rootDirectory) => {
        const published = await registry.publish(payloadFor('2026-07-13T12:00:00.000Z', 1));
        const databasePath = path.join(rootDirectory, String(published.revision), 'sessions.sqlite');
        await chmod(databasePath, 0o600);
        await writeFile(databasePath, 'tampered');
        let queried = false;

        await expect(
          registry.withSessionQueryLease(published.revision, () => {
            queried = true;
            return Promise.resolve();
          }),
        ).rejects.toThrow('does not match its manifest');
        expect(queried).toBe(false);
      },
    );
  });

  test('reuses one private stable Session snapshot and removes it with its revision', async () => {
    const revisionIds = ['revision-a', 'revision-b'];
    await withRegistry(
      {
        materialize: (directory) => writeFile(path.join(directory, 'sessions.sqlite'), 'sqlite', { mode: 0o600 }),
        maxRetainedRevisions: 1,
        revisionId: () => revisionIds.shift() ?? 'unexpected',
      },
      async (registry, rootDirectory) => {
        const published = await registry.publish(payloadFor('2026-07-13T12:00:00.000Z', 1));
        const publishedDatabasePath = path.join(rootDirectory, String(published.revision), 'sessions.sqlite');
        const leasedDirectories: string[] = [];
        let observedLease: { contents: string; mode: number } | undefined;

        await expect(
          registry.withSessionQueryLease(published.revision, async (directory) => {
            leasedDirectories.push(directory);
            await chmod(publishedDatabasePath, 0o600);
            await writeFile(publishedDatabasePath, 'tampered-after-validation');
            observedLease = {
              contents: await readFile(path.join(directory, 'sessions.sqlite'), 'utf8'),
              mode: privateMode((await stat(path.join(directory, 'sessions.sqlite'))).mode),
            };
            throw new Error('query failed');
          }),
        ).rejects.toThrow('query failed');

        expect(observedLease).toEqual({ contents: 'sqlite', mode: 0o400 });
        const secondLease = await registry.withSessionQueryLease(published.revision, async (directory) => {
          leasedDirectories.push(directory);
          return await readFile(path.join(directory, 'sessions.sqlite'), 'utf8');
        });
        expect(secondLease.ok && secondLease.value).toBe('sqlite');
        expect(leasedDirectories).toHaveLength(2);
        expect(leasedDirectories[1]).toBe(leasedDirectories[0]);

        await registry.publish(payloadFor('2026-07-13T13:00:00.000Z', 1));
        await expect(access(leasedDirectories[0] ?? '')).rejects.toThrow();
      },
    );
  });

  test('rejects a same-size mutation of a previously validated Session snapshot', async () => {
    await withRegistry(
      {
        materialize: (directory) => writeFile(path.join(directory, 'sessions.sqlite'), 'sqlite', { mode: 0o600 }),
        revisionId: () => 'revision-a',
      },
      async (registry) => {
        const published = await registry.publish(payloadFor('2026-07-13T12:00:00.000Z', 1));
        let snapshotDirectory: string | undefined;
        await registry.withSessionQueryLease(published.revision, (directory) => {
          snapshotDirectory = directory;
          return Promise.resolve();
        });
        if (!snapshotDirectory) {
          throw new Error('Expected a validated Session snapshot');
        }
        const snapshotPath = path.join(snapshotDirectory, 'sessions.sqlite');
        await chmod(snapshotDirectory, 0o700);
        await chmod(snapshotPath, 0o600);
        await writeFile(snapshotPath, 'forged');
        await chmod(snapshotPath, 0o400);
        await chmod(snapshotDirectory, 0o500);
        let queried = false;

        await expect(
          registry.withSessionQueryLease(published.revision, () => {
            queried = true;
            return Promise.resolve();
          }),
        ).rejects.toThrow('changed since validation');
        expect(queried).toBe(false);
      },
    );
  });

  test('rejects a Session result when its snapshot changes during the lease', async () => {
    await withRegistry(
      {
        materialize: (directory) => writeFile(path.join(directory, 'sessions.sqlite'), 'sqlite', { mode: 0o600 }),
        revisionId: () => 'revision-a',
      },
      async (registry) => {
        const published = await registry.publish(payloadFor('2026-07-13T12:00:00.000Z', 1));

        await expect(
          registry.withSessionQueryLease(published.revision, async (directory) => {
            const snapshotPath = path.join(directory, 'sessions.sqlite');
            await chmod(directory, 0o700);
            await chmod(snapshotPath, 0o600);
            await writeFile(snapshotPath, 'forged');
            await chmod(snapshotPath, 0o400);
            await chmod(directory, 0o500);
            return 'untrusted-result';
          }),
        ).rejects.toThrow('changed since validation');
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
        const payload = payloadFor('2026-07-13T12:00:00.000Z', 2);
        const sourceAuthorities = payload.rows.map(() => 'portable-opaque' as const);
        const published = await registry.publish(payload);
        now += 60_000;
        const renewed = await registry.renewCurrentForCapture(
          published.revision,
          reportCaptureFingerprintForPayload(payload, sourceAuthorities),
        );
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

  test('rejects renewal when a coherent disk manifest attempts to bless a replaced Session database', async () => {
    const revisionIds = ['revision-a', 'revision-b'];
    await withRegistry(
      {
        materialize: (directory) => writeFile(path.join(directory, 'sessions.sqlite'), 'sqlite', { mode: 0o600 }),
        revisionId: () => revisionIds.shift() ?? 'unexpected',
      },
      async (registry, rootDirectory) => {
        const payload = payloadFor('2026-07-13T12:00:00.000Z', 1);
        const sourceAuthorities = ['local-observed'] as const;
        const published = await registry.publish(payload, { rowSourceAuthorities: sourceAuthorities });
        const privateFingerprint = reportCaptureFingerprintForPayload(payload, sourceAuthorities);
        const revisionDirectory = path.join(rootDirectory, String(published.revision));
        const databasePath = path.join(revisionDirectory, 'sessions.sqlite');
        const manifestPath = path.join(revisionDirectory, 'manifest.json');
        const originalHash = createHash('sha256').update('sqlite').digest('hex');
        const forgedHash = createHash('sha256').update('forged').digest('hex');
        await chmod(revisionDirectory, 0o700);
        await chmod(databasePath, 0o600);
        await writeFile(databasePath, 'forged');
        await chmod(manifestPath, 0o600);
        const forgedManifest = (await readFile(manifestPath, 'utf8')).replace(originalHash, forgedHash);
        expect(forgedManifest).toContain(forgedHash);
        await writeFile(manifestPath, forgedManifest);

        await expect(registry.renewCurrentForCapture(published.revision, privateFingerprint)).rejects.toThrow(
          'manifest does not match',
        );
      },
    );
  });

  test('does not renew a different capture that superseded the matched revision', async () => {
    let now = 1000;
    const revisionIds = ['revision-a', 'revision-b', 'revision-c'];
    await withRegistry(
      {
        now: () => now,
        revisionId: () => revisionIds.shift() ?? 'unexpected',
        ttlMs: 120_000,
      },
      async (registry) => {
        const firstPayload = payloadFor('2026-07-13T12:00:00.000Z', 1);
        const firstAuthorities = ['local-observed'] as const;
        const firstFingerprint = reportCaptureFingerprintForPayload(firstPayload, firstAuthorities);
        const first = await registry.publish(firstPayload, { rowSourceAuthorities: firstAuthorities });
        expect((await registry.getCurrentManifestForCapture(firstFingerprint)).ok).toBe(true);

        now += 60_000;
        const second = await registry.publish(payloadFor('2026-07-13T13:00:00.000Z', 2));
        const renewal = await registry.renewCurrentForCapture(first.revision, firstFingerprint);

        expect(renewal.ok).toBe(false);
        const current = await registry.getCurrentManifest();
        expect(current.ok && current.manifest.revision).toBe(second.revision);
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
        expect(await registry.withSessionQueryLease(manifest.revision, () => Promise.resolve('unreachable'))).toEqual({
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
        materialize: (directory) => writeFile(path.join(directory, 'sessions.sqlite'), 'sqlite', { mode: 0o600 }),
        maxRetainedRevisions: 1,
        revisionId: () => revisionIds.shift() ?? 'unexpected',
      },
      async (registry, rootDirectory) => {
        const first = await registry.publish(payloadFor('2026-07-13T12:00:00.000Z', 2));
        const inFlightRead = registry.withSessionQueryLease(first.revision, async (directory, manifest) => {
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
        expect(result.ok && result.value.files).toEqual(['sessions.sqlite']);
        expect(await readdir(rootDirectory)).toEqual(['revision-b']);
      },
    );
  });

  test('does not let an older slow assembly replace a newer publication', async () => {
    let releaseOlder: (() => void) | undefined;
    const olderMayFinish = new Promise<void>((resolve) => {
      releaseOlder = resolve;
    });
    let olderStarted: (() => void) | undefined;
    const olderDidStart = new Promise<void>((resolve) => {
      olderStarted = resolve;
    });
    const revisionIds = ['revision-older', 'revision-newer'];
    await withRegistry(
      {
        materialize: async (directory) => {
          if (directory.includes('revision-older')) {
            olderStarted?.();
            await olderMayFinish;
          }
          await writeFile(path.join(directory, 'sessions.sqlite'), 'sqlite', { mode: 0o600 });
        },
        revisionId: () => revisionIds.shift() ?? 'unexpected',
      },
      async (registry) => {
        const older = registry.publish(payloadFor('2026-07-13T12:00:00.000Z', 1));
        await olderDidStart;
        const newer = await registry.publish(payloadFor('2026-07-13T13:00:00.000Z', 2));
        releaseOlder?.();
        await older;
        const current = await registry.getCurrentManifest();
        expect(current.ok && current.manifest.revision).toBe(newer.revision);
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

  test('disposal drains active Session leases before removing their snapshots', async () => {
    let finishLease: (() => void) | undefined;
    const leaseMayFinish = new Promise<void>((resolve) => {
      finishLease = resolve;
    });
    let leaseStarted: (() => void) | undefined;
    const leaseDidStart = new Promise<void>((resolve) => {
      leaseStarted = resolve;
    });
    await withRegistry(
      {
        materialize: (directory) => writeFile(path.join(directory, 'sessions.sqlite'), 'sqlite', { mode: 0o600 }),
        revisionId: () => 'revision-a',
      },
      async (registry) => {
        const published = await registry.publish(payloadFor('2026-07-13T12:00:00.000Z', 1));
        let snapshotDirectory: string | undefined;
        const activeLease = registry.withSessionQueryLease(published.revision, async (directory) => {
          snapshotDirectory = directory;
          leaseStarted?.();
          await leaseMayFinish;
          return await readFile(path.join(directory, 'sessions.sqlite'), 'utf8');
        });
        await leaseDidStart;
        let disposalFinished = false;
        const disposal = registry.dispose().then(() => {
          disposalFinished = true;
        });

        const refusedLease = await registry.withSessionQueryLease(published.revision, () =>
          Promise.resolve('unreachable'),
        );
        expect(refusedLease.ok).toBe(false);
        expect(disposalFinished).toBe(false);
        await access(snapshotDirectory ?? 'missing');

        finishLease?.();
        const result = await activeLease;
        await disposal;
        expect(result.ok && result.value).toBe('sqlite');
        await expect(access(snapshotDirectory ?? 'missing')).rejects.toThrow();
      },
    );
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
