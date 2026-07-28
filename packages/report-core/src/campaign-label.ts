import { MAX_SESSION_QUERY_RESULT_BYTES } from './report-budgets';

export const MAX_CAMPAIGN_LABEL_OVERRIDES = 5000;
export const MAX_CAMPAIGN_LABEL_LENGTH = 256;
export const MAX_CAMPAIGN_KEY_BYTES = 64 * 1024;
export const MAX_CAMPAIGN_LABEL_OVERRIDES_BYTES = MAX_SESSION_QUERY_RESULT_BYTES;

export interface CampaignLabelOverride {
  campaignKey: string;
  label: string;
}

export interface CampaignLabelOverrideMutation {
  campaignKey: string;
  label: string | null;
}

const textEncoder = new TextEncoder();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasExactKeys = (record: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actualKeys = Object.keys(record);
  return actualKeys.length === keys.length && keys.every((key) => Object.hasOwn(record, key));
};

const parseCampaignKey = (value: unknown): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('Invalid campaign label override: campaignKey must be a non-empty string');
  }
  if (textEncoder.encode(value).byteLength > MAX_CAMPAIGN_KEY_BYTES) {
    throw new Error(`Invalid campaign label override: campaignKey exceeds ${MAX_CAMPAIGN_KEY_BYTES} bytes`);
  }
  return value;
};

const parseCampaignLabel = (value: unknown, canonical: boolean): string => {
  if (typeof value !== 'string') {
    throw new Error('Invalid campaign label override: label must be a string');
  }
  const label = value.trim();
  if (label.length === 0) {
    throw new Error('Invalid campaign label override: label must not be empty');
  }
  if (label.length > MAX_CAMPAIGN_LABEL_LENGTH) {
    throw new Error(`Invalid campaign label override: label exceeds ${MAX_CAMPAIGN_LABEL_LENGTH} characters`);
  }
  if (canonical && label !== value) {
    throw new Error('Invalid campaign label override: stored labels must be trimmed');
  }
  return label;
};

export const parseCampaignLabelOverrideMutation = (value: unknown): CampaignLabelOverrideMutation => {
  if (!(isRecord(value) && hasExactKeys(value, ['campaignKey', 'label']))) {
    throw new Error('Invalid campaign label mutation: expected exactly campaignKey and label');
  }
  const campaignKey = parseCampaignKey(value.campaignKey);
  if (value.label === null) {
    return { campaignKey, label: null };
  }
  return { campaignKey, label: parseCampaignLabel(value.label, false) };
};

export const parseCampaignLabelOverrides = (value: unknown): CampaignLabelOverride[] => {
  if (!Array.isArray(value)) {
    throw new Error('Invalid campaign label overrides: expected an array');
  }
  if (value.length > MAX_CAMPAIGN_LABEL_OVERRIDES) {
    throw new Error(`Invalid campaign label overrides: exceeds ${MAX_CAMPAIGN_LABEL_OVERRIDES} entries`);
  }

  const seenCampaignKeys = new Set<string>();
  const overrides: CampaignLabelOverride[] = [];
  for (const entry of value) {
    if (!(isRecord(entry) && hasExactKeys(entry, ['campaignKey', 'label']))) {
      throw new Error('Invalid campaign label override: expected exactly campaignKey and label');
    }
    const campaignKey = parseCampaignKey(entry.campaignKey);
    if (seenCampaignKeys.has(campaignKey)) {
      throw new Error(`Invalid campaign label overrides: duplicate campaignKey "${campaignKey}"`);
    }
    seenCampaignKeys.add(campaignKey);
    overrides.push({ campaignKey, label: parseCampaignLabel(entry.label, true) });
  }

  const byteLength = textEncoder.encode(JSON.stringify(overrides)).byteLength;
  if (byteLength > MAX_CAMPAIGN_LABEL_OVERRIDES_BYTES) {
    throw new Error(`Invalid campaign label overrides: exceeds ${MAX_CAMPAIGN_LABEL_OVERRIDES_BYTES} bytes`);
  }
  return overrides;
};

export const isCampaignLabelOverrides = (value: unknown): value is CampaignLabelOverride[] => {
  try {
    parseCampaignLabelOverrides(value);
    return true;
  } catch {
    return false;
  }
};
