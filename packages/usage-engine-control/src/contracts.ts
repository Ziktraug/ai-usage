import {
  type CampaignLabelOverrideMutation,
  MAX_CAMPAIGN_KEY_BYTES,
  parseCampaignLabelOverrideMutation,
} from '@ai-usage/report-core/campaign-label';
import { parseCanonicalInstant } from '@ai-usage/report-core/canonical-instant';
import { type HarnessKey, isHarnessKey } from '@ai-usage/report-core/harness-metadata';
import { type MergePreviewProof, parseMergePreviewProof } from '@ai-usage/report-core/merge-proof';
import { MAX_PORTABLE_USAGE_BYTES, MAX_PORTABLE_USAGE_ROWS } from '@ai-usage/report-core/portable-usage';
import type { ProjectAliasEntry } from '@ai-usage/report-core/project-alias';
import {
  type ProjectGroupConfig,
  type ProjectSourceSelector,
  parseProjectGroupConfigs,
} from '@ai-usage/report-core/project-group';
import { parseServedRevision, type ServedRevision } from '@ai-usage/report-core/served-revision';
import {
  type CollectionSourceId,
  collectionSourceIds,
  isCollectionSourceId,
  parseReportPublishedEvent,
  parseSourceControlEntryView,
  parseSourceControlSnapshot,
  type ReportPublishedEvent,
  type SourceControlEntryView,
  type SourceControlView,
  sourceControlBounds,
} from '@ai-usage/report-core/source-control';

declare const usageEngineBrand: unique symbol;

type Branded<Value, Name extends string> = Value & {
  readonly [usageEngineBrand]: Name;
};

export type UsageEngineProtocolVersion = Branded<number, 'UsageEngineProtocolVersion'>;
export type UsageEngineInstanceId = Branded<string, 'UsageEngineInstanceId'>;
export type UsageEngineCommandId = Branded<string, 'UsageEngineCommandId'>;
export type UsageEngineEventId = Branded<string, 'UsageEngineEventId'>;
export type UsageEngineEventSequence = Branded<number, 'UsageEngineEventSequence'>;
export type UsageEngineHandoffId = Branded<string, 'UsageEngineHandoffId'>;
export type UsageEnginePublicationRevision = ServedRevision;
export type UsageEngineProjectSourceReference = Branded<string, 'UsageEngineProjectSourceReference'>;

export const USAGE_ENGINE_PROTOCOL_VERSION = 1 as UsageEngineProtocolVersion;

const kibibyte = 1024;
const maxOpaqueIdBytes = 160;
const maxCommandCompletionEventBytes = sourceControlBounds.maxSnapshotBytes;
const maxStatusBytes = sourceControlBounds.maxSnapshotBytes + 32 * kibibyte;
const maxForegroundEnvelopeBytes = 4 * kibibyte;

export const usageEngineControlBounds = {
  maxCommandBytes: MAX_CAMPAIGN_KEY_BYTES + 4 * kibibyte,
  maxCommandCompletionEventBytes,
  maxCommandResultBytes: 8 * kibibyte,
  maxErrorResponseBytes: 4 * kibibyte,
  maxEventBytes: sourceControlBounds.maxEventBytes,
  maxFilePathBytes: 4 * kibibyte,
  maxForegroundOutcomeBytes: maxStatusBytes + maxCommandCompletionEventBytes + maxForegroundEnvelopeBytes,
  maxMessageBytes: sourceControlBounds.maxMessageLength,
  maxOpaqueIdBytes,
  maxProjectAliases: 500,
  maxProjectAliasMatches: 500,
  maxProjectGroups: 256,
  maxRendezvousBytes: 4 * kibibyte,
  maxSnapshotEventBytes: sourceControlBounds.maxSnapshotBytes + 2 * kibibyte,
  maxStatusEventBytes: sourceControlBounds.maxSnapshotBytes + 34 * kibibyte,
  maxStatusBytes,
  maxTokenBytes: 256,
  minTokenBytes: 32,
} as const;

const opaqueIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/;
const replayEventIdPattern = /^(engine|snapshot):(0|[1-9]\d*)$/;
const boundedCodePattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const projectSourceReferencePattern = /^project-source:[a-f0-9]{64}$/;
const encoder = new TextEncoder();

export type UsageEngineContractErrorReason = 'invalid-contract' | 'protocol-mismatch';

export class UsageEngineContractError extends Error {
  override readonly name = 'UsageEngineContractError';
  readonly reason: UsageEngineContractErrorReason;

  constructor(reason: UsageEngineContractErrorReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

const fail = (message: string): never => {
  throw new UsageEngineContractError('invalid-contract', message);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasExactKeys = (record: Record<string, unknown>, expected: readonly string[]): boolean => {
  const actual = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
};

const hasOnlyKeys = (record: Record<string, unknown>, allowed: readonly string[]): boolean => {
  const allowedKeys = new Set(allowed);
  return Object.keys(record).every((key) => allowedKeys.has(key));
};

const serializedByteLength = (value: unknown, label: string): number => {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      return fail(`${label} is not serializable.`);
    }
    return encoder.encode(serialized).byteLength;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(label)) {
      throw error;
    }
    return fail(`${label} is not serializable.`);
  }
};

const assertSerializedBound = (value: unknown, maximum: number, label: string): void => {
  if (serializedByteLength(value, label) > maximum) {
    fail(`${label} exceeds its byte limit.`);
  }
};

const isBoundedString = (value: unknown, maximumBytes: number, allowEmpty = false): value is string =>
  typeof value === 'string' && (allowEmpty || value.length > 0) && encoder.encode(value).byteLength <= maximumBytes;

const parseBoundedString = (value: unknown, maximumBytes: number, label: string, allowEmpty = false): string => {
  if (!isBoundedString(value, maximumBytes, allowEmpty)) {
    return fail(`${label} is invalid or exceeds its byte limit.`);
  }
  return value;
};

const parseOpaqueId = <Name extends string>(value: unknown, label: string): Branded<string, Name> => {
  if (!(isBoundedString(value, maxOpaqueIdBytes) && opaqueIdPattern.test(value))) {
    return fail(`${label} is invalid.`);
  }
  return value as Branded<string, Name>;
};

const parseNonNegativeSafeInteger = (value: unknown, maximum: number, label: string): number => {
  if (!(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum)) {
    return fail(`${label} is invalid.`);
  }
  return value;
};

const parseIsoTimestamp = (value: unknown, label: string): string => {
  try {
    return parseCanonicalInstant(value, label);
  } catch {
    return fail(`${label} is invalid.`);
  }
};

export const parseUsageEngineProtocolVersion = (value: unknown): UsageEngineProtocolVersion => {
  if (value !== USAGE_ENGINE_PROTOCOL_VERSION) {
    throw new UsageEngineContractError('protocol-mismatch', 'Usage engine protocol version mismatch.');
  }
  return USAGE_ENGINE_PROTOCOL_VERSION;
};

export const parseUsageEngineInstanceId = (value: unknown): UsageEngineInstanceId =>
  parseOpaqueId<UsageEngineInstanceId extends Branded<string, infer Name> ? Name : never>(
    value,
    'Usage engine instance ID',
  );

export const parseUsageEngineCommandId = (value: unknown): UsageEngineCommandId =>
  parseOpaqueId<UsageEngineCommandId extends Branded<string, infer Name> ? Name : never>(
    value,
    'Usage engine command ID',
  );

