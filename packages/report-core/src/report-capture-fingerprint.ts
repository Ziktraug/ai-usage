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

export const reportCaptureFingerprintForPayload = <Payload extends object>(
  payload: Payload,
  rowSourceAuthorities?: readonly SessionDetailSourceAuthority[],
): string => {
  const {
    generatedAt: _generatedAt,
    machineFreshness,
    ...payloadWithoutClocks
  } = payload as Payload & {
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
  const fingerprintInput =
    rowSourceAuthorities === undefined ? semanticPayload : { payload: semanticPayload, rowSourceAuthorities };
  return createHash('sha256')
    .update(JSON.stringify(canonicalReportJson(fingerprintInput)))
    .digest('hex');
};
