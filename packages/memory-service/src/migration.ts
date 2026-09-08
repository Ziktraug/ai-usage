import { createHash } from 'node:crypto';
import { type Instant, type MemoryImportId, parseInstant } from '@ai-usage/platform-core/identity';
import {
  type MemoryJsonValue,
  type MemoryKind,
  type MemorySensitivity,
  type MemoryTrust,
  memoryContentHash,
  memoryKinds,
  parseMemoryJsonValue,
  stableMemoryJson,
} from './domain';

export type LegacyMemoryScope = 'global' | 'repo' | 'session';
export type LegacyMemoryStatus = 'active' | 'archived' | 'rejected' | 'superseded';
export type LegacyMemorySensitivity = 'private' | 'public' | 'secret-redacted' | 'sensitive';

export type MemoryImportIssueCode =
  | 'document-too-large'
  | 'invalid-frontmatter'
  | 'invalid-json'
  | 'invalid-kind'
  | 'invalid-relation'
  | 'invalid-scope'
  | 'invalid-status'
  | 'invalid-timestamp'
  | 'invalid-trust'
  | 'missing-project'
  | 'source-too-large'
  | 'too-many-documents'
  | 'unsupported-record';

export interface MemoryImportIssue {
  readonly code: MemoryImportIssueCode;
  readonly documentIndex: number;
  readonly recordIndex: number | null;
}

export interface LegacyMemoryImportDocument {
  readonly content: string;
  readonly sourceLocator: string;
}

export interface LegacyMemoryImportSource {
  readonly documents: readonly LegacyMemoryImportDocument[];
  readonly sourceKind: 'legacy-jsonl' | 'legacy-markdown';
  readonly sourceLocator: string;
}

export interface ParsedLegacyMemoryRecord {
  readonly createdAt: Instant;
  readonly fingerprint: string;
  readonly guidance: readonly string[];
  readonly kind: MemoryKind;
  readonly legacyId: string;
  readonly origin: 'durable' | 'inbox';
  readonly provenance: readonly string[];
  readonly scope: LegacyMemoryScope;
  readonly sensitivity: MemorySensitivity;
  readonly sourceLocator: string;
  readonly status: LegacyMemoryStatus | null;
  readonly structuredContent: MemoryJsonValue;
  readonly summary: string;
  readonly supersedes: readonly string[];
  readonly title: string;
  readonly trust: MemoryTrust;
}

export interface ParsedLegacyMemorySource {
  readonly contentHash: string;
  readonly fingerprint: string;
  readonly issues: readonly MemoryImportIssue[];
  readonly records: readonly ParsedLegacyMemoryRecord[];
}

export interface MemoryImportEffectCounts {
  readonly acceptedItems: number;
  readonly duplicateRecords: number;
  readonly observations: number;
  readonly pendingProposals: number;
  readonly rejectedProposals: number;
  readonly relations: number;
  readonly sensitiveRecords: number;
  readonly supersededItems: number;
}

export interface MemoryImportPreview {
  readonly alreadyConfirmed: boolean;
  readonly effects: MemoryImportEffectCounts;
  readonly importId: MemoryImportId;
  readonly issues: readonly MemoryImportIssue[];
  readonly previewProof: string;
  readonly status: 'confirmed' | 'previewed' | 'quarantined';
}

export interface MemoryImportConfirmation {
  readonly effects: MemoryImportEffectCounts;
  readonly importId: MemoryImportId;
  readonly kind: 'confirmed';
}

export type MemoryExportFormat = 'jsonl' | 'markdown';

export interface MemoryExportArtifact {
  readonly content: string;
  readonly contentHash: string;
  readonly format: MemoryExportFormat;
  readonly itemCount: number;
  readonly revisionCount: number;
}

export const memoryMigrationBounds = Object.freeze({
  maxDocumentBytes: 512 * 1024,
  maxDocuments: 1000,
  maxIssues: 100,
  maxSourceBytes: 4 * 1024 * 1024,
});

const encoder = new TextEncoder();
const memoryKindSet = new Set<string>(memoryKinds);
const frontmatterPattern = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u;
const dateOnlyPattern = /^\d{4}-\d{2}-\d{2}$/u;
const lineBreakPattern = /\r?\n/u;
const guidancePrefixPattern = /^\s*[-*]\s+/u;
const yamlArrayItemPattern = /^\s+-\s+(.*)$/u;
const yamlEmptyArrayPattern = /^\s+\[\]\s*$/u;
const yamlFieldPattern = /^([a-z][a-z0-9_]*)\s*:\s*(.*)$/u;
const markdownBulletPattern = /^\s*[-*]\s+(.+)$/u;
const markdownItemBoundary = '\n<!-- ai-usage-memory-item-boundary -->\n';

