/** A bounded joint distribution, never reconstructed from independent marginal totals. */
export interface TokenFlowContribution {
  cacheRead: number;
  cacheWrite: number;
  input: number;
  model: string;
  output: number;
  projectKey: string;
  projectLabel: string;
}

export interface TokenFlowLink extends Omit<TokenFlowContribution, 'projectKey' | 'model'> {
  model: string | null;
  /** null denotes the overflow group, distinct from every actual project/model name. */
  projectKey: string | null;
}

export interface TokenFlow {
  links: TokenFlowLink[];
  partialSessions: number;
  sessions: number;
  total: number;
}

export const tokenCategories = ['input', 'cacheRead', 'cacheWrite', 'output'] as const;
export const flowTokens = (value: Pick<TokenFlowContribution, (typeof tokenCategories)[number]>): number =>
  value.input + value.cacheRead + value.cacheWrite + value.output;

const count = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Observatory counts must be non-negative safe integers');
  }
  return value;
};

export const parseTokenFlow = (value: unknown): TokenFlow => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid token flow');
  }
  const flow = value as Record<string, unknown>;
  if (Object.keys(flow).sort().join() !== 'links,partialSessions,sessions,total') {
    throw new Error('Invalid flow fields');
  }
  const total = count(flow.total);
  const sessions = count(flow.sessions);
  const partialSessions = count(flow.partialSessions);
  if (partialSessions > sessions || !Array.isArray(flow.links) || flow.links.length > 117) {
    throw new Error('Invalid flow bounds');
  }
  const seen = new Set<string>();
  let sum = 0;
  for (const raw of flow.links) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error('Invalid flow link');
    }
    const link = raw as Record<string, unknown>;
    if (Object.keys(link).sort().join() !== 'cacheRead,cacheWrite,input,model,output,projectKey,projectLabel') {
      throw new Error('Invalid link fields');
    }
    for (const field of ['projectKey', 'model', 'projectLabel']) {
      const text = link[field];
      if (field !== 'projectLabel' && text === null) {
        continue;
      }
      if (typeof text !== 'string' || text.length > 2048) {
        throw new Error('Invalid flow label');
      }
    }
    const key = JSON.stringify([link.projectKey, link.model]);
    if (seen.has(key)) {
      throw new Error('Duplicate flow link');
    }
    seen.add(key);
    for (const category of tokenCategories) {
      sum += count(link[category]);
    }
  }
  if (!Number.isSafeInteger(sum) || sum !== total) {
    throw new Error('Token flow does not conserve tokens');
  }
  return value as TokenFlow;
};
