import { describe, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
// biome-ignore lint/performance/noNamespaceImport: one test replaces an export of this module through its namespace
import * as reportCaptureFingerprint from '@ai-usage/report-core/report-capture-fingerprint';
import { reportCaptureFingerprintForPayload } from '@ai-usage/report-core/report-capture-fingerprint';
import type { SerializedRow } from '@ai-usage/report-core/report-data';
import type { SessionDetailSourceAuthority } from '@ai-usage/report-core/session-detail';
import { serializedRowsByteLength, servedReportCaptureFingerprints } from './served-report-store';

interface FingerprintCase {
  readonly localContext: object;
  readonly rows: readonly unknown[];
  readonly sourceAuthorities: readonly SessionDetailSourceAuthority[];
  readonly support: Record<string, unknown>;
}

/** What the publication used to compute: the reference, once per fingerprint. */
const referenceFingerprints = (input: FingerprintCase) => {
  const payload = { ...input.support, rows: input.rows };
  return {
    captureFingerprint: reportCaptureFingerprintForPayload(payload),
    privateCaptureFingerprint: reportCaptureFingerprintForPayload(
      { ...payload, localContext: input.localContext },
      input.sourceAuthorities,
    ),
  };
};

/** The publication's fingerprints beside the reference's; equal when the publication is right. */
const bothFingerprints = (input: FingerprintCase) => {
  const computed = servedReportCaptureFingerprints(input);
  const reference = referenceFingerprints(input);
  return {
    capture: computed.captureFingerprint === reference.captureFingerprint,
    privateCapture: computed.privateCaptureFingerprint === reference.privateCaptureFingerprint,
  };
};
const sameTwice = { capture: true, privateCapture: true };

const localContext = {
  machine: { id: 'machine-a', label: 'Machine A' },
  projectAliases: [{ match: ['raw'], name: 'Aliased' }],
  projectGroupConfigs: [],
};

const authorities = (count: number): SessionDetailSourceAuthority[] =>
  Array.from({ length: count }, (_, index) => (index % 3 === 0 ? 'portable-opaque' : 'local-observed'));

const row = (index: number): Record<string, unknown> => ({
  zeta: index,
  name: `session ${index} éà 🚀`,
  source: {
    sourceSessionId: `s-${index}`,
    machineId: 'machine-a',
    nested: { b: [3, { y: 1, x: undefined }], a: null },
  },
  models: ['gpt-5', 'claude-sonnet-4-6'],
  tokIn: index * 1.5,
  alpha: index % 2 === 0,
  optional: undefined,
});

// A small deterministic generator, so a failure names a reproducible payload.
const generator = (seed: number) => {
  let state = seed;
  const next = (): number => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
  const keys = [
    'a',
    'B',
    'rows',
    'payload',
    '10',
    '2',
    'é',
    'z',
    'generatedAt',
    'observedAt',
    'a b',
    'A',
    // The members the reference treats specially, or that the two fingerprints place differently.
    'machineFreshness',
    'datasets',
    'localContext',
  ];
  const texts = ['', 'plain', 'quote " and \\ backslash', 'été 🚀', 'line\nbreak', '\ud800 lone', '],[', '"rows":'];
  const value = (depth: number): unknown => {
    const pick = next();
    if (depth > 3 || pick < 0.25) {
      return [1, -0, 2.5, null, true, false, undefined, Number.NaN][Math.floor(next() * 8)];
    }
    if (pick < 0.5) {
      return texts[Math.floor(next() * texts.length)];
    }
    if (pick < 0.7) {
      return Array.from({ length: Math.floor(next() * 4) }, () => value(depth + 1));
    }
    return Object.fromEntries(
      Array.from({ length: Math.floor(next() * 5) }, () => [keys[Math.floor(next() * keys.length)], value(depth + 1)]),
    );
  };
  return { next, value };
};

describe('served report capture fingerprints', () => {
  test('equal the reference for an empty capture and for one row', () => {
    expect(bothFingerprints({ localContext, rows: [], sourceAuthorities: [], support: { timeZone: 'UTC' } })).toEqual(
      sameTwice,
    );
    expect(
      bothFingerprints({
        localContext,
        rows: [row(1)],
        sourceAuthorities: ['local-observed'],
        support: { timeZone: 'UTC' },
      }),
    ).toEqual(sameTwice);
  });

  test('equal the reference whatever surrounds the rows: clocks, freshness and key order', () => {
    const rows = [row(1), row(2), row(3)];
    const supports: Record<string, unknown>[] = [
      { analytics: { sessionCount: 3 }, generatedAt: '2026-07-29T12:00:00.000Z', timeZone: 'UTC' },
      {
        generatedAt: '2026-07-29T12:00:00.000Z',
        machineFreshness: {
          kind: 'available',
          machines: [{ id: 'machine-a', lastSeenAt: '2026-07-29T12:00:00.000Z' }],
          observedAt: '2026-07-29T12:00:00.000Z',
          omitted: undefined,
        },
        zLast: 1,
        aFirst: { rows: 'not the rows', sorted: [3, 1, 2] },
      },
      { machineFreshness: null, timeZone: 'Europe/Paris' },
      { machineFreshness: ['not', 'a', 'record'], timeZone: 'UTC' },
      { machineFreshness: 'unavailable', undefinedMember: undefined },
      // A key that sorts after `rows`, one that sorts before it, and an index-like key.
      { rowz: 1, row: 2, 7: 'seven', rows: 'replaced by the capture rows' },
      // A dataset's own clock is content, and a support member named like the private context is
      // replaced by it in the private fingerprint only.
      {
        datasets: {
          machineFreshness: { observedAt: '2026-07-29T12:00:00.000Z' },
          providerStatus: { generatedAt: '2026-07-29T12:00:00.000Z', observedAt: '2026-07-29T12:00:00.000Z' },
        },
        generatedAt: '2026-07-29T12:00:00.000Z',
        localContext: { generatedAt: '2026-07-29T12:00:00.000Z', machineFreshness: { observedAt: 'kept' } },
        machineFreshness: { datasets: [], localContext: null, observedAt: '2026-07-29T12:00:00.000Z' },
      },
    ];
    for (const support of supports) {
      expect(bothFingerprints({ localContext, rows, sourceAuthorities: authorities(rows.length), support })).toEqual(
        sameTwice,
      );
    }
  });

  test('ignore the publication clocks exactly as the reference does', () => {
    const rows = [row(1)];
    const at = (clock: string) =>
      servedReportCaptureFingerprints({
        localContext,
        rows,
        sourceAuthorities: ['local-observed'],
        support: { generatedAt: clock, machineFreshness: { kind: 'available', observedAt: clock }, timeZone: 'UTC' },
      });

    expect(at('2026-07-29T12:00:00.000Z')).toEqual(at('2026-07-29T12:01:00.000Z'));
  });

  test('take the clocks to leave out from the reference, so the two cannot drift apart', () => {
    // The validator of a stored revision recomputes both fingerprints with the reference. If the
    // reference ever leaves out one more member, the publication must leave it out too, including
    // a member no other test payload carries. `datasets` stands for that member here.
    const original = reportCaptureFingerprint.reportCaptureFingerprintInput;
    const withoutDatasets = (input: object, rowSourceAuthorities?: readonly SessionDetailSourceAuthority[]) => {
      const { datasets: _datasets, ...rest } = input as Record<string, unknown>;
      return original(rest, rowSourceAuthorities);
    };
    const sha256OfCanonicalJson = (value: unknown): string =>
      createHash('sha256')
        .update(JSON.stringify(reportCaptureFingerprint.canonicalReportJson(value)))
        .digest('hex');
    const rows = [row(1), row(2)];
    const sourceAuthorities = authorities(rows.length);
    const support = (datasetClock: string) => ({
      datasets: { providerStatus: { generatedAt: datasetClock } },
      generatedAt: '2026-07-29T12:00:00.000Z',
      timeZone: 'UTC',
    });
    const payload = { ...support('2026-07-29T12:00:00.000Z'), rows };
    const at = (datasetClock: string) =>
      servedReportCaptureFingerprints({ localContext, rows, sourceAuthorities, support: support(datasetClock) });

    const spy = spyOn(reportCaptureFingerprint, 'reportCaptureFingerprintInput').mockImplementation(withoutDatasets);
    try {
      expect(at('2026-07-29T12:00:00.000Z')).toEqual({
        captureFingerprint: sha256OfCanonicalJson(withoutDatasets(payload)),
        privateCaptureFingerprint: sha256OfCanonicalJson(
          withoutDatasets({ ...payload, localContext }, sourceAuthorities),
        ),
      });
      expect(at('2026-07-29T12:01:00.000Z')).toEqual(at('2026-07-29T12:00:00.000Z'));
    } finally {
      spy.mockRestore();
    }

    // Restored: the dataset clock is content again, as the reference says.
    expect(reportCaptureFingerprint.reportCaptureFingerprintInput).toBe(original);
    expect(at('2026-07-29T12:01:00.000Z')).not.toEqual(at('2026-07-29T12:00:00.000Z'));
    expect(
      bothFingerprints({ localContext, rows, sourceAuthorities, support: support('2026-07-29T12:01:00.000Z') }),
    ).toEqual(sameTwice);
  });

  test('change with a row, with its position, with the local context and with a source authority', () => {
    const rows = [row(1), row(2)];
    const base = { localContext, rows, sourceAuthorities: authorities(2), support: { timeZone: 'UTC' } };
    const fingerprints = servedReportCaptureFingerprints(base);
    const changedRow = servedReportCaptureFingerprints({ ...base, rows: [row(1), { ...row(2), tokIn: 4 }] });
    const reordered = servedReportCaptureFingerprints({ ...base, rows: [row(2), row(1)] });
    const otherContext = servedReportCaptureFingerprints({
      ...base,
      localContext: { ...localContext, machine: { id: 'machine-b', label: 'Machine B' } },
    });
    const otherAuthority = servedReportCaptureFingerprints({
      ...base,
      sourceAuthorities: ['local-observed', 'local-observed'],
    });

    expect(changedRow.captureFingerprint).not.toBe(fingerprints.captureFingerprint);
    expect(changedRow.privateCaptureFingerprint).not.toBe(fingerprints.privateCaptureFingerprint);
    expect(reordered.captureFingerprint).not.toBe(fingerprints.captureFingerprint);
    // The public fingerprint does not see the private material; the private one does.
    expect(otherContext.captureFingerprint).toBe(fingerprints.captureFingerprint);
    expect(otherContext.privateCaptureFingerprint).not.toBe(fingerprints.privateCaptureFingerprint);
    expect(otherAuthority.captureFingerprint).toBe(fingerprints.captureFingerprint);
    expect(otherAuthority.privateCaptureFingerprint).not.toBe(fingerprints.privateCaptureFingerprint);
  });

  test('equal the reference across the digest chunk boundary', () => {
    // 4,000 rows of roughly 250 characters cross the 64 KiB chunk many times.
    const rows = Array.from({ length: 4000 }, (_, index) => row(index));
    expect(
      bothFingerprints({
        localContext,
        rows,
        sourceAuthorities: authorities(rows.length),
        support: { analytics: { sessionCount: rows.length }, timeZone: 'UTC' },
      }),
    ).toEqual(sameTwice);
  });

  test('equal the reference on generated payloads, including values JSON drops or rewrites', () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const { next, value } = generator(seed);
      const rows = Array.from({ length: Math.floor(next() * 6) }, () => value(0));
      const candidate = value(1);
      const support: Record<string, unknown> = {
        ...(typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate) ? candidate : {}),
        nested: value(0),
        timeZone: 'UTC',
      };
      const input = { localContext: { context: value(0) }, rows, sourceAuthorities: authorities(rows.length), support };
      expect({ fingerprints: servedReportCaptureFingerprints(input), seed }).toEqual({
        fingerprints: referenceFingerprints(input),
        seed,
      });
    }
  });
});