export const parseUsageEngineEventSequence = (value: unknown): UsageEngineEventSequence =>
  parseNonNegativeSafeInteger(
    value,
    sourceControlBounds.maxGeneration,
    'Usage engine event sequence',
  ) as UsageEngineEventSequence;

export type UsageEngineReplayCursorKind = 'engine' | 'snapshot';

export interface UsageEngineReplayCursor {
  readonly eventId: UsageEngineEventId;
  readonly kind: UsageEngineReplayCursorKind;
  readonly replaySequence: UsageEngineEventSequence;
}

export const usageEngineEventIdFor = (
  kind: UsageEngineReplayCursorKind,
  replaySequence: UsageEngineEventSequence,
): UsageEngineEventId => `${kind}:${replaySequence}` as UsageEngineEventId;

export const parseUsageEngineReplayCursor = (value: unknown): UsageEngineReplayCursor => {
  if (typeof value !== 'string') {
    return fail('Usage engine replay cursor is invalid.');
  }
  const match = replayEventIdPattern.exec(value);
  if (match === null) {
    return fail('Usage engine replay cursor is invalid.');
  }
  const kind = match[1];
  if (kind !== 'engine' && kind !== 'snapshot') {
    return fail('Usage engine replay cursor is invalid.');
  }
  const replaySequence = parseUsageEngineEventSequence(Number(match[2]));
  return {
    eventId: usageEngineEventIdFor(kind, replaySequence),
    kind,
    replaySequence,
  };
};

export const parseUsageEngineEventId = (value: unknown): UsageEngineEventId =>
  parseOpaqueId<UsageEngineEventId extends Branded<string, infer Name> ? Name : never>(value, 'Usage engine event ID');

export const parseUsageEngineHandoffId = (value: unknown): UsageEngineHandoffId =>
  parseOpaqueId<UsageEngineHandoffId extends Branded<string, infer Name> ? Name : never>(
    value,
    'Usage engine handoff ID',
  );

export const parseUsageEnginePublicationRevision = (value: unknown): UsageEnginePublicationRevision => {
  try {
    return parseServedRevision(value, 'Usage engine publication revision');
  } catch {
    return fail('Usage engine publication revision is invalid.');
  }
};

export const parseUsageEngineProjectSourceReference = (value: unknown): UsageEngineProjectSourceReference => {
  if (!(typeof value === 'string' && projectSourceReferencePattern.test(value))) {
    return fail('Usage engine project source reference is invalid.');
  }
  return value as UsageEngineProjectSourceReference;
};

export interface UsageEngineProjectGroupReferenceConfig {
  readonly id: string;
  readonly name: string;
  readonly sources: readonly UsageEngineProjectSourceReference[];
}

export type UsageEngineFileInput =
  | {
      readonly handoffId: UsageEngineHandoffId;
      readonly kind: 'inbox-handoff';
    }
  | {
      readonly filePath: string;
      readonly kind: 'operator-file';
    };

export type UsageEngineCommand =
  | { readonly command: 'detect-all' }
  | { readonly command: 'collect-fresh-report'; readonly harness: HarnessKey | null; readonly includeCursor: boolean }
  | { readonly command: 'run-all-enabled' }
  | { readonly command: 'run-source'; readonly sourceId: CollectionSourceId }
  | { readonly command: 'publish' }
  | {
      readonly command: 'set-source-enabled';
      readonly enabled: boolean;
      readonly sourceId: CollectionSourceId;
    }
  | {
      readonly command: 'replace-project-groups';
      readonly projectGroups: readonly ProjectGroupConfig[];
    }
  | {
      readonly command: 'replace-project-groups-by-reference';
      readonly projectGroups: readonly UsageEngineProjectGroupReferenceConfig[];
      readonly revision: UsageEnginePublicationRevision;
    }
  | {
      readonly command: 'replace-project-aliases';
      readonly projectAliases: readonly ProjectAliasEntry[];
    }
  | { readonly command: 'set-machine-label'; readonly label: string }
  | ({ readonly command: 'set-campaign-label-override' } & CampaignLabelOverrideMutation)
  | { readonly command: 'collect-fresh-quota' }
  | { readonly command: 'import-cursor'; readonly input: UsageEngineFileInput }
  | { readonly command: 'preview-merge'; readonly input: UsageEngineFileInput }
  | ({
      readonly command: 'confirm-merge';
      readonly input: UsageEngineFileInput;
    } & MergePreviewProof);

export interface UsageEngineFreshReportSelection {
  readonly harness: HarnessKey | null;
  readonly includeCursor: boolean;
}

export const usageEngineReportSourceIdsFor = (
  selection: UsageEngineFreshReportSelection,
): readonly CollectionSourceId[] => {
  const cursorIsSelected = selection.includeCursor && (selection.harness === null || selection.harness === 'cursor');
  let sessionSourceIds: CollectionSourceId[];
  if (selection.harness === null) {
    sessionSourceIds = ['claude.sessions', 'codex.sessions', 'opencode.sessions'];
  } else if (selection.harness === 'cursor' && !cursorIsSelected) {
    sessionSourceIds = [];
  } else {
    sessionSourceIds = [`${selection.harness}.sessions`];
  }
  if (cursorIsSelected && selection.harness === null) {
    sessionSourceIds.push('cursor.sessions');
  }
  return [
    ...sessionSourceIds,
    ...(sessionSourceIds.length === 0 ? [] : (['rtk.savings'] as const)),
    ...(cursorIsSelected ? (['cursor.commit-attribution'] as const) : []),
  ];
};

type UsageEngineFileCommand = Extract<UsageEngineCommand, { readonly input: UsageEngineFileInput }>;
type UsageEngineProjectGroupCommand = Extract<UsageEngineCommand, { readonly command: 'replace-project-groups' }>;
type UsageEngineProjectAliasCommand = Extract<UsageEngineCommand, { readonly command: 'replace-project-aliases' }>;
type UsageEngineCommandWithoutWebPaths = Exclude<
  UsageEngineCommand,
  UsageEngineFileCommand | UsageEngineProjectAliasCommand | UsageEngineProjectGroupCommand
>;
type UsageEngineInboxFileInput = Extract<UsageEngineFileInput, { readonly kind: 'inbox-handoff' }>;

export interface WebProjectGroupConfig {
  readonly id: string;
  readonly name: string;
  readonly sources: readonly Omit<ProjectSourceSelector, 'sourcePath'>[];
}

export type WebUsageEngineCommand =
  | UsageEngineCommandWithoutWebPaths
  | {
      readonly command: 'replace-project-groups';
      readonly projectGroups: readonly WebProjectGroupConfig[];
    }
  | {
      readonly command: 'import-cursor' | 'preview-merge';
      readonly input: UsageEngineInboxFileInput;
    }
  | ({
      readonly command: 'confirm-merge';
      readonly input: UsageEngineInboxFileInput;
    } & MergePreviewProof);