const hashText = (value: string): string => createHash('sha256').update(value).digest('hex');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const boundedText = (value: unknown, maximum: number, allowEmpty = false): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  if ((!allowEmpty && normalized.length === 0) || normalized.length > maximum || normalized.includes('\0')) {
    return null;
  }
  return normalized;
};

const parseKind = (value: unknown): MemoryKind | null =>
  typeof value === 'string' && memoryKindSet.has(value) ? (value as MemoryKind) : null;

const parseScope = (value: unknown): LegacyMemoryScope | null =>
  value === 'global' || value === 'repo' || value === 'session' ? value : null;

const parseStatus = (value: unknown): LegacyMemoryStatus | null =>
  value === 'active' || value === 'archived' || value === 'rejected' || value === 'superseded' ? value : null;

const parseTrust = (value: unknown): MemoryTrust | null =>
  value === 'explicit' || value === 'harvest-accepted' ? value : null;

const normalizedInstant = (value: unknown): Instant | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const timestamp = dateOnlyPattern.test(value) ? `${value}T00:00:00.000Z` : value;
  try {
    return parseInstant(new Date(timestamp).toISOString());
  } catch {
    return null;
  }
};

const splitGuidance = (body: string): readonly string[] =>
  body
    .split(lineBreakPattern)
    .map((line) => line.replace(guidancePrefixPattern, '').trim())
    .filter((line) => line.length > 0)
    .slice(0, 64)
    .map((line) => line.slice(0, 4096));

const sensitivityFor = (value: unknown): MemorySensitivity =>
  value === 'sensitive' || value === 'secret-redacted' ? 'sensitive' : 'normal';

const recordFingerprint = (
  record: Omit<ParsedLegacyMemoryRecord, 'fingerprint' | 'legacyId' | 'sourceLocator'>,
): string => memoryContentHash(record as unknown as MemoryJsonValue);

const issue = (code: MemoryImportIssueCode, documentIndex: number, recordIndex: number | null): MemoryImportIssue => ({
  code,
  documentIndex,
  recordIndex,
});

const parseYamlScalar = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return typeof parsed === 'string' ? parsed : trimmed.slice(1, -1);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  return trimmed;
};

interface ParsedFrontmatter {
  readonly arrays: Readonly<Record<string, readonly string[]>>;
  readonly scalars: Readonly<Record<string, string>>;
}

const parseFrontmatter = (value: string): ParsedFrontmatter | null => {
  const scalars: Record<string, string> = {};
  const arrays: Record<string, string[]> = {};
  let activeArray: string | null = null;
  for (const line of value.split(lineBreakPattern)) {
    if (activeArray && yamlEmptyArrayPattern.test(line)) {
      continue;
    }
    const item = yamlArrayItemPattern.exec(line);
    if (item && activeArray) {
      arrays[activeArray]?.push(parseYamlScalar(item[1] ?? ''));
      continue;
    }
    const field = yamlFieldPattern.exec(line);
    if (!field) {
      if (line.trim().length > 0) {
        return null;
      }
      continue;
    }
    const key = field[1] ?? '';
    const raw = field[2] ?? '';
    activeArray = null;
    if (raw.length === 0) {
      arrays[key] = [];
      activeArray = key;
      continue;
    }
    if (raw.startsWith('[') && raw.endsWith(']')) {
      const inner = raw.slice(1, -1).trim();
      arrays[key] = inner.length === 0 ? [] : inner.split(',').map(parseYamlScalar);
      continue;
    }
    scalars[key] = parseYamlScalar(raw);
  }
  return { arrays, scalars };
};

const markdownSection = (body: string, heading: string): string | null => {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = new RegExp(`^## ${escaped}\\s*\\r?\\n([\\s\\S]*?)(?=^## |\\s*$)`, 'mu').exec(body);
  return match?.[1]?.trim() ?? null;
};

const markdownBullets = (body: string, heading: string): readonly string[] => {
  const section = markdownSection(body, heading);
  if (!section || section === 'None.') {
    return [];
  }
  return section
    .split(lineBreakPattern)
    .map((line) => markdownBulletPattern.exec(line)?.[1]?.trim() ?? '')
    .filter((line) => line.length > 0);
};