describe('serialized rows byte length', () => {
  const serializedRow = (name: string): SerializedRow => ({
    activeDate: '2026-07-01T10:01:00.000Z',
    calls: 1,
    costActual: null,
    costApprox: 0.5,
    costKnown: true,
    date: '2026-07-01T10:00:00.000Z',
    durationMs: 1000,
    endDate: '2026-07-01T10:01:00.000Z',
    freshTokens: 3,
    harness: 'Codex',
    lineDelta: null,
    linesAdded: null,
    linesDeleted: null,
    model: 'gpt-5',
    name,
    project: 'ai-usage',
    provider: 'OpenAI',
    sessionLabel: name,
    tokCr: 0,
    tokCw: 0,
    tokIn: 3,
    tokOut: 0,
    tokenTotal: 3,
    tools: 0,
    turns: 1,
  });

  test('is the byte length of the whole serialized array for zero, one and many rows', () => {
    const many = Array.from({ length: 257 }, (_, index) => serializedRow(`session ${index}`));
    for (const rows of [[], [serializedRow('only')], many]) {
      expect(serializedRowsByteLength(rows)).toBe(Buffer.byteLength(JSON.stringify(rows)));
    }
  });

  test('counts bytes, not characters, and the escapes JSON adds', () => {
    const rows = [
      serializedRow('\u00e9t\u00e9 \ud83d\ude80 \u4e2d\u6587'),
      serializedRow('quote " backslash \\ newline \n tab \t'),
      serializedRow('\ud800 lone surrogate'),
    ];

    expect(serializedRowsByteLength(rows)).toBe(Buffer.byteLength(JSON.stringify(rows)));
  });
});
