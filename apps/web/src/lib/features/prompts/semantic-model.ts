import { type ExplorationPrompt, promptIdentity, proseSegments } from './prompt-exploration';

export const SEMANTIC_MODEL = {
  id: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
  revision: '2c4055b12046f11709e9df2c122e59ffbdc2f900',
  dimensions: 384,
  threshold: 0.84,
  maxFormulations: 160,
  maxCharacters: 600,
  maxWords: 48,
} as const;

export interface Formulation {
  readonly entries: readonly ExplorationPrompt[];
  readonly id: string;
  readonly text: string;
}

export interface SemanticMember {
  readonly cosine: number;
  readonly formulation: Formulation;
  readonly lexical: number;
}

export interface SemanticFamily {
  readonly members: readonly SemanticMember[];
  readonly reference: Formulation;
}

export const semanticFormulations = (entries: readonly ExplorationPrompt[]) => {
  const candidates = new Map<string, ExplorationPrompt[]>();
  let clipped = 0;
  for (const entry of entries) {
    const segments = proseSegments(entry.text);
    for (const segment of segments) {
      const words = segment.split(' ');
      if (words.length > SEMANTIC_MODEL.maxWords || segment.length > SEMANTIC_MODEL.maxCharacters) {
        clipped += 1;
      }
      const text = words.slice(0, SEMANTIC_MODEL.maxWords).join(' ').slice(0, SEMANTIC_MODEL.maxCharacters);
      if (text.length < 3) {
        continue;
      }
      const existing = candidates.get(text) ?? [];
      if (!existing.some((candidate) => promptIdentity(candidate) === promptIdentity(entry))) {
        existing.push(entry);
      }
      candidates.set(text, existing);
    }
  }
  const ranked = [...candidates].sort(
    ([left, a], [right, b]) =>
      new Set(b.map((entry) => entry.rowId)).size - new Set(a.map((entry) => entry.rowId)).size ||
      left.localeCompare(right),
  );
  return {
    clipped,
    omitted: Math.max(0, ranked.length - SEMANTIC_MODEL.maxFormulations),
    formulations: ranked
      .slice(0, SEMANTIC_MODEL.maxFormulations)
      .map(([text, hits]) => ({ entries: hits, id: text, text })),
  };
};

const actionPatterns = [
  /\b(review|relire|relecture|audit)\b/u,
  /\b(fix|corrige|corriger|correction|repair)\b/u,
  /\b(avis|opinion|feedback|think)\b/u,
  /\b(commit|push|merge|livrer|livraison)\b/u,
  /\b(plan|planning|planifier)\b/u,
  /\b(test|tests|tester)\b/u,
  /\b(continue|continuer|poursuis)\b/u,
];
const negative = /\b(not|never|without|pas|jamais|sans)\b/u;

export const compatibleFormulations = (left: string, right: string): boolean => {
  if (negative.test(left) !== negative.test(right)) {
    return false;
  }
  const a = actionPatterns.map((pattern, index) => (pattern.test(left) ? index : -1)).filter((index) => index >= 0);
  const b = actionPatterns.map((pattern, index) => (pattern.test(right) ? index : -1)).filter((index) => index >= 0);
  if (a.length || b.length) {
    return a.some((index) => b.includes(index));
  }
  return left.split(' ').length <= 2 === right.split(' ').length <= 2;
};

export const cosineSimilarity = (left: readonly number[], right: readonly number[]): number => {
  if (
    !left.length ||
    left.length !== right.length ||
    left.some((value) => !Number.isFinite(value)) ||
    right.some((value) => !Number.isFinite(value))
  ) {
    throw new Error('Embedding dimensions or values are invalid');
  }
  let dot = 0,
    a = 0,
    b = 0;
  for (let index = 0; index < left.length; index += 1) {
    const x = left[index] ?? 0,
      y = right[index] ?? 0;
    dot += x * y;
    a += x * x;
    b += y * y;
  }
  if (!(a > 0 && b > 0)) {
    throw new Error('Embedding vector is empty');
  }
  return Math.max(-1, Math.min(1, dot / Math.sqrt(a * b)));
};

export const lexicalSimilarity = (left: string, right: string): number => {
  const trigrams = (text: string) =>
    new Set(Array.from({ length: Math.max(0, text.length - 2) }, (_, index) => text.slice(index, index + 3)));
  const a = trigrams(left),
    b = trigrams(right);
  const union = new Set([...a, ...b]);
  return union.size ? [...a].filter((part) => b.has(part)).length / union.size : Number(left === right);
};

/** Every member matches its reference directly; no transitive similarity chains. */
export const groupSemanticFamilies = (
  formulations: readonly Formulation[],
  vectors: readonly (readonly number[])[],
): SemanticFamily[] => {
  if (formulations.length !== vectors.length || formulations.length > SEMANTIC_MODEL.maxFormulations) {
    throw new Error('Embedding result does not match the requested corpus');
  }
  const groups: { reference: Formulation; vector: readonly number[]; members: SemanticMember[] }[] = [];
  formulations.forEach((formulation, index) => {
    const vector = vectors[index];
    if (!vector || vector.length !== SEMANTIC_MODEL.dimensions) {
      throw new Error('Embedding dimensions do not match the pinned model');
    }
    cosineSimilarity(vector, vector);
    let nearest: (typeof groups)[number] | undefined;
    let similarity: number = SEMANTIC_MODEL.threshold;
    for (const group of groups) {
      if (!compatibleFormulations(formulation.text, group.reference.text)) {
        continue;
      }
      const value = cosineSimilarity(vector, group.vector);
      if (value >= similarity) {
        nearest = group;
        similarity = value;
      }
    }
    if (nearest) {
      nearest.members.push({
        cosine: similarity,
        formulation,
        lexical: lexicalSimilarity(formulation.text, nearest.reference.text),
      });
    } else {
      groups.push({ members: [{ cosine: 1, formulation, lexical: 1 }], reference: formulation, vector });
    }
  });
  return groups
    .filter(
      (group) =>
        new Set(group.members.flatMap((member) => member.formulation.entries.map((entry) => entry.rowId))).size >= 2,
    )
    .map(({ members, reference }) => ({ members, reference }));
};

export type SemanticWorkerRequest =
  | { readonly kind: 'prepare' }
  | { readonly kind: 'analyze'; readonly texts: readonly string[] };
export type SemanticWorkerResponse =
  | { readonly kind: 'ready' }
  | { readonly kind: 'progress'; readonly done: number; readonly total: number }
  | { readonly kind: 'result'; readonly vectors: readonly (readonly number[])[] }
  | { readonly kind: 'error'; readonly message: string };