const parseMarkdownDocument = (
  document: LegacyMemoryImportDocument,
  documentIndex: number,
): { readonly issues: readonly MemoryImportIssue[]; readonly records: readonly ParsedLegacyMemoryRecord[] } => {
  const frontmatterMatch = frontmatterPattern.exec(document.content);
  if (!frontmatterMatch) {
    return { issues: [issue('invalid-frontmatter', documentIndex, null)], records: [] };
  }
  const frontmatter = parseFrontmatter(frontmatterMatch[1] ?? '');
  if (!frontmatter) {
    return { issues: [issue('invalid-frontmatter', documentIndex, null)], records: [] };
  }
  const kind = parseKind(frontmatter.scalars.type);
  const scope = parseScope(frontmatter.scalars.scope);
  const status = parseStatus(frontmatter.scalars.status);
  const trust = parseTrust(frontmatter.scalars.trust);
  const createdAt = normalizedInstant(frontmatter.scalars.created);
  const title = boundedText(frontmatter.scalars.title, 512);
  const summary = boundedText(markdownSection(document.content, 'Summary') ?? '', 16_384, true);
  const guidance = markdownBullets(document.content, 'Guidance for future agents');
  const errors: MemoryImportIssue[] = [];
  if (!kind) {
    errors.push(issue('invalid-kind', documentIndex, null));
  }
  if (!scope || scope === 'session') {
    errors.push(issue('invalid-scope', documentIndex, null));
  }
  if (!status) {
    errors.push(issue('invalid-status', documentIndex, null));
  }
  if (!trust) {
    errors.push(issue('invalid-trust', documentIndex, null));
  }
  if (!createdAt) {
    errors.push(issue('invalid-timestamp', documentIndex, null));
  }
  if (!(title && summary !== null) || guidance.some((entry) => entry.length > 4096)) {
    errors.push(issue('unsupported-record', documentIndex, null));
  }
  if (errors.length > 0 || !(kind && scope && status && trust && createdAt && title && summary !== null)) {
    return { issues: errors, records: [] };
  }
  const provenance = [
    ...(frontmatter.arrays.provenance ?? []),
    ...markdownBullets(document.content, 'Evidence / provenance'),
  ]
    .map((entry) => entry.trim())
    .filter((entry, index, values) => entry.length > 0 && values.indexOf(entry) === index)
    .slice(0, 100);
  const supersedes = [
    ...(frontmatter.arrays.supersedes ?? []),
    ...markdownBullets(document.content, 'Supersedes'),
  ].slice(0, 100);
  let structuredContent: MemoryJsonValue;
  const structuredSection = markdownSection(document.content, 'Structured content');
  if (structuredSection?.startsWith('```json') && structuredSection.endsWith('```')) {
    try {
      structuredContent = parseMemoryJsonValue(JSON.parse(structuredSection.slice(7, -3).trim()) as unknown);
    } catch {
      return { issues: [issue('invalid-json', documentIndex, null)], records: [] };
    }
  } else {
    structuredContent = parseMemoryJsonValue({
      legacy: {
        distillationHash: frontmatter.scalars.distillation_hash ?? null,
        source: frontmatter.scalars.source ?? null,
        tags: frontmatter.arrays.tags ?? [],
        updated: frontmatter.scalars.updated ?? null,
      },
    });
  }
  const normalized = {
    createdAt,
    guidance,
    kind,
    origin: 'durable' as const,
    provenance,
    scope,
    sensitivity: sensitivityFor(frontmatter.scalars.sensitivity),
    status,
    structuredContent,
    summary,
    supersedes,
    title,
    trust,
  };
  const fingerprint = recordFingerprint(normalized);
  return {
    issues: [],
    records: [
      {
        ...normalized,
        fingerprint,
        legacyId: frontmatter.scalars.memory_item_id ?? frontmatter.scalars.distillation_hash ?? fingerprint,
        sourceLocator: document.sourceLocator,
      },
    ],
  };
};