const parseProjectGroups = (value: unknown): readonly ProjectGroupConfig[] => {
  if (!(Array.isArray(value) && value.length <= usageEngineControlBounds.maxProjectGroups)) {
    return fail('Usage engine project groups are invalid or exceed their limit.');
  }
  const groups: ProjectGroupConfig[] = [];
  for (const groupValue of value) {
    if (!(isRecord(groupValue) && hasExactKeys(groupValue, ['id', 'name', 'sources']))) {
      return fail('Usage engine project group contains unknown or missing fields.');
    }
    if (!Array.isArray(groupValue.sources)) {
      return fail('Usage engine project group sources are invalid.');
    }
    const sources: ProjectGroupConfig['sources'] = [];
    for (const sourceValue of groupValue.sources) {
      if (
        !(
          isRecord(sourceValue) &&
          hasOnlyKeys(sourceValue, ['gitRemote', 'machineId', 'project', 'sourcePath']) &&
          Object.keys(sourceValue).length > 0
        )
      ) {
        return fail('Usage engine project source contains unknown or missing fields.');
      }
      const source: ProjectGroupConfig['sources'][number] = {};
      for (const key of ['gitRemote', 'machineId', 'project', 'sourcePath'] as const) {
        const field = sourceValue[key];
        if (field !== undefined) {
          source[key] = parseBoundedString(field, usageEngineControlBounds.maxFilePathBytes, `Project source ${key}`);
        }
      }
      sources.push(source);
    }
    groups.push({
      id: parseBoundedString(groupValue.id, usageEngineControlBounds.maxMessageBytes, 'Project group ID'),
      name: parseBoundedString(groupValue.name, usageEngineControlBounds.maxMessageBytes, 'Project group name'),
      sources,
    });
  }
  try {
    return parseProjectGroupConfigs(groups).map((group) => ({
      id: group.id,
      name: group.name,
      sources: group.sources.map((source) => ({ ...source })),
    }));
  } catch {
    return fail('Usage engine project groups are invalid.');
  }
};

const parseProjectGroupReferences = (value: unknown): readonly UsageEngineProjectGroupReferenceConfig[] => {
  if (!(Array.isArray(value) && value.length <= usageEngineControlBounds.maxProjectGroups)) {
    return fail('Usage engine project group references are invalid or exceed their limit.');
  }
  const groups: UsageEngineProjectGroupReferenceConfig[] = [];
  const groupIds = new Set<string>();
  for (const groupValue of value) {
    if (!(isRecord(groupValue) && hasExactKeys(groupValue, ['id', 'name', 'sources']))) {
      return fail('Usage engine project group reference contains unknown or missing fields.');
    }
    if (!(Array.isArray(groupValue.sources) && groupValue.sources.length > 0)) {
      return fail('Usage engine project group source references are invalid.');
    }
    const id = parseBoundedString(groupValue.id, usageEngineControlBounds.maxMessageBytes, 'Project group ID');
    if (groupIds.has(id)) {
      return fail('Usage engine project group reference IDs must be unique.');
    }
    groupIds.add(id);
    const sources = groupValue.sources.map(parseUsageEngineProjectSourceReference);
    if (new Set(sources).size !== sources.length) {
      return fail('Usage engine project group source references must be unique.');
    }
    groups.push({
      id,
      name: parseBoundedString(groupValue.name, usageEngineControlBounds.maxMessageBytes, 'Project group name'),
      sources,
    });
  }
  return groups;
};

const parseProjectAliases = (value: unknown): readonly ProjectAliasEntry[] => {
  if (!(Array.isArray(value) && value.length <= usageEngineControlBounds.maxProjectAliases)) {
    return fail('Usage engine project aliases are invalid or exceed their limit.');
  }
  return value.map((aliasValue) => {
    if (!(isRecord(aliasValue) && hasExactKeys(aliasValue, ['match', 'name']) && Array.isArray(aliasValue.match))) {
      return fail('Usage engine project alias contains unknown or missing fields.');
    }
    if (aliasValue.match.length > usageEngineControlBounds.maxProjectAliasMatches) {
      return fail('Usage engine project alias match patterns exceed their limit.');
    }
    return {
      match: aliasValue.match.map((pattern) =>
        parseBoundedString(pattern, usageEngineControlBounds.maxFilePathBytes, 'Project alias match pattern'),
      ),
      name: parseBoundedString(aliasValue.name, usageEngineControlBounds.maxMessageBytes, 'Project alias name'),
    };
  });
};

const parseFileInput = (value: unknown): UsageEngineFileInput => {
  if (!(isRecord(value) && typeof value.kind === 'string')) {
    return fail('Usage engine file input is invalid.');
  }
  if (value.kind === 'inbox-handoff') {
    if (!hasExactKeys(value, ['handoffId', 'kind'])) {
      return fail('Usage engine inbox handoff contains unknown or missing fields.');
    }
    return { handoffId: parseUsageEngineHandoffId(value.handoffId), kind: 'inbox-handoff' };
  }
  if (value.kind === 'operator-file') {
    if (!hasExactKeys(value, ['filePath', 'kind'])) {
      return fail('Usage engine operator file contains unknown or missing fields.');
    }
    const filePath = parseBoundedString(
      value.filePath,
      usageEngineControlBounds.maxFilePathBytes,
      'Usage engine operator file path',
    );
    if (filePath.includes('\0')) {
      return fail('Usage engine operator file path is invalid.');
    }
    return { filePath, kind: 'operator-file' };
  }
  return fail('Usage engine file input kind is unknown.');
};

const requireCommandRecord = (value: unknown): Record<string, unknown> => {
  assertSerializedBound(value, usageEngineControlBounds.maxCommandBytes, 'Usage engine command');
  if (!(isRecord(value) && typeof value.command === 'string')) {
    return fail('Usage engine command must be an object.');
  }
  return value;
};

