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

const retain = (entries: readonly TokenFlowContribution[], key: 'model' | 'projectKey', maximum: number) => {
  const sums = new Map<string, number>();
  for (const entry of entries) {
    sums.set(entry[key], (sums.get(entry[key]) ?? 0) + flowTokens(entry));
  }
  return new Set(
    [...sums]
      .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
      .slice(0, maximum)
      .map(([name]) => name),
  );
};

export const buildTokenFlow = (
  entries: readonly TokenFlowContribution[],
  sessions: number,
  partialSessions: number,
): TokenFlow => {
  for (const entry of entries) {
    for (const category of tokenCategories) {
      count(entry[category]);
    }
  }
  const projects = retain(entries, 'projectKey', 8);
  const models = retain(entries, 'model', 12);
  const grouped = new Map<string, TokenFlowLink>();
  for (const entry of entries) {
    if (flowTokens(entry) === 0) {
      continue;
    }
    const projectKey = projects.has(entry.projectKey) ? entry.projectKey : null;
    const model = models.has(entry.model) ? entry.model : null;
    const key = JSON.stringify([projectKey, model]);
    const link = grouped.get(key) ?? {
      projectKey,
      projectLabel: projectKey === null ? 'Other projects' : entry.projectLabel,
      model,
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
    };
    for (const category of tokenCategories) {
      link[category] += entry[category];
    }
    grouped.set(key, link);
  }
  const links = [...grouped.values()].sort(
    (a, b) =>
      String(a.projectKey).localeCompare(String(b.projectKey)) || String(a.model).localeCompare(String(b.model)),
  );
  return parseTokenFlow({
    links,
    sessions,
    partialSessions,
    total: links.reduce((sum, link) => sum + flowTokens(link), 0),
  });
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