const parseDbNativeJsonlRecord = (
  value: Record<string, unknown>,
  document: LegacyMemoryImportDocument,
  documentIndex: number,
  recordIndex: number,
): { readonly issue: MemoryImportIssue | null; readonly record: ParsedLegacyMemoryRecord | null } | null => {
  if (value.schemaVersion !== 1) {
    return null;
  }
  if (!(isRecord(value.item) && Array.isArray(value.revisions))) {
    return { issue: issue('unsupported-record', documentIndex, recordIndex), record: null };
  }
  const item = value.item;
  const legacyId = boundedText(item.id, 256);
  const currentRevisionId = boundedText(item.currentRevisionId, 256);
  const kind = parseKind(item.kind);
  let scope: LegacyMemoryScope | null = null;
  if (item.scope === 'project') {
    scope = 'repo';
  } else if (item.scope === 'space' || item.scope === 'person') {
    scope = 'global';
  }
  const status = parseStatus(item.status);
  const trust = parseTrust(item.trust);
  const sensitivity: MemorySensitivity | null =
    item.sensitivity === 'normal' || item.sensitivity === 'sensitive' ? item.sensitivity : null;
  const currentRevision = value.revisions.find((revision) => isRecord(revision) && revision.id === currentRevisionId);
  if (
    !(legacyId && currentRevisionId && kind && scope && status && trust && sensitivity && isRecord(currentRevision))
  ) {
    return { issue: issue('unsupported-record', documentIndex, recordIndex), record: null };
  }
  const title = boundedText(currentRevision.title, 512);
  const summary = boundedText(currentRevision.summary, 16_384, true);
  const createdAt = normalizedInstant(currentRevision.createdAt);
  const rawGuidance = currentRevision.guidance;
  const guidanceCount = Array.isArray(rawGuidance) ? rawGuidance.length : null;
  const guidance = Array.isArray(rawGuidance)
    ? rawGuidance.map((entry) => boundedText(entry, 4096)).filter((entry): entry is string => entry !== null)
    : null;
  if (
    !(title && summary !== null && createdAt && guidance) ||
    guidance.length !== guidanceCount ||
    guidance.length > 64
  ) {
    return { issue: issue('unsupported-record', documentIndex, recordIndex), record: null };
  }
  let structuredContent: MemoryJsonValue;
  try {
    structuredContent = parseMemoryJsonValue(currentRevision.structuredContent);
  } catch {
    return { issue: issue('unsupported-record', documentIndex, recordIndex), record: null };
  }
  const provenance = Array.isArray(value.provenance)
    ? value.provenance
        .slice(0, 100)
        .map((entry) => {
          if (!isRecord(entry)) {
            return null;
          }
          const id = boundedText(entry.id, 256);
          const observedAt = normalizedInstant(entry.observedAt);
          const sourceKind = boundedText(entry.sourceKind, 64);
          return id && observedAt && sourceKind ? `${sourceKind}:${id}:${observedAt}` : null;
        })
        .filter((entry): entry is string => entry !== null)
    : [];
  const supersedes = Array.isArray(value.relations)
    ? value.relations
        .filter((entry) => isRecord(entry) && entry.kind === 'supersedes')
        .map((entry) => (isRecord(entry) ? boundedText(entry.toMemoryItemId, 256) : null))
        .filter((entry): entry is string => entry !== null)
        .slice(0, 100)
    : [];
  const normalized: Omit<ParsedLegacyMemoryRecord, 'fingerprint' | 'legacyId' | 'sourceLocator'> = {
    createdAt,
    guidance,
    kind,
    origin: 'durable' as const,
    provenance,
    scope,
    sensitivity,
    status,
    structuredContent,
    summary,
    supersedes,
    title,
    trust,
  };
  return {
    issue: null,
    record: {
      ...normalized,
      fingerprint: recordFingerprint(normalized),
      legacyId,
      sourceLocator: document.sourceLocator,
    },
  };
};