export const parseUsageEngineCommand = (value: unknown): UsageEngineCommand => {
  const command = requireCommandRecord(value);
  switch (command.command) {
    case 'detect-all':
    case 'run-all-enabled':
    case 'publish':
    case 'collect-fresh-quota':
      if (!hasExactKeys(command, ['command'])) {
        return fail('Usage engine command contains unknown fields.');
      }
      return { command: command.command };
    case 'collect-fresh-report': {
      if (!hasExactKeys(command, ['command', 'harness', 'includeCursor'])) {
        return fail('Usage engine collect-fresh-report command contains unknown fields.');
      }
      const harness = command.harness;
      if (
        !(
          (harness === null || (typeof harness === 'string' && isHarnessKey(harness))) &&
          typeof command.includeCursor === 'boolean'
        )
      ) {
        return fail('Usage engine collect-fresh-report command has an invalid harness or Cursor selection.');
      }
      return {
        command: 'collect-fresh-report',
        harness,
        includeCursor: command.includeCursor,
      };
    }
    case 'run-source':
      if (!hasExactKeys(command, ['command', 'sourceId'])) {
        return fail('Usage engine run-source command contains unknown fields.');
      }
      if (!isCollectionSourceId(command.sourceId)) {
        return fail('Usage engine run-source command requires a known source ID.');
      }
      return { command: 'run-source', sourceId: command.sourceId };
    case 'set-source-enabled':
      if (!hasExactKeys(command, ['command', 'enabled', 'sourceId'])) {
        return fail('Usage engine set-source-enabled command contains unknown fields.');
      }
      if (!(isCollectionSourceId(command.sourceId) && typeof command.enabled === 'boolean')) {
        return fail('Usage engine set-source-enabled command is invalid.');
      }
      return { command: 'set-source-enabled', enabled: command.enabled, sourceId: command.sourceId };
    case 'replace-project-groups':
      if (!hasExactKeys(command, ['command', 'projectGroups'])) {
        return fail('Usage engine replace-project-groups command contains unknown fields.');
      }
      return { command: 'replace-project-groups', projectGroups: parseProjectGroups(command.projectGroups) };
    case 'replace-project-groups-by-reference':
      if (!hasExactKeys(command, ['command', 'projectGroups', 'revision'])) {
        return fail('Usage engine replace-project-groups-by-reference command contains unknown fields.');
      }
      return {
        command: 'replace-project-groups-by-reference',
        projectGroups: parseProjectGroupReferences(command.projectGroups),
        revision: parseUsageEnginePublicationRevision(command.revision),
      };
    case 'replace-project-aliases':
      if (!hasExactKeys(command, ['command', 'projectAliases'])) {
        return fail('Usage engine replace-project-aliases command contains unknown fields.');
      }
      return { command: 'replace-project-aliases', projectAliases: parseProjectAliases(command.projectAliases) };
    case 'set-machine-label':
      if (!hasExactKeys(command, ['command', 'label'])) {
        return fail('Usage engine set-machine-label command contains unknown fields.');
      }
      return {
        command: 'set-machine-label',
        label: parseBoundedString(
          command.label,
          usageEngineControlBounds.maxMessageBytes,
          'Usage engine machine label',
        ),
      };
    case 'set-campaign-label-override': {
      if (!hasExactKeys(command, ['campaignKey', 'command', 'label'])) {
        return fail('Usage engine campaign label command contains unknown fields.');
      }
      try {
        const mutation = parseCampaignLabelOverrideMutation({
          campaignKey: command.campaignKey,
          label: command.label,
        });
        return { command: 'set-campaign-label-override', ...mutation };
      } catch (error) {
        return fail(error instanceof Error ? error.message : 'Usage engine campaign label command is invalid.');
      }
    }
    case 'import-cursor':
    case 'preview-merge':
      if (!hasExactKeys(command, ['command', 'input'])) {
        return fail(`Usage engine ${command.command} command contains unknown fields.`);
      }
      return { command: command.command, input: parseFileInput(command.input) };
    case 'confirm-merge':
      if (!hasExactKeys(command, ['command', 'confirmationToken', 'documentDigest', 'input'])) {
        return fail('Usage engine confirm-merge command contains unknown fields.');
      }
      try {
        const proof = parseMergePreviewProof({
          confirmationToken: command.confirmationToken,
          documentDigest: command.documentDigest,
        });
        return {
          ...proof,
          command: 'confirm-merge',
          input: parseFileInput(command.input),
        };
      } catch {
        return fail('Usage engine merge preview proof is invalid.');
      }
    default:
      return fail('Usage engine command kind is unknown.');
  }
};

export const parseWebUsageEngineCommand = (value: unknown): WebUsageEngineCommand => {
  const command = parseUsageEngineCommand(value);
  if ('input' in command) {
    if (command.input.kind === 'operator-file') {
      return fail('Web usage engine commands cannot name operator file paths.');
    }
    if (command.command === 'confirm-merge') {
      return {
        command: 'confirm-merge',
        confirmationToken: command.confirmationToken,
        documentDigest: command.documentDigest,
        input: command.input,
      };
    }
    return { command: command.command, input: command.input };
  }
  if (command.command === 'replace-project-groups') {
    return {
      command: 'replace-project-groups',
      projectGroups: command.projectGroups.map((group) => ({
        id: group.id,
        name: group.name,
        sources: group.sources.map((source) => {
          if (source.sourcePath !== undefined) {
            return fail('Web usage engine project groups cannot name source paths.');
          }
          return {
            ...(source.gitRemote === undefined ? {} : { gitRemote: source.gitRemote }),
            ...(source.machineId === undefined ? {} : { machineId: source.machineId }),
            ...(source.project === undefined ? {} : { project: source.project }),
          };
        }),
      })),
    };
  }
  if (command.command === 'replace-project-aliases') {
    return fail('Web usage engine commands cannot replace path-bearing project aliases.');
  }
  return command;
};

export interface UsageEngineCommandRequest {
  readonly command: UsageEngineCommand;
  readonly commandId: UsageEngineCommandId;
  readonly protocolVersion: UsageEngineProtocolVersion;
}

export const parseUsageEngineCommandRequest = (value: unknown): UsageEngineCommandRequest => {
  assertSerializedBound(value, usageEngineControlBounds.maxCommandBytes, 'Usage engine command request');
  if (!(isRecord(value) && hasExactKeys(value, ['command', 'commandId', 'protocolVersion']))) {
    return fail('Usage engine command request contains unknown or missing fields.');
  }
  return {
    command: parseUsageEngineCommand(value.command),
    commandId: parseUsageEngineCommandId(value.commandId),
    protocolVersion: parseUsageEngineProtocolVersion(value.protocolVersion),
  };
};

export type UsageEngineErrorCode =
  | 'aborted'
  | 'authentication-failed'
  | 'command-failed'
  | 'command-rejected'
  | 'engine-busy'
  | 'engine-unavailable'
  | 'invalid-response'
  | 'merge-invalid-input'
  | 'merge-invalid-json'
  | 'merge-self-merge'
  | 'merge-store-failed'
  | 'preview-stale'
  | 'protocol-mismatch'
  | 'request-too-large'
  | 'response-too-large'
  | 'timeout'
  | 'transport-failed';

const usageEngineErrorCodes = new Set<UsageEngineErrorCode>([
  'aborted',
  'authentication-failed',
  'command-failed',
  'command-rejected',
  'engine-busy',
  'engine-unavailable',
  'invalid-response',
  'merge-invalid-input',
  'merge-invalid-json',
  'merge-self-merge',
  'merge-store-failed',
  'preview-stale',
  'protocol-mismatch',
  'request-too-large',
  'response-too-large',
  'timeout',
  'transport-failed',
]);

export interface UsageEngineErrorPayload {
  readonly code: UsageEngineErrorCode;
  readonly message: string;
}

const parseErrorPayload = (value: unknown): UsageEngineErrorPayload => {
  if (!(isRecord(value) && hasExactKeys(value, ['code', 'message']))) {
    return fail('Usage engine error payload contains unknown or missing fields.');
  }
  if (!usageEngineErrorCodes.has(value.code as UsageEngineErrorCode)) {
    return fail('Usage engine error code is unknown.');
  }
  return {
    code: value.code as UsageEngineErrorCode,
    message: parseBoundedString(value.message, usageEngineControlBounds.maxMessageBytes, 'Usage engine error message'),
  };
};

export type UsageEngineCommandResult =
  | {
      readonly admission: 'accepted' | 'coalesced';
      readonly commandId: UsageEngineCommandId;
      readonly instanceId: UsageEngineInstanceId;
      readonly ok: true;
      readonly protocolVersion: UsageEngineProtocolVersion;
    }
  | {
      readonly commandId: UsageEngineCommandId;
      readonly error: UsageEngineErrorPayload;
      readonly instanceId: UsageEngineInstanceId;
      readonly ok: false;
      readonly protocolVersion: UsageEngineProtocolVersion;
    };

