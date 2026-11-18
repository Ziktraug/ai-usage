import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  canonicalReportJson,
  reportCaptureFingerprintForPayload,
  reportCaptureFingerprintInput,
} from './report-capture-fingerprint';

const payload = {
  timeZone: 'UTC',
  generatedAt: '2026-07-29T12:00:00.000Z',
  machineFreshness: {
    kind: 'available',
    machines: [{ id: 'machine-a', lastSeenAt: '2026-07-29T11:59:00.000Z' }],
    observedAt: '2026-07-29T12:00:00.000Z',
    omitted: undefined,
  },
  datasets: { providerStatus: { generatedAt: '2026-07-29T12:00:00.000Z', windows: [] } },
  analytics: { sessionCount: 1 },
  rows: [{ name: 'session 1', generatedAt: 'kept inside a row', tokIn: 3, machineFreshness: { observedAt: 'kept' } }],
};
const localContext = { machine: { id: 'machine-a', label: 'Machine A' }, projectAliases: [], projectGroupConfigs: [] };

const sha256OfCanonicalJson = (value: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(canonicalReportJson(value)))
    .digest('hex');

describe('report capture fingerprint input', () => {
  test('leaves out the publication clocks and nothing else', () => {
    expect(reportCaptureFingerprintInput(payload)).toEqual({
      timeZone: 'UTC',
      machineFreshness: {
        kind: 'available',
        machines: [{ id: 'machine-a', lastSeenAt: '2026-07-29T11:59:00.000Z' }],
      },
      // Only the two publication clocks are left out: a dataset's own clock and a row's members stay.
      datasets: { providerStatus: { generatedAt: '2026-07-29T12:00:00.000Z', windows: [] } },
      analytics: { sessionCount: 1 },
      rows: [
        { name: 'session 1', generatedAt: 'kept inside a row', tokIn: 3, machineFreshness: { observedAt: 'kept' } },
      ],
    });
  });

  test('hands the rows over untouched, so a caller may fingerprint them apart from what surrounds them', () => {
    const rows = [{ generatedAt: 'kept', machineFreshness: { observedAt: 'kept' } }];
    const input = reportCaptureFingerprintInput({ generatedAt: 'dropped', rows }) as { rows: unknown };

    expect(input.rows).toBe(rows);
  });

  test('keeps a machine freshness that is not a record as it is, and adds none when the payload has none', () => {
    expect(reportCaptureFingerprintInput({ machineFreshness: null, rows: [] })).toEqual({
      machineFreshness: null,
      rows: [],
    });
    expect(reportCaptureFingerprintInput({ machineFreshness: 'unavailable', rows: [] })).toEqual({
      machineFreshness: 'unavailable',
      rows: [],
    });
    expect(reportCaptureFingerprintInput({ machineFreshness: [{ observedAt: 'kept' }], rows: [] })).toEqual({
      machineFreshness: [{ observedAt: 'kept' }],
      rows: [],
    });
    expect(Object.keys(reportCaptureFingerprintInput({ generatedAt: 'dropped', rows: [] }))).toEqual(['rows']);
  });

  test('wraps the payload with the row source authorities when they are given', () => {
    expect(
      reportCaptureFingerprintInput({ generatedAt: 'dropped', localContext, rows: [] }, ['local-observed']),
    ).toEqual({ payload: { localContext, rows: [] }, rowSourceAuthorities: ['local-observed'] });
    expect(reportCaptureFingerprintInput({ rows: [] }, [])).toEqual({
      payload: { rows: [] },
      rowSourceAuthorities: [],
    });
  });
});

describe('report capture fingerprint', () => {
  test('is the SHA-256 of the canonical JSON of its input', () => {
    expect(reportCaptureFingerprintForPayload(payload)).toBe(
      sha256OfCanonicalJson(reportCaptureFingerprintInput(payload)),
    );
    expect(reportCaptureFingerprintForPayload({ ...payload, localContext }, ['local-observed'])).toBe(
      sha256OfCanonicalJson(reportCaptureFingerprintInput({ ...payload, localContext }, ['local-observed'])),
    );
  });

  // Recorded from the implementation before the input step was extracted: stored revisions carry
  // these digests, so they must not move.
  test('keeps the digests stored revisions already carry', () => {
    expect(reportCaptureFingerprintForPayload(payload)).toBe(
      '3c758e1b6bdc79a1536fdb766bf09bf330816d51504665826bf3508a132d0468',
    );
    expect(reportCaptureFingerprintForPayload({ ...payload, localContext }, ['local-observed'])).toBe(
      '7bdb92d5a71945fac40529c05ae4b83aacd85ffb202bb3e7e8a1ec26e06c4731',
    );
    expect(reportCaptureFingerprintForPayload({ rows: [], machineFreshness: 'unavailable' })).toBe(
      '67a003ce7d3fb211fc25ee5166e6faf130591397ce6904495add096e0e3d3f40',
    );
    expect(reportCaptureFingerprintForPayload({ rows: [], machineFreshness: null })).toBe(
      'ad5d1ba5503ac6ecc18be01a3c38550200ed519b64b6f0bc0f06f71acb9d8e62',
    );
    expect(reportCaptureFingerprintForPayload({ rows: [], machineFreshness: [{ observedAt: 'x' }] })).toBe(
      '9fec93721241eef1fb2d3aeb7ab64e510a0c5b9b21a696b391a9cfda3ad5d6e5',
    );
  });

  test('does not move with the publication clocks, and moves with a dataset clock', () => {
    const later = {
      ...payload,
      generatedAt: '2026-07-29T12:01:00.000Z',
      machineFreshness: { ...payload.machineFreshness, observedAt: '2026-07-29T12:01:00.000Z' },
    };
    const otherDatasetClock = {
      ...payload,
      datasets: { providerStatus: { generatedAt: '2026-07-29T12:01:00.000Z', windows: [] } },
    };

    expect(reportCaptureFingerprintForPayload(later)).toBe(reportCaptureFingerprintForPayload(payload));
    expect(reportCaptureFingerprintForPayload(otherDatasetClock)).not.toBe(reportCaptureFingerprintForPayload(payload));
  });
});
