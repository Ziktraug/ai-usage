import { createHash } from 'node:crypto';
import type { SessionDetailSourceAuthority } from './session-detail';

export const canonicalReportJson = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalReportJson);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalReportJson(child)]),
  );
};

/**
 * What a capture fingerprint hashes, before canonicalization: the payload without its publication
 * clocks (`generatedAt` and `machineFreshness.observedAt`), wrapped with the row source authorities
 * when they are given.
 *
 * This is the only definition of what a fingerprint leaves out. `reportCaptureFingerprintForPayload`
 * hashes its canonical JSON, and the usage store's publication calls it with a placeholder for
 * `rows` to hash the rows in one pass of its own. It must therefore hand `rows` over untouched and
 * never decide anything from their content.
 */
export const reportCaptureFingerprintInput = (
  payload: object,
  rowSourceAuthorities?: readonly SessionDetailSourceAuthority[],
): object => {
  const {
    generatedAt: _generatedAt,
    machineFreshness,
    ...payloadWithoutClocks
  } = payload as {
    generatedAt?: unknown;
    machineFreshness?: unknown;
  };
  const semanticMachineFreshness =
    typeof machineFreshness === 'object' && machineFreshness !== null && !Array.isArray(machineFreshness)
      ? Object.fromEntries(
          Object.entries(machineFreshness).filter(([key, value]) => key !== 'observedAt' && value !== undefined),
        )
      : machineFreshness;
  const semanticPayload =
    machineFreshness === undefined
      ? payloadWithoutClocks
      : { ...payloadWithoutClocks, machineFreshness: semanticMachineFreshness };
  return rowSourceAuthorities === undefined ? semanticPayload : { payload: semanticPayload, rowSourceAuthorities };
};

export const reportCaptureFingerprintForPayload = <Payload extends object>(
  payload: Payload,
  rowSourceAuthorities?: readonly SessionDetailSourceAuthority[],
): string =>
  createHash('sha256')
    .update(JSON.stringify(canonicalReportJson(reportCaptureFingerprintInput(payload, rowSourceAuthorities))))
    .digest('hex');