export const parseUsageEngineCommandResult = (value: unknown): UsageEngineCommandResult => {
  assertSerializedBound(value, usageEngineControlBounds.maxCommandResultBytes, 'Usage engine command result');
  if (!(isRecord(value) && typeof value.ok === 'boolean')) {
    return fail('Usage engine command result is invalid.');
  }
  if (value.ok) {
    if (!hasExactKeys(value, ['admission', 'commandId', 'instanceId', 'ok', 'protocolVersion'])) {
      return fail('Usage engine command result contains unknown or missing fields.');
    }
    if (value.admission !== 'accepted' && value.admission !== 'coalesced') {
      return fail('Usage engine command admission is invalid.');
    }
    return {
      admission: value.admission,
      commandId: parseUsageEngineCommandId(value.commandId),
      instanceId: parseUsageEngineInstanceId(value.instanceId),
      ok: true,
      protocolVersion: parseUsageEngineProtocolVersion(value.protocolVersion),
    };
  }
  if (!hasExactKeys(value, ['commandId', 'error', 'instanceId', 'ok', 'protocolVersion'])) {
    return fail('Usage engine command result contains unknown or missing fields.');
  }
  return {
    commandId: parseUsageEngineCommandId(value.commandId),
    error: parseErrorPayload(value.error),
    instanceId: parseUsageEngineInstanceId(value.instanceId),
    ok: false,
    protocolVersion: parseUsageEngineProtocolVersion(value.protocolVersion),
  };
};

export type UsageEngineCommandCancellationDisposition = 'already-completed' | 'cancelled' | 'cancelling' | 'finishing';

export interface UsageEngineCommandCancellationResult {
  readonly commandId: UsageEngineCommandId;
  readonly disposition: UsageEngineCommandCancellationDisposition;
  readonly instanceId: UsageEngineInstanceId;
  readonly protocolVersion: UsageEngineProtocolVersion;
}

const usageEngineCommandCancellationDispositions = new Set<UsageEngineCommandCancellationDisposition>([
  'already-completed',
  'cancelled',
  'cancelling',
  'finishing',
]);

export const parseUsageEngineCommandCancellationResult = (value: unknown): UsageEngineCommandCancellationResult => {
  assertSerializedBound(value, usageEngineControlBounds.maxCommandResultBytes, 'Usage engine cancellation result');
  if (!(isRecord(value) && hasExactKeys(value, ['commandId', 'disposition', 'instanceId', 'protocolVersion']))) {
    return fail('Usage engine cancellation result contains unknown or missing fields.');
  }
  if (!usageEngineCommandCancellationDispositions.has(value.disposition as UsageEngineCommandCancellationDisposition)) {
    return fail('Usage engine cancellation disposition is invalid.');
  }
  return {
    commandId: parseUsageEngineCommandId(value.commandId),
    disposition: value.disposition as UsageEngineCommandCancellationDisposition,
    instanceId: parseUsageEngineInstanceId(value.instanceId),
    protocolVersion: parseUsageEngineProtocolVersion(value.protocolVersion),
  };
};

export type UsageEngineCommandName = UsageEngineCommand['command'];

export interface UsageEngineMergeImportResult {
  readonly deleted: number;
  readonly fleetChanged: boolean;
  readonly inserted: number;
  readonly superseded: number;
  readonly unchanged: number;
  readonly updated: number;
  readonly warnings: number;
}

export interface UsageEngineMergePreviewOutput extends MergePreviewProof {
  readonly bundle: {
    readonly generatedAt: string;
    readonly machineId: string;
    readonly machineLabel: string;
  };
  readonly bytes: number;
  readonly kind: 'merge-preview';
  readonly result: UsageEngineMergeImportResult;
  readonly rows: number;
  readonly warningCount: number;
  readonly warningItems: readonly string[];
}

export interface UsageEngineCursorImportOutput {
  readonly alreadyImported: boolean;
  readonly artifactName: string;
  readonly kind: 'cursor-import';
}

export interface UsageEngineCollectionOutput {
  readonly kind: 'collection';
  readonly publication: UsageEngineCurrentPublication;
  readonly sources: readonly SourceControlEntryView[];
}

export interface UsageEngineMachineOutput {
  readonly kind: 'machine';
  readonly machine: { readonly id: string; readonly label: string };
}

export interface UsageEnginePublicationOutput {
  readonly kind: 'publication';
  readonly publication: UsageEngineCurrentPublication;
}

interface UsageEngineCommandCompletionBase {
  readonly commandId: UsageEngineCommandId;
  readonly completedAt: string;
}

export type UsageEngineCommandCompletion =
  | (UsageEngineCommandCompletionBase & {
      readonly command: 'preview-merge';
      readonly output: UsageEngineMergePreviewOutput;
      readonly state: 'succeeded';
    })
  | (UsageEngineCommandCompletionBase & {
      readonly command: 'import-cursor';
      readonly output: UsageEngineCursorImportOutput;
      readonly state: 'succeeded';
    })
  | (UsageEngineCommandCompletionBase & {
      readonly command: 'collect-fresh-quota' | 'collect-fresh-report';
      readonly output: UsageEngineCollectionOutput;
      readonly state: 'succeeded';
    })
  | (UsageEngineCommandCompletionBase & {
      readonly command: 'set-machine-label';
      readonly output: UsageEngineMachineOutput;
      readonly state: 'succeeded';
    })
  | (UsageEngineCommandCompletionBase & {
      readonly command: 'publish';
      readonly output: UsageEnginePublicationOutput;
      readonly state: 'succeeded';
    })
  | (UsageEngineCommandCompletionBase & {
      readonly command: Exclude<
        UsageEngineCommandName,
        | 'collect-fresh-quota'
        | 'collect-fresh-report'
        | 'import-cursor'
        | 'preview-merge'
        | 'publish'
        | 'set-machine-label'
      >;
      readonly output: { readonly kind: 'none' };
      readonly state: 'succeeded';
    })
  | (UsageEngineCommandCompletionBase & {
      readonly command: UsageEngineCommandName;
      readonly error: UsageEngineErrorPayload;
      readonly state: 'failed';
    });

const usageEngineCommandNames = new Set<UsageEngineCommandName>([
  'collect-fresh-report',
  'collect-fresh-quota',
  'confirm-merge',
  'detect-all',
  'import-cursor',
  'preview-merge',
  'publish',
  'replace-project-aliases',
  'replace-project-groups',
  'replace-project-groups-by-reference',
  'run-all-enabled',
  'run-source',
  'set-campaign-label-override',
  'set-machine-label',
  'set-source-enabled',
]);

const parseUsageEngineCommandName = (value: unknown): UsageEngineCommandName => {
  if (!(typeof value === 'string' && usageEngineCommandNames.has(value as UsageEngineCommandName))) {
    return fail('Usage engine completion command kind is unknown.');
  }
  return value as UsageEngineCommandName;
};

const parseMergeCount = (value: unknown, label: string): number =>
  parseNonNegativeSafeInteger(value, MAX_PORTABLE_USAGE_ROWS, label);

const parseMergeWarningCount = (value: unknown, label: string): number =>
  parseNonNegativeSafeInteger(value, Number.MAX_SAFE_INTEGER, label);

const parseMergeImportResult = (value: unknown): UsageEngineMergeImportResult => {
  if (
    !(
      isRecord(value) &&
      hasExactKeys(value, ['deleted', 'fleetChanged', 'inserted', 'superseded', 'unchanged', 'updated', 'warnings']) &&
      typeof value.fleetChanged === 'boolean'
    )
  ) {
    return fail('Usage engine merge result contains unknown or missing fields.');
  }
  return {
    deleted: parseMergeCount(value.deleted, 'Usage engine merge deleted count'),
    fleetChanged: value.fleetChanged,
    inserted: parseMergeCount(value.inserted, 'Usage engine merge inserted count'),
    superseded: parseMergeCount(value.superseded, 'Usage engine merge superseded count'),
    unchanged: parseMergeCount(value.unchanged, 'Usage engine merge unchanged count'),
    updated: parseMergeCount(value.updated, 'Usage engine merge updated count'),
    warnings: parseMergeWarningCount(value.warnings, 'Usage engine merge warning count'),
  };
};

