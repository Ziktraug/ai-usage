export interface ProvenanceMarkerFact {
  description: string;
  label: string;
  severity: 'info' | 'warning';
}

export const provenanceTitle = (facts: readonly ProvenanceMarkerFact[]): string =>
  facts.map((fact) => `${fact.label}: ${fact.description}`).join('\n');

export const provenanceMarkerGlyph = (facts: readonly ProvenanceMarkerFact[]): '!' | 'i' =>
  facts.some((fact) => fact.severity === 'warning') ? '!' : 'i';
