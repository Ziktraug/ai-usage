export type ModelGroupMode = 'base' | 'exact';

export interface ModelIdentity {
  baseId: string;
  canonicalId: string;
  providerPrefix: string | null;
  rawId: string;
  variantTags: string[];
}

const UNKNOWN_MODEL_ID = 'unknown';
const PROVIDER_SEPARATOR = '/';
const PREVIEW_WITH_DATE_SUFFIX = /-preview-\d{2}-\d{2}$/;

const stripProviderPrefix = (model: string) => {
  const normalized = model.trim().toLowerCase();
  if (!normalized) {
    return { canonicalId: UNKNOWN_MODEL_ID, providerPrefix: null };
  }

  const separatorIndex = normalized.lastIndexOf(PROVIDER_SEPARATOR);
  if (separatorIndex < 0) {
    return { canonicalId: normalized, providerPrefix: null };
  }

  return {
    canonicalId: normalized.slice(separatorIndex + 1) || UNKNOWN_MODEL_ID,
    providerPrefix: normalized.slice(0, separatorIndex) || null,
  };
};

const stripSuffix = (value: string, suffix: string) => (value.endsWith(suffix) ? value.slice(0, -suffix.length) : null);

const stripVariantSuffix = (value: string): { baseId: string; tag: string } | null => {
  const previewWithDate = value.match(PREVIEW_WITH_DATE_SUFFIX);
  if (previewWithDate) {
    return { baseId: value.slice(0, -previewWithDate[0].length), tag: 'preview' };
  }

  const pairedThinkingSuffixes: [suffix: string, tag: string][] = [
    ['-high-thinking', 'high'],
    ['-xhigh-thinking', 'xhigh'],
    ['-thinking-high', 'high'],
    ['-thinking-xhigh', 'xhigh'],
  ];
  for (const [suffix, tag] of pairedThinkingSuffixes) {
    const baseId = stripSuffix(value, suffix);
    if (baseId) {
      return { baseId: `${baseId}-thinking`, tag };
    }
  }

  const simpleSuffixes = ['thinking', 'fast', 'medium', 'high', 'xhigh', 'max', 'preview'] as const;
  for (const tag of simpleSuffixes) {
    const baseId = stripSuffix(value, `-${tag}`);
    if (baseId) {
      return { baseId, tag };
    }
  }

  return null;
};

const modelBaseId = (canonicalId: string) => {
  let baseId = canonicalId;
  const variantTags: string[] = [];

  while (true) {
    const stripped = stripVariantSuffix(baseId);
    if (!stripped) {
      return { baseId, variantTags };
    }
    baseId = stripped.baseId;
    variantTags.unshift(stripped.tag);
  }
};

export const parseModelIdentity = (model: string): ModelIdentity => {
  const rawId = model.trim();
  const { canonicalId, providerPrefix } = stripProviderPrefix(model);
  const { baseId, variantTags } = modelBaseId(canonicalId);
  return {
    baseId,
    canonicalId,
    providerPrefix,
    rawId,
    variantTags,
  };
};

export const modelGroupKey = (model: string, mode: ModelGroupMode = 'base') => {
  const identity = parseModelIdentity(model);
  return mode === 'exact' ? identity.canonicalId : identity.baseId;
};
