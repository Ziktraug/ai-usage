import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { StoredReportCapture } from '@ai-usage/report-data';
import { demoReportPayload } from '../report-data';
import { parseReportRevision, toWebReportPayload } from '../web-report-payload';
import { ensurePublishedRevision } from './report-payload.server';
import { createReportRevisionRegistry, type ReportRevisionRegistry } from './report-revision.server';

test('publishes a fresh exact capture when the matched revision expires before renewal', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'ai-usage-report-publication-test-'));
  const rootDirectory = path.join(parent, 'revisions');
  let now = 1000;
  const revisionIds = ['revision-a', 'revision-b'];
  const registry = createReportRevisionRegistry({
    now: () => now,
    revisionId: () => revisionIds.shift() ?? 'unexpected',
    rootDirectory,
    ttlMs: 120_000,
  });
  try {
    const payload = structuredClone(demoReportPayload);
    const rowSourceAuthorities = payload.rows.map(() => 'local-observed' as const);
    const capture: StoredReportCapture = { payload, rowSourceAuthorities };
    const first = await registry.publish(toWebReportPayload(payload), { rowSourceAuthorities });
    now += 60_000;
    let expiredAfterMatch = false;
    const expiringRegistry: ReportRevisionRegistry = {
      ...registry,
      getCurrentManifestForCapture: async (privateCaptureFingerprint) => {
        const result = await registry.getCurrentManifestForCapture(privateCaptureFingerprint);
        if (!expiredAfterMatch) {
          expiredAfterMatch = true;
          now = first.expiresAt;
        }
        return result;
      },
    };

    const ensured = await ensurePublishedRevision(capture, {
      now: () => now,
      publications: new WeakMap(),
      registry: expiringRegistry,
    });

    expect(ensured.revision).toBe(parseReportRevision('revision-b'));
    const current = await registry.getCurrentManifest();
    expect(current.ok && current.manifest.revision).toBe(ensured.revision);
  } finally {
    await registry.dispose();
    await rm(parent, { force: true, recursive: true });
  }
});

test('does not reuse a cached payload object under a different source authority', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'ai-usage-report-publication-test-'));
  const rootDirectory = path.join(parent, 'revisions');
  const revisionIds = ['revision-a', 'revision-b'];
  const registry = createReportRevisionRegistry({
    revisionId: () => revisionIds.shift() ?? 'unexpected',
    rootDirectory,
  });
  try {
    const payload = structuredClone(demoReportPayload);
    const publications = new WeakMap();
    const dependencies = { now: Date.now, publications, registry };

    const first = await ensurePublishedRevision(
      { payload, rowSourceAuthorities: payload.rows.map(() => 'local-observed' as const) },
      dependencies,
    );
    const second = await ensurePublishedRevision(
      { payload, rowSourceAuthorities: payload.rows.map(() => 'portable-opaque' as const) },
      dependencies,
    );

    expect(second.revision).not.toBe(first.revision);
    expect(second.revision).toBe(parseReportRevision('revision-b'));
  } finally {
    await registry.dispose();
    await rm(parent, { force: true, recursive: true });
  }
});

test('publishes the requested capture when another capture wins during renewal', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'ai-usage-report-publication-test-'));
  const rootDirectory = path.join(parent, 'revisions');
  let now = 1000;
  const revisionIds = ['revision-a', 'revision-b', 'revision-c'];
  const registry = createReportRevisionRegistry({
    now: () => now,
    revisionId: () => revisionIds.shift() ?? 'unexpected',
    rootDirectory,
    ttlMs: 120_000,
  });
  try {
    const requestedPayload = structuredClone(demoReportPayload);
    const requestedAuthorities = requestedPayload.rows.map(() => 'local-observed' as const);
    const requestedCapture: StoredReportCapture = {
      payload: requestedPayload,
      rowSourceAuthorities: requestedAuthorities,
    };
    await registry.publish(toWebReportPayload(requestedPayload), {
      rowSourceAuthorities: requestedAuthorities,
    });
    now += 60_000;

    const competingPayload = structuredClone(demoReportPayload);
    competingPayload.rows = competingPayload.rows.slice(0, 1);
    const competingAuthorities = competingPayload.rows.map(() => 'portable-opaque' as const);
    let superseded = false;
    const racingRegistry: ReportRevisionRegistry = {
      ...registry,
      renewCurrentForCapture: async (expectedRevision, privateCaptureFingerprint) => {
        if (!superseded) {
          superseded = true;
          await registry.publish(toWebReportPayload(competingPayload), {
            rowSourceAuthorities: competingAuthorities,
          });
        }
        return await registry.renewCurrentForCapture(expectedRevision, privateCaptureFingerprint);
      },
    };

    const ensured = await ensurePublishedRevision(requestedCapture, {
      now: () => now,
      publications: new WeakMap(),
      registry: racingRegistry,
    });

    expect(ensured.revision).toBe(parseReportRevision('revision-c'));
    const current = await registry.getCurrentManifest();
    expect(current.ok && current.manifest.revision).toBe(ensured.revision);
  } finally {
    await registry.dispose();
    await rm(parent, { force: true, recursive: true });
  }
});