const parseJsonlDocument = (
  document: LegacyMemoryImportDocument,
  documentIndex: number,
): { readonly issues: readonly MemoryImportIssue[]; readonly records: readonly ParsedLegacyMemoryRecord[] } => {
  const issues: MemoryImportIssue[] = [];
  const records: ParsedLegacyMemoryRecord[] = [];
  const lines = document.content.split(lineBreakPattern);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]?.trim() ?? '';
    if (line.length === 0) {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      issues.push(issue('invalid-json', documentIndex, lineIndex));
      continue;
    }
    if (!isRecord(value)) {
      issues.push(issue('unsupported-record', documentIndex, lineIndex));
      continue;
    }
    const dbNative = parseDbNativeJsonlRecord(value, document, documentIndex, lineIndex);
    if (dbNative) {
      if (dbNative.issue) {
        issues.push(dbNative.issue);
      }
      if (dbNative.record) {
        records.push(dbNative.record);
      }
      continue;
    }
    const rawType = boundedText(value.type, 128);
    const kind = parseKind(rawType) ?? (rawType === 'session-harvest' ? 'handoff' : null);
    const scope = parseScope(value.scope);
    const createdAt = normalizedInstant(value.timestamp);
    const title = boundedText(value.title, 512);
    const body = boundedText(value.body, 16_384, true);
    if (!(kind && scope && createdAt && title && body !== null)) {
      let code: MemoryImportIssueCode = 'unsupported-record';
      if (!kind) {
        code = 'invalid-kind';
      } else if (!scope) {
        code = 'invalid-scope';
      } else if (!createdAt) {
        code = 'invalid-timestamp';
      }
      issues.push(issue(code, documentIndex, lineIndex));
      continue;
    }
    let structuredContent: MemoryJsonValue;
    try {
      structuredContent = parseMemoryJsonValue({
        legacy: {
          payload: value.payload ?? null,
          repo: typeof value.repo === 'string' ? value.repo : null,
          source: typeof value.source === 'string' ? value.source : null,
          type: rawType,
          version: typeof value.version === 'string' ? value.version : null,
        },
      });
    } catch {
      issues.push(issue('unsupported-record', documentIndex, lineIndex));
      continue;
    }
    const provenance = [
      typeof value.source === 'string' ? value.source : null,
      typeof value.repo === 'string' ? value.repo : null,
      document.sourceLocator,
    ].filter((entry): entry is string => entry !== null && entry.length > 0);
    const normalized = {
      createdAt,
      guidance: splitGuidance(body),
      kind,
      origin: 'inbox' as const,
      provenance,
      scope,
      sensitivity: sensitivityFor(value.sensitivity),
      status: null,
      structuredContent,
      summary: body,
      supersedes: [] as readonly string[],
      title,
      trust: rawType === 'session-harvest' ? ('harvest-accepted' as const) : ('explicit' as const),
    };
    const fingerprint = recordFingerprint(normalized);
    records.push({
      ...normalized,
      fingerprint,
      legacyId: fingerprint,
      sourceLocator: `${document.sourceLocator}:${lineIndex + 1}`,
    });
  }
  return { issues, records };
};

export const parseLegacyMemoryImportSource = (source: LegacyMemoryImportSource): ParsedLegacyMemorySource => {
  const issues: MemoryImportIssue[] = [];
  const records: ParsedLegacyMemoryRecord[] = [];
  const sourceDocuments =
    source.sourceKind === 'legacy-markdown'
      ? source.documents.flatMap((document) =>
          document.content.split(markdownItemBoundary).map((content, index) => ({
            content,
            sourceLocator: index === 0 ? document.sourceLocator : `${document.sourceLocator}#item-${index + 1}`,
          })),
        )
      : source.documents;
  if (sourceDocuments.length > memoryMigrationBounds.maxDocuments) {
    issues.push(issue('too-many-documents', 0, null));
  }
  const totalBytes = source.documents.reduce(
    (total, document) => total + encoder.encode(document.content).byteLength,
    0,
  );
  for (const [documentIndex, document] of sourceDocuments.slice(0, memoryMigrationBounds.maxDocuments).entries()) {
    const documentBytes = encoder.encode(document.content).byteLength;
    if (documentBytes > memoryMigrationBounds.maxDocumentBytes) {
      issues.push(issue('document-too-large', documentIndex, null));
      continue;
    }
    const parsed =
      source.sourceKind === 'legacy-markdown'
        ? parseMarkdownDocument(document, documentIndex)
        : parseJsonlDocument(document, documentIndex);
    issues.push(...parsed.issues);
    records.push(...parsed.records);
  }
  if (totalBytes > memoryMigrationBounds.maxSourceBytes) {
    issues.push(issue('source-too-large', 0, null));
  }
  const contentHash = hashText(
    stableMemoryJson({
      documents: source.documents.map((document) => hashText(document.content)).sort(),
      sourceKind: source.sourceKind,
    }),
  );
  return {
    contentHash,
    fingerprint: contentHash,
    issues: issues.slice(0, memoryMigrationBounds.maxIssues),
    records,
  };
};

export const memoryImportPreviewProof = (input: {
  readonly contentHash: string;
  readonly destinationProjectId: string | null;
  readonly destinationSpaceId: string;
  readonly destinationStateVersion: number;
  readonly fingerprint: string;
}): string => hashText(stableMemoryJson(input as unknown as MemoryJsonValue));
