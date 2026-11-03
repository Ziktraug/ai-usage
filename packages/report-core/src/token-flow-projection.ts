import {
  flowTokens,
  parseTokenFlow,
  type TokenFlow,
  type TokenFlowContribution,
  type TokenFlowLink,
  tokenCategories,
} from './observatory';

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