const assertMergeResultRows = (result: UsageEngineMergeImportResult, rows: number): void => {
  const classifiedRows = result.deleted + result.inserted + result.superseded + result.unchanged + result.updated;
  if (classifiedRows !== rows) {
    fail('Usage engine merge result counts do not match its row count.');
  }
};

// The merge service truncates preview warnings before they cross this boundary
// (MAX_MANUAL_MERGE_PREVIEW_WARNINGS / MAX_PREVIEW_WARNING_CHARACTERS in @ai-usage/usage-merge).
// Both truncations count UTF-16 code units, so these ceilings do too: a byte bound would reject a
// legitimately truncated multi-byte warning.
const MAX_MERGE_PREVIEW_WARNING_ITEMS = 20;
const MAX_MERGE_PREVIEW_WARNING_ITEM_CHARACTERS = 512;
const MAX_MERGE_PREVIEW_MACHINE_LABEL_CHARACTERS = 120;

const parseBoundedCharacters = (value: unknown, maximumCharacters: number, label: string): string => {
  if (!(typeof value === 'string' && value.length > 0 && value.length <= maximumCharacters)) {
    return fail(`${label} is invalid or exceeds its length limit.`);
  }
  return value;
};

const parseMergePreviewBundle = (value: unknown): UsageEngineMergePreviewOutput['bundle'] => {
  if (!(isRecord(value) && hasExactKeys(value, ['generatedAt', 'machineId', 'machineLabel']))) {
    return fail('Usage engine merge preview bundle contains unknown or missing fields.');
  }
  return {
    generatedAt: parseIsoTimestamp(value.generatedAt, 'Usage engine merge preview bundle timestamp'),
    machineId: parseBoundedString(value.machineId, maxOpaqueIdBytes, 'Usage engine merge preview bundle machine ID'),
    machineLabel: parseBoundedCharacters(
      value.machineLabel,
      MAX_MERGE_PREVIEW_MACHINE_LABEL_CHARACTERS,
      'Usage engine merge preview bundle machine label',
    ),
  };
};

const parseMergePreviewWarningItems = (value: unknown): readonly string[] => {
  if (!(Array.isArray(value) && value.length <= MAX_MERGE_PREVIEW_WARNING_ITEMS)) {
    return fail('Usage engine merge preview warning items are invalid.');
  }
  return Object.freeze(
    value.map((item) => {
      if (!(typeof item === 'string' && item.length <= MAX_MERGE_PREVIEW_WARNING_ITEM_CHARACTERS)) {
        return fail('Usage engine merge preview warning item is invalid or exceeds its length limit.');
      }
      return item;
    }),
  );
};

export const parseUsageEngineMergePreviewOutput = (value: unknown): UsageEngineMergePreviewOutput => {
  if (
    !(
      isRecord(value) &&
      hasExactKeys(value, [
        'bundle',
        'bytes',
        'confirmationToken',
        'documentDigest',
        'kind',
        'result',
        'rows',
        'warningCount',
        'warningItems',
      ]) &&
      value.kind === 'merge-preview'
    )
  ) {
    return fail('Usage engine merge preview output contains unknown or missing fields.');
  }
  let proof: MergePreviewProof;
  try {
    proof = parseMergePreviewProof({
      confirmationToken: value.confirmationToken,
      documentDigest: value.documentDigest,
    });
  } catch {
    return fail('Usage engine merge document digest is invalid.');
  }
  const result = parseMergeImportResult(value.result);
  const rows = parseMergeCount(value.rows, 'Usage engine merge row count');
  assertMergeResultRows(result, rows);
  const warningCount = parseMergeWarningCount(value.warningCount, 'Usage engine merge preview warning count');
  const warningItems = parseMergePreviewWarningItems(value.warningItems);
  // The items are an excerpt of the counted warnings, so more excerpts than warnings is incoherent:
  // the panel would list rows its own summary denies exist.
  if (warningItems.length > warningCount) {
    fail('Usage engine merge preview warning items exceed its warning count.');
  }
  return {
    ...proof,
    bundle: parseMergePreviewBundle(value.bundle),
    bytes: parseNonNegativeSafeInteger(value.bytes, MAX_PORTABLE_USAGE_BYTES, 'Usage engine merge byte count'),
    kind: 'merge-preview',
    result,
    rows,
    warningCount,
    warningItems,
  };
};

export const parseUsageEngineCursorImportOutput = (value: unknown): UsageEngineCursorImportOutput => {
  if (
    !(
      isRecord(value) &&
      hasExactKeys(value, ['alreadyImported', 'artifactName', 'kind']) &&
      value.kind === 'cursor-import' &&
      typeof value.alreadyImported === 'boolean'
    )
  ) {
    return fail('Usage engine Cursor import output is invalid.');
  }
  const artifactName = parseBoundedString(
    value.artifactName,
    usageEngineControlBounds.maxFilePathBytes,
    'Usage engine Cursor artifact name',
  );
  if (artifactName === '.' || artifactName === '..' || artifactName.includes('/') || artifactName.includes('\\')) {
    return fail('Usage engine Cursor artifact name is invalid.');
  }
  return { alreadyImported: value.alreadyImported, artifactName, kind: 'cursor-import' };
};

const parseRequiredPublication = (value: unknown): UsageEngineCurrentPublication => {
  if (!(isRecord(value) && hasExactKeys(value, ['publishedAt', 'revision']))) {
    return fail('Usage engine publication contains unknown or missing fields.');
  }
  return {
    publishedAt: parseIsoTimestamp(value.publishedAt, 'Usage engine publication timestamp'),
    revision: parseUsageEnginePublicationRevision(value.revision),
  };
};

export const parseUsageEngineCollectionOutput = (value: unknown): UsageEngineCollectionOutput => {
  if (
    !(
      isRecord(value) &&
      hasExactKeys(value, ['kind', 'publication', 'sources']) &&
      value.kind === 'collection' &&
      Array.isArray(value.sources)
    ) ||
    value.sources.length > collectionSourceIds.length
  ) {
    return fail('Usage engine collection output is invalid.');
  }
  const sources = value.sources.map(parseSourceControlEntryView);
  if (new Set(sources.map(({ id }) => id)).size !== sources.length) {
    return fail('Usage engine collection output contains duplicate sources.');
  }
  return { kind: 'collection', publication: parseRequiredPublication(value.publication), sources };
};

export const parseUsageEngineMachineOutput = (value: unknown): UsageEngineMachineOutput => {
  if (
    !(
      isRecord(value) &&
      hasExactKeys(value, ['kind', 'machine']) &&
      value.kind === 'machine' &&
      isRecord(value.machine) &&
      hasExactKeys(value.machine, ['id', 'label'])
    )
  ) {
    return fail('Usage engine machine output is invalid.');
  }
  return {
    kind: 'machine',
    machine: {
      id: parseBoundedString(value.machine.id, maxOpaqueIdBytes, 'Usage engine machine ID'),
      label: parseBoundedString(
        value.machine.label,
        usageEngineControlBounds.maxMessageBytes,
        'Usage engine machine label',
      ),
    },
  };
};

export const parseUsageEnginePublicationOutput = (value: unknown): UsageEnginePublicationOutput => {
  if (!(isRecord(value) && hasExactKeys(value, ['kind', 'publication']) && value.kind === 'publication')) {
    return fail('Usage engine publication output is invalid.');
  }
  return { kind: 'publication', publication: parseRequiredPublication(value.publication) };
};

