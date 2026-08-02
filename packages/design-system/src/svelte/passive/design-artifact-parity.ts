export type DesignDifferenceClassification = 'framework-syntax' | 'intentional-unused-code';
export type DesignDifferenceKind = 'changed' | 'missing' | 'unexpected';
export type DesignDifferenceScope = 'css' | 'export' | 'layer' | 'token';

export interface DesignArtifactSnapshot {
  css: string;
  exports: readonly string[];
  tokens: Readonly<Record<string, unknown>>;
}

export interface DesignArtifactDifference {
  key: string;
  kind: DesignDifferenceKind;
  reference?: string;
  scope: DesignDifferenceScope;
  target?: string;
}

export interface ApprovedDesignDifference {
  classification: DesignDifferenceClassification;
  key: string;
  kind: DesignDifferenceKind;
  reason: string;
  scope: DesignDifferenceScope;
}

export interface DesignParityEvidence {
  approvedDifferences: readonly ApprovedDesignDifference[];
  cssRuleCount: number;
  exportCount: number;
  layerOrder: readonly string[];
  tokenCount: number;
}

const CSS_PUNCTUATION = new Set(['{', '}', ':', ';', ',', '>', '+', '~']);
const LAYER_STATEMENT_PATTERN = /^@layer ([^;]+);$/;
const TRAILING_SEMICOLON_PATTERN = /;$/;
const WHITESPACE_CHARACTER_PATTERN = /\s/;

const stripCssComments = (source: string): string => {
  let stripped = '';
  let quote: '"' | "'" | undefined;
  let escaped = false;
  let index = 0;

  while (index < source.length) {
    const character = source[index];
    if (quote) {
      stripped += character;
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      stripped += character;
      index += 1;
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      const closingIndex = source.indexOf('*/', index + 2);
      if (closingIndex === -1) {
        throw new Error(`Unclosed CSS comment starting at byte ${index}.`);
      }
      index = closingIndex + 2;
      continue;
    }
    stripped += character;
    index += 1;
  }

  return stripped;
};

const normalizeCssText = (source: string): string => {
  let normalized = '';
  let pendingWhitespace = false;
  let quote: '"' | "'" | undefined;
  let escaped = false;

  for (const character of source) {
    if (quote) {
      normalized += character;
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      if (pendingWhitespace && normalized && !CSS_PUNCTUATION.has(normalized.at(-1) ?? '')) {
        normalized += ' ';
      }
      pendingWhitespace = false;
      quote = character;
      normalized += character;
      continue;
    }

    if (WHITESPACE_CHARACTER_PATTERN.test(character)) {
      pendingWhitespace = true;
      continue;
    }

    if (CSS_PUNCTUATION.has(character)) {
      normalized = normalized.trimEnd();
      normalized += character;
      pendingWhitespace = false;
      continue;
    }

    if (pendingWhitespace && normalized && !CSS_PUNCTUATION.has(normalized.at(-1) ?? '')) {
      normalized += ' ';
    }
    pendingWhitespace = false;
    normalized += character;
  }

  return normalized.trim();
};

interface CssBoundary {
  index: number;
  kind: ';' | '{';
}

const findCssBoundary = (source: string, startIndex: number): CssBoundary | undefined => {
  let quote: '"' | "'" | undefined;
  let escaped = false;
  let parenthesisDepth = 0;
  let bracketDepth = 0;

  for (let index = startIndex; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '(') {
      parenthesisDepth += 1;
      continue;
    }
    if (character === ')') {
      parenthesisDepth -= 1;
      continue;
    }
    if (character === '[') {
      bracketDepth += 1;
      continue;
    }
    if (character === ']') {
      bracketDepth -= 1;
      continue;
    }
    if (parenthesisDepth === 0 && bracketDepth === 0 && (character === ';' || character === '{')) {
      return { index, kind: character };
    }
  }

  return;
};

const findClosingBrace = (source: string, openingIndex: number): number => {
  let depth = 1;
  let quote: '"' | "'" | undefined;
  let escaped = false;

  for (let index = openingIndex + 1; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  throw new Error(`Unclosed CSS block starting at byte ${openingIndex}.`);
};

const hasNestedCssBlock = (source: string): boolean => findCssBoundary(source, 0)?.kind === '{';

const collectCssRules = (source: string, ancestors: readonly string[] = []): string[] => {
  const rules: string[] = [];
  let cursor = 0;

  while (cursor < source.length) {
    const boundary = findCssBoundary(source, cursor);
    if (!boundary) {
      const trailing = normalizeCssText(source.slice(cursor));
      if (trailing) {
        throw new Error(`Unexpected trailing CSS: ${trailing}`);
      }
      break;
    }

    const header = normalizeCssText(source.slice(cursor, boundary.index));
    if (!header) {
      throw new Error(`CSS statement at byte ${boundary.index} has no header.`);
    }

    if (boundary.kind === ';') {
      rules.push([...ancestors, `${header};`].join(' > '));
      cursor = boundary.index + 1;
      continue;
    }

    const closingIndex = findClosingBrace(source, boundary.index);
    const body = source.slice(boundary.index + 1, closingIndex);
    if (hasNestedCssBlock(body)) {
      rules.push(...collectCssRules(body, [...ancestors, header]));
    } else {
      rules.push(
        [...ancestors, `${header}{${normalizeCssText(body).replace(TRAILING_SEMICOLON_PATTERN, '')}}`].join(' > '),
      );
    }
    cursor = closingIndex + 1;
  }

  return rules;
};
const cssRulesFor = (source: string): string[] => collectCssRules(stripCssComments(source));

const canonicalValue = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalValue).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalValue(entryValue)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
};

