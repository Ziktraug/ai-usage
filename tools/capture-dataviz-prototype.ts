/** Capture a content-free, immutable real-data preview. Opens SQLite read-only. */

import { Database } from 'bun:sqlite';
import { chmod, mkdir, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { deriveSessionRounds, parseSessionDetailResponse } from '@ai-usage/report-core/session-detail';
import type { SessionPresentationRow } from '@ai-usage/report-core/session-query';
import { usageRowModelContributions } from '@ai-usage/report-core/usage-row';
import type { WebContractClient } from '@ai-usage/web-contract';
import {
  type DatavizPrototypeSnapshot,
  datavizPrototypeSnapshotSchema,
} from '@ai-usage/web-contract/dataviz-prototype';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import { parse } from 'valibot';

const dbPath = process.env.AI_USAGE_DATABASE_PATH ?? resolve(homedir(), '.config/ai-usage/usage-store.sqlite');
const outputDirectory = resolve('.agent-memory/dataviz-real-data');
await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
await chmod(outputDirectory, 0o700);
const db = new Database(dbPath, { readonly: true });
db.exec('PRAGMA query_only=ON');
const capture = db.transaction(() => {
  const manifest = db
    .query<{ revision: string; generated_at: string; row_count: number; rows_bytes: number }, []>(
      'SELECT r.revision,r.generated_at,r.row_count,r.rows_bytes FROM served_report_revisions r JOIN served_report_current c USING(revision) WHERE r.complete=1',
    )
    .get();
  if (!manifest || manifest.row_count > 20_000 || manifest.rows_bytes > 64 * 1024 * 1024) {
    throw new Error('No complete report within the prototype bounds.');
  }
  const stored = db
    .query<
      { row_json: string; campaign_key: string | null; campaign_label: string | null; campaign_root: number },
      [string]
    >(
      'SELECT row_json,campaign_key,campaign_label,campaign_root FROM served_report_rows WHERE revision=? ORDER BY ordinal LIMIT 20001',
    )
    .all(manifest.revision);
  if (stored.length !== manifest.row_count) {
    throw new Error('Incomplete revision capture.');
  }
  return { manifest, stored };
})();
db.close();
const sourceKey = (machine: string | undefined, harness: string | undefined, id: string | null | undefined) =>
  id ? `${machine ?? ''}:${harness ?? ''}:${id}` : null;
const rows = capture.stored.map((entry) => {
  const r: SessionPresentationRow = JSON.parse(entry.row_json);
  return {
    id: r.rowId,
    sourceId: sourceKey(r.source?.machineId, r.source?.harnessKey, r.source?.sourceSessionId),
    parentId: sourceKey(r.source?.machineId, r.source?.harnessKey, r.source?.parentSourceSessionId),
    campaign: entry.campaign_key ?? r.rowId,
    campaignLabel: (entry.campaign_label ?? r.sessionLabel).slice(0, 200),
    root: entry.campaign_root === 1,
    label: r.sessionLabel.slice(0, 200),
    harness: r.harness,
    project: r.projectKey,
    projectLabel: r.projectLabel,
    day: r.activeDate?.slice(0, 10) ?? null,
    tokens: r.tokenTotal,
    partial: r.partial === true || r.usageUnavailable === true,
    segments: usageRowModelContributions(r).map((s) => ({
      model: s.model,
      tokens: s.tokCr + s.tokCw + s.tokIn + s.tokOut,
    })),
  };
});
const sourceRows = new Map(rows.filter((r) => r.sourceId).map((r) => [r.sourceId, r]));
const campaignCounts = new Map<string, number>();
for (const r of rows) {
  campaignCounts.set(r.campaign, (campaignCounts.get(r.campaign) ?? 0) + 1);
}
const candidates = ['Claude Code', 'Codex'].flatMap((harness) =>
  rows
    .filter(
      (r) =>
        r.root && (campaignCounts.get(r.campaign) ?? 0) > 2 && r.harness === harness && (r.day ?? '') >= '2026-08-01',
    )
    .sort(
      (a, b) => (campaignCounts.get(b.campaign) ?? 0) - (campaignCounts.get(a.campaign) ?? 0) || b.tokens - a.tokens,
    )
    .slice(0, 6),
);
const client = createORPCClient<WebContractClient>(
  new RPCLink({ url: 'http://127.0.0.1:5173/rpc', method: 'POST', headers: { origin: 'http://127.0.0.1:5173' } }),
);
const details: DatavizPrototypeSnapshot['details'] = [];
for (const row of candidates) {
  try {
    const result = parseSessionDetailResponse(
      await client.session.detail(
        { revision: capture.manifest.revision, rowId: row.id },
        { signal: AbortSignal.timeout(20_000) },
      ),
    );
    if (result.status !== 'available') {
      details.push({ rowId: row.id, status: 'unavailable', note: result.reason, rounds: [], interactions: [] });
      continue;
    }
    const rounds = deriveSessionRounds(result.detail);
    const turnRounds = new Map<number, number>();
    for (const [index, round] of rounds.entries()) {
      for (const interactionIndex of round.interactionIndexes) {
        turnRounds.set(interactionIndex, index + 1);
      }
    }
    const prefix = row.sourceId?.slice(0, (row.sourceId?.lastIndexOf(':') ?? -1) + 1) ?? '';
    details.push({
      rowId: row.id,
      status: 'available',
      note: Object.entries(result.detail.coverage)
        .filter(([, v]) => v.status !== 'complete')
        .map(([k, v]) => `${k}: ${v.status}`)
        .join(' · ')
        .slice(0, 500),
      rounds: rounds
        .slice(0, 2000)
        .map((round, index) => ({ index: index + 1, start: round.startAt, tokens: round.tokens.total })),
      interactions: result.detail.interactions.slice(0, 2000).map((interaction, index) => ({
        to: interaction.childSourceSessionId
          ? (sourceRows.get(prefix + interaction.childSourceSessionId)?.id ?? null)
          : null,
        round: turnRounds.get(index) ?? null,
        kind: interaction.kind,
      })),
    });
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message.slice(0, 300) : 'capture failed');
    details.push({
      rowId: row.id,
      status: 'unavailable',
      note: cause instanceof Error ? cause.name : 'read-failed',
      rounds: [],
      interactions: [],
    });
  }
}
const snapshot = parse(datavizPrototypeSnapshotSchema, {
  version: 1,
  revision: capture.manifest.revision,
  generatedAt: capture.manifest.generated_at,
  capturedAt: new Date().toISOString(),
  rows,
  details,
});
const json = JSON.stringify(snapshot);
if (new TextEncoder().encode(json).byteLength > 8 * 1024 * 1024) {
  throw new Error('Snapshot too large.');
}
const output = resolve(outputDirectory, 'snapshot.json');
const temporary = `${output}.tmp`;
await Bun.write(temporary, json, { mode: 0o600 });
await chmod(temporary, 0o600);
await rename(temporary, output);
console.log(
  JSON.stringify({
    output,
    revision: snapshot.revision,
    rows: rows.length,
    harnesses: new Set(rows.map((r) => r.harness)).size,
    projects: new Set(rows.map((r) => r.project)).size,
    details: details.length,
    availableDetails: details.filter((d) => d.status === 'available').length,
    interactions: details.reduce((n, d) => n + d.interactions.length, 0),
    bytes: json.length,
  }),
);