export const parseUsageEngineCommandCompletion = (value: unknown): UsageEngineCommandCompletion => {
  assertSerializedBound(
    value,
    usageEngineControlBounds.maxCommandCompletionEventBytes,
    'Usage engine command completion',
  );
  if (!(isRecord(value) && typeof value.state === 'string')) {
    return fail('Usage engine command completion is invalid.');
  }
  const command = parseUsageEngineCommandName(value.command);
  const base = {
    commandId: parseUsageEngineCommandId(value.commandId),
    completedAt: parseIsoTimestamp(value.completedAt, 'Usage engine command completion timestamp'),
  };
  if (value.state === 'failed') {
    if (!hasExactKeys(value, ['command', 'commandId', 'completedAt', 'error', 'state'])) {
      return fail('Usage engine failed command completion contains unknown or missing fields.');
    }
    return { ...base, command, error: parseErrorPayload(value.error), state: 'failed' };
  }
  if (value.state !== 'succeeded') {
    return fail('Usage engine command completion state is invalid.');
  }
  if (!hasExactKeys(value, ['command', 'commandId', 'completedAt', 'output', 'state'])) {
    return fail('Usage engine successful command completion contains unknown or missing fields.');
  }
  if (command === 'preview-merge') {
    return { ...base, command, output: parseUsageEngineMergePreviewOutput(value.output), state: 'succeeded' };
  }
  if (command === 'import-cursor') {
    return { ...base, command, output: parseUsageEngineCursorImportOutput(value.output), state: 'succeeded' };
  }
  if (command === 'collect-fresh-report' || command === 'collect-fresh-quota') {
    return { ...base, command, output: parseUsageEngineCollectionOutput(value.output), state: 'succeeded' };
  }
  if (command === 'set-machine-label') {
    return { ...base, command, output: parseUsageEngineMachineOutput(value.output), state: 'succeeded' };
  }
  if (command === 'publish') {
    return { ...base, command, output: parseUsageEnginePublicationOutput(value.output), state: 'succeeded' };
  }
  if (!(isRecord(value.output) && hasExactKeys(value.output, ['kind']) && value.output.kind === 'none')) {
    return fail('Only a preview command may carry merge preview output.');
  }
  return { ...base, command, output: { kind: 'none' }, state: 'succeeded' };
};

export type UsageEngineForegroundOutcome =
  | {
      readonly completion: UsageEngineCommandCompletion;
      readonly instanceId: UsageEngineInstanceId;
      readonly kind: 'command-completed';
      readonly protocolVersion: UsageEngineProtocolVersion;
      readonly status: UsageEngineStatus;
    }
  | {
      readonly kind: 'admission-rejected';
      readonly result: Extract<UsageEngineCommandResult, { readonly ok: false }>;
    };

export const parseUsageEngineForegroundOutcome = (value: unknown): UsageEngineForegroundOutcome => {
  assertSerializedBound(value, usageEngineControlBounds.maxForegroundOutcomeBytes, 'Usage engine foreground outcome');
  if (!(isRecord(value) && typeof value.kind === 'string')) {
    return fail('Usage engine foreground outcome is invalid.');
  }
  if (value.kind === 'command-completed') {
    if (!hasExactKeys(value, ['completion', 'instanceId', 'kind', 'protocolVersion', 'status'])) {
      return fail('Usage engine completed foreground outcome contains unknown or missing fields.');
    }
    const instanceId = parseUsageEngineInstanceId(value.instanceId);
    const status = parseUsageEngineStatus(value.status);
    if (status.instanceId !== instanceId) {
      return fail('Usage engine foreground outcome has inconsistent instance identities.');
    }
    return {
      completion: parseUsageEngineCommandCompletion(value.completion),
      instanceId,
      kind: 'command-completed',
      protocolVersion: parseUsageEngineProtocolVersion(value.protocolVersion),
      status,
    };
  }
  if (value.kind === 'admission-rejected') {
    if (!hasExactKeys(value, ['kind', 'result'])) {
      return fail('Usage engine rejected foreground outcome contains unknown or missing fields.');
    }
    const result = parseUsageEngineCommandResult(value.result);
    if (result.ok) {
      return fail('Usage engine rejected foreground outcome must contain a rejected admission.');
    }
    return { kind: 'admission-rejected', result };
  }
  return fail('Usage engine foreground outcome kind is unknown.');
};

export type UsageEngineReadiness = 'starting' | 'ready' | 'degraded' | 'stopping';

export interface UsageEngineDegradedReason {
  readonly code: string;
  readonly message?: string;
}

export interface UsageEngineCurrentPublication {
  readonly publishedAt: string;
  readonly revision: UsageEnginePublicationRevision;
}

export interface UsageEngineStatus {
  readonly currentPublication: UsageEngineCurrentPublication | null;
  readonly degradedReason: UsageEngineDegradedReason | null;
  readonly generatedAt: string;
  readonly generation: number;
  readonly instanceId: UsageEngineInstanceId;
  readonly protocolVersion: UsageEngineProtocolVersion;
  readonly readiness: UsageEngineReadiness;
  readonly sourceControl: SourceControlView;
  readonly storeSchemaVersion: number | null;
}

const readinessValues = new Set<UsageEngineReadiness>(['starting', 'ready', 'degraded', 'stopping']);

const parseDegradedReason = (value: unknown): UsageEngineDegradedReason | null => {
  if (value === null) {
    return null;
  }
  if (!(isRecord(value) && hasOnlyKeys(value, ['code', 'message']) && Object.hasOwn(value, 'code'))) {
    return fail('Usage engine degraded reason contains unknown or missing fields.');
  }
  if (!(typeof value.code === 'string' && boundedCodePattern.test(value.code))) {
    return fail('Usage engine degraded reason code is invalid.');
  }
  return {
    code: value.code,
    ...(value.message === undefined
      ? {}
      : {
          message: parseBoundedString(
            value.message,
            usageEngineControlBounds.maxMessageBytes,
            'Usage engine degraded reason message',
          ),
        }),
  };
};

const parseCurrentPublication = (value: unknown): UsageEngineCurrentPublication | null => {
  if (value === null) {
    return null;
  }
  return parseRequiredPublication(value);
};