const countValues = (values: readonly string[]): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
};

const compareSets = (
  scope: 'css' | 'export',
  referenceValues: readonly string[],
  targetValues: readonly string[],
): DesignArtifactDifference[] => {
  const referenceCounts = countValues(referenceValues);
  const targetCounts = countValues(targetValues);
  const keys = new Set([...referenceCounts.keys(), ...targetCounts.keys()]);
  const differences: DesignArtifactDifference[] = [];

  for (const key of [...keys].sort()) {
    const referenceCount = referenceCounts.get(key) ?? 0;
    const targetCount = targetCounts.get(key) ?? 0;
    if (referenceCount > targetCount) {
      differences.push({ key, kind: 'missing', reference: String(referenceCount), scope, target: String(targetCount) });
    } else if (targetCount > referenceCount) {
      differences.push({
        key,
        kind: 'unexpected',
        reference: String(referenceCount),
        scope,
        target: String(targetCount),
      });
    }
  }

  return differences;
};

const longestCommonSubsequenceLength = (reference: readonly string[], target: readonly string[]): number => {
  if (reference.length === target.length && reference.every((value, index) => value === target[index])) {
    return reference.length;
  }

  const [rows, columns] = reference.length >= target.length ? [reference, target] : [target, reference];
  let previous = new Uint32Array(columns.length + 1);
  for (const rowValue of rows) {
    const current = new Uint32Array(columns.length + 1);
    for (let columnIndex = 1; columnIndex <= columns.length; columnIndex += 1) {
      current[columnIndex] =
        rowValue === columns[columnIndex - 1]
          ? (previous[columnIndex - 1] ?? 0) + 1
          : Math.max(previous[columnIndex] ?? 0, current[columnIndex - 1] ?? 0);
    }
    previous = current;
  }
  return previous[columns.length] ?? 0;
};

const sharedValueCount = (reference: readonly string[], target: readonly string[]): number => {
  const referenceCounts = countValues(reference);
  const targetCounts = countValues(target);
  let sharedCount = 0;
  for (const [value, referenceCount] of referenceCounts) {
    sharedCount += Math.min(referenceCount, targetCounts.get(value) ?? 0);
  }
  return sharedCount;
};

const cascadeIdentityFor = (rule: string): string => {
  const boundary = findCssBoundary(rule, 0);
  return boundary?.kind === '{' ? rule.slice(0, boundary.index) : rule;
};

const changedConflictingDuplicateIdentities = (
  referenceRules: readonly string[],
  targetRules: readonly string[],
): string[] => {
  const referenceCounts = countValues(referenceRules);
  const targetCounts = countValues(targetRules);
  const distinctRulesByIdentity = new Map<string, Set<string>>();
  for (const rule of new Set([...referenceRules, ...targetRules])) {
    const identity = cascadeIdentityFor(rule);
    const distinctRules = distinctRulesByIdentity.get(identity) ?? new Set<string>();
    distinctRules.add(rule);
    distinctRulesByIdentity.set(identity, distinctRules);
  }
  const changedIdentities = new Set<string>();
  for (const [rule, referenceCount] of referenceCounts) {
    const targetCount = targetCounts.get(rule) ?? 0;
    const identity = cascadeIdentityFor(rule);
    if (targetCount > 0 && referenceCount !== targetCount && (distinctRulesByIdentity.get(identity)?.size ?? 0) > 1) {
      changedIdentities.add(identity);
    }
  }
  return [...changedIdentities].sort();
};

const compareCssRules = (
  referenceRules: readonly string[],
  targetRules: readonly string[],
): DesignArtifactDifference[] => {
  const differences = compareSets('css', referenceRules, targetRules);
  const sharedRuleCount = sharedValueCount(referenceRules, targetRules);
  const orderedSharedRuleCount = longestCommonSubsequenceLength(referenceRules, targetRules);
  if (orderedSharedRuleCount < sharedRuleCount) {
    differences.push({
      key: 'cascade-rule-order',
      kind: 'changed',
      reference: `${orderedSharedRuleCount}/${sharedRuleCount} shared rules retain order`,
      scope: 'css',
      target: 'cascade-significant rule order changed',
    });
  }
  for (const identity of changedConflictingDuplicateIdentities(referenceRules, targetRules)) {
    differences.push({
      key: `cascade-duplicate-placement:${identity}`,
      kind: 'changed',
      reference: 'shared duplicate count changed around conflicting declarations',
      scope: 'css',
      target: 'cascade-significant duplicate placement changed',
    });
  }
  return differences;
};