export const parseUsageEngineStatus = (value: unknown): UsageEngineStatus => {
  assertSerializedBound(value, usageEngineControlBounds.maxStatusBytes, 'Usage engine status');
  if (
    !(
      isRecord(value) &&
      hasExactKeys(value, [
        'currentPublication',
        'degradedReason',
        'generatedAt',
        'generation',
        'instanceId',
        'protocolVersion',
        'readiness',
        'sourceControl',
        'storeSchemaVersion',
      ])
    )
  ) {
    return fail('Usage engine status contains unknown or missing fields.');
  }
  if (!readinessValues.has(value.readiness as UsageEngineReadiness)) {
    return fail('Usage engine readiness is invalid.');
  }
  const instanceId = parseUsageEngineInstanceId(value.instanceId);
  const sourceControl = parseSourceControlSnapshot(value.sourceControl);
  if (sourceControl.instanceId !== instanceId) {
    return fail('Usage engine status has inconsistent instance identities.');
  }
  const readiness = value.readiness as UsageEngineReadiness;
  const degradedReason = parseDegradedReason(value.degradedReason);
  if ((readiness === 'degraded') !== (degradedReason !== null)) {
    return fail('Usage engine degraded readiness and reason are inconsistent.');
  }
  const storeSchemaVersion =
    value.storeSchemaVersion === null
      ? null
      : parseNonNegativeSafeInteger(
          value.storeSchemaVersion,
          Number.MAX_SAFE_INTEGER,
          'Usage engine store schema version',
        );
  if (readiness === 'ready' && (storeSchemaVersion === null || storeSchemaVersion === 0)) {
    return fail('A ready usage engine requires a compatible store schema.');
  }
  const currentPublication = parseCurrentPublication(value.currentPublication);
  const sourceRevision = sourceControl.publication.revision;
  if ((currentPublication?.revision ?? undefined) !== sourceRevision) {
    return fail('Usage engine status has inconsistent publication revisions.');
  }
  if (currentPublication !== null && currentPublication.publishedAt !== sourceControl.publication.lastPublishedAt) {
    return fail('Usage engine status has inconsistent publication timestamps.');
  }
  return {
    currentPublication,
    degradedReason,
    generatedAt: parseIsoTimestamp(value.generatedAt, 'Usage engine status timestamp'),
    generation: parseNonNegativeSafeInteger(
      value.generation,
      sourceControlBounds.maxGeneration,
      'Usage engine status generation',
    ),
    instanceId,
    protocolVersion: parseUsageEngineProtocolVersion(value.protocolVersion),
    readiness,
    sourceControl,
    storeSchemaVersion,
  };
};

export type UsageEngineEvent =
  | {
      readonly completion: UsageEngineCommandCompletion;
      readonly event: 'command-completed';
      readonly eventId: UsageEngineEventId;
      readonly instanceId: UsageEngineInstanceId;
      readonly sequence: UsageEngineEventSequence;
    }
  | {
      readonly event: 'status';
      readonly eventId: UsageEngineEventId;
      readonly instanceId: UsageEngineInstanceId;
      readonly sequence: UsageEngineEventSequence;
      readonly status: UsageEngineStatus;
    }
  | {
      readonly event: 'source-control';
      readonly eventId: UsageEngineEventId;
      readonly instanceId: UsageEngineInstanceId;
      readonly sequence: UsageEngineEventSequence;
      readonly snapshot: SourceControlView;
    }
  | {
      readonly event: 'report-published';
      readonly eventId: UsageEngineEventId;
      readonly instanceId: UsageEngineInstanceId;
      readonly publication: ReportPublishedEvent;
      readonly sequence: UsageEngineEventSequence;
    };

const maximumEventBytes = (event: string): number => {
  if (event === 'command-completed') {
    return usageEngineControlBounds.maxCommandCompletionEventBytes;
  }
  if (event === 'report-published') {
    return usageEngineControlBounds.maxEventBytes;
  }
  if (event === 'status') {
    return usageEngineControlBounds.maxStatusEventBytes;
  }
  return usageEngineControlBounds.maxSnapshotEventBytes;
};

export const parseUsageEngineEvent = (value: unknown): UsageEngineEvent => {
  if (!(isRecord(value) && typeof value.event === 'string')) {
    return fail('Usage engine event is invalid.');
  }
  assertSerializedBound(value, maximumEventBytes(value.event), 'Usage engine event');
  const instanceId = parseUsageEngineInstanceId(value.instanceId);
  const eventId = parseUsageEngineEventId(value.eventId);
  const sequence = parseUsageEngineEventSequence(value.sequence);
  if (value.event === 'command-completed') {
    if (!hasExactKeys(value, ['completion', 'event', 'eventId', 'instanceId', 'sequence'])) {
      return fail('Usage engine command completion event contains unknown or missing fields.');
    }
    return {
      completion: parseUsageEngineCommandCompletion(value.completion),
      event: 'command-completed',
      eventId,
      instanceId,
      sequence,
    };
  }
  if (value.event === 'status') {
    if (!hasExactKeys(value, ['event', 'eventId', 'instanceId', 'sequence', 'status'])) {
      return fail('Usage engine status event contains unknown or missing fields.');
    }
    const status = parseUsageEngineStatus(value.status);
    if (status.instanceId !== instanceId) {
      return fail('Usage engine status event has inconsistent instance identities.');
    }
    return { event: 'status', eventId, instanceId, sequence, status };
  }
  if (value.event === 'source-control') {
    if (!hasExactKeys(value, ['event', 'eventId', 'instanceId', 'sequence', 'snapshot'])) {
      return fail('Usage engine source-control event contains unknown or missing fields.');
    }
    const snapshot = parseSourceControlSnapshot(value.snapshot);
    if (snapshot.instanceId !== instanceId) {
      return fail('Usage engine source-control event has inconsistent instance identities.');
    }
    return { event: 'source-control', eventId, instanceId, sequence, snapshot };
  }
  if (value.event === 'report-published') {
    if (!hasExactKeys(value, ['event', 'eventId', 'instanceId', 'publication', 'sequence'])) {
      return fail('Usage engine publication event contains unknown or missing fields.');
    }
    const publication = parseReportPublishedEvent(value.publication);
    if (publication.instanceId !== instanceId) {
      return fail('Usage engine publication event has inconsistent instance identities.');
    }
    return { event: 'report-published', eventId, instanceId, publication, sequence };
  }
  return fail('Usage engine event kind is unknown.');
};

export interface UsageEngineErrorResponse {
  readonly error: UsageEngineErrorPayload;
  readonly instanceId?: UsageEngineInstanceId;
  readonly ok: false;
  readonly protocolVersion: UsageEngineProtocolVersion;
}

export const parseUsageEngineErrorResponse = (value: unknown): UsageEngineErrorResponse => {
  assertSerializedBound(value, usageEngineControlBounds.maxErrorResponseBytes, 'Usage engine error response');
  if (
    !(
      isRecord(value) &&
      hasOnlyKeys(value, ['error', 'instanceId', 'ok', 'protocolVersion']) &&
      hasExactKeys(
        value,
        value.instanceId === undefined
          ? ['error', 'ok', 'protocolVersion']
          : ['error', 'instanceId', 'ok', 'protocolVersion'],
      ) &&
      value.ok === false
    )
  ) {
    return fail('Usage engine error response contains unknown or missing fields.');
  }
  return {
    error: parseErrorPayload(value.error),
    ...(value.instanceId === undefined ? {} : { instanceId: parseUsageEngineInstanceId(value.instanceId) }),
    ok: false,
    protocolVersion: parseUsageEngineProtocolVersion(value.protocolVersion),
  };
};

export type UsageEngineRetryOperation = 'command' | 'events' | 'status';
export type UsageEngineRetryDisposition = 'never' | 'reconnect' | 'safe-request' | 'same-command-id';

export const classifyUsageEngineRetry = (
  code: UsageEngineErrorCode,
  operation: UsageEngineRetryOperation,
): UsageEngineRetryDisposition => {
  if (
    code === 'aborted' ||
    code === 'authentication-failed' ||
    code === 'command-failed' ||
    code === 'command-rejected' ||
    code === 'invalid-response' ||
    code === 'merge-invalid-input' ||
    code === 'merge-invalid-json' ||
    code === 'merge-self-merge' ||
    code === 'merge-store-failed' ||
    code === 'preview-stale' ||
    code === 'protocol-mismatch' ||
    code === 'request-too-large' ||
    code === 'response-too-large'
  ) {
    return 'never';
  }
  if (operation === 'command') {
    return 'same-command-id';
  }
  return operation === 'events' ? 'reconnect' : 'safe-request';
};