const compareTokens = (
  referenceTokens: Readonly<Record<string, unknown>>,
  targetTokens: Readonly<Record<string, unknown>>,
): DesignArtifactDifference[] => {
  const keys = new Set([...Object.keys(referenceTokens), ...Object.keys(targetTokens)]);
  const differences: DesignArtifactDifference[] = [];

  for (const key of [...keys].sort()) {
    const hasReference = Object.hasOwn(referenceTokens, key);
    const hasTarget = Object.hasOwn(targetTokens, key);
    if (!hasTarget) {
      differences.push({ key, kind: 'missing', reference: canonicalValue(referenceTokens[key]), scope: 'token' });
      continue;
    }
    if (!hasReference) {
      differences.push({ key, kind: 'unexpected', scope: 'token', target: canonicalValue(targetTokens[key]) });
      continue;
    }
    const reference = canonicalValue(referenceTokens[key]);
    const target = canonicalValue(targetTokens[key]);
    if (reference !== target) {
      differences.push({ key, kind: 'changed', reference, scope: 'token', target });
    }
  }

  return differences;
};

const layerOrderFor = (rules: readonly string[]): string[] => {
  for (const rule of rules) {
    const match = LAYER_STATEMENT_PATTERN.exec(rule);
    if (match?.[1]) {
      return match[1].split(',').map((layer) => layer.trim());
    }
  }
  return [];
};

const differenceIdentity = (difference: Pick<DesignArtifactDifference, 'key' | 'kind' | 'scope'>): string =>
  `${difference.scope}:${difference.kind}:${difference.key}`;

export const findDesignArtifactDifferences = (
  reference: DesignArtifactSnapshot,
  target: DesignArtifactSnapshot,
): DesignArtifactDifference[] => {
  const referenceRules = cssRulesFor(reference.css);
  const targetRules = cssRulesFor(target.css);
  const referenceLayers = layerOrderFor(referenceRules);
  const targetLayers = layerOrderFor(targetRules);
  const cssRulesWithoutLayerOrder = (rules: readonly string[]) =>
    rules.filter((rule) => !LAYER_STATEMENT_PATTERN.test(rule));
  const differences = [
    ...compareCssRules(cssRulesWithoutLayerOrder(referenceRules), cssRulesWithoutLayerOrder(targetRules)),
    ...compareSets('export', reference.exports, target.exports),
    ...compareTokens(reference.tokens, target.tokens),
  ];

  if (canonicalValue(referenceLayers) !== canonicalValue(targetLayers)) {
    differences.push({
      key: 'declared-layer-order',
      kind: 'changed',
      reference: referenceLayers.join(','),
      scope: 'layer',
      target: targetLayers.join(','),
    });
  }

  return differences.sort((left, right) => differenceIdentity(left).localeCompare(differenceIdentity(right)));
};

const validateApproval = (approval: ApprovedDesignDifference): void => {
  if (!approval.reason.trim()) {
    throw new Error(`Approved design difference ${differenceIdentity(approval)} requires a reason.`);
  }
  if (approval.scope !== 'css') {
    throw new Error(
      `Design difference ${differenceIdentity(approval)} cannot be classified: tokens, exports, and layer order are exact contracts.`,
    );
  }
  if (approval.kind === 'changed') {
    throw new Error(
      `Design difference ${differenceIdentity(approval)} cannot be classified: CSS cascade order is an exact contract.`,
    );
  }
};

export const compareDesignArtifacts = (
  reference: DesignArtifactSnapshot,
  target: DesignArtifactSnapshot,
  approvedDifferences: readonly ApprovedDesignDifference[] = [],
): DesignParityEvidence => {
  const differences = findDesignArtifactDifferences(reference, target);
  const approvals = new Map<string, ApprovedDesignDifference>();
  for (const approval of approvedDifferences) {
    validateApproval(approval);
    const identity = differenceIdentity(approval);
    if (approvals.has(identity)) {
      throw new Error(`Duplicate approved design difference: ${identity}.`);
    }
    approvals.set(identity, approval);
  }

  const differenceIdentities = new Set(differences.map(differenceIdentity));
  const unclassified = differences.filter((difference) => !approvals.has(differenceIdentity(difference)));
  const staleApprovals = [...approvals.keys()].filter((identity) => !differenceIdentities.has(identity));
  if (unclassified.length > 0 || staleApprovals.length > 0) {
    const details = [
      ...unclassified.map((difference) => `unclassified ${differenceIdentity(difference)}`),
      ...staleApprovals.map((identity) => `stale approval ${identity}`),
    ];
    throw new Error(`Design artifact parity failed:\n${details.join('\n')}`);
  }

  const targetRules = cssRulesFor(target.css);
  return {
    approvedDifferences,
    cssRuleCount: targetRules.filter((rule) => !LAYER_STATEMENT_PATTERN.test(rule)).length,
    exportCount: target.exports.length,
    layerOrder: layerOrderFor(targetRules),
    tokenCount: Object.keys(target.tokens).length,
  };
};
