import { css } from '@ai-usage/design-system/css';
import type { JSX } from 'solid-js';

export const tooltipContent = css({
  p: '8px 12px',
  borderRadius: 'sm',
  bg: 'ink',
  color: 'canvas',
  fontSize: '12px',
  lineHeight: 1.5,
  whiteSpace: 'pre',
  boxShadow: 'overlay',
  zIndex: 50,
  _open: {
    animation: 'fadeIn 0.12s ease-out',
  },
});

const provenanceCell = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '5px',
  minW: 0,
});

const provenanceMarker = css({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  w: '14px',
  h: '14px',
  flexShrink: 0,
  borderRadius: 'full',
  border: '1px solid token(colors.lineStrong)',
  color: 'muted',
  fontSize: '10px',
  fontWeight: 700,
  lineHeight: 1,
});

const provenanceMarkerWarning = css({
  color: 'accent',
  borderColor: 'accent',
});

export interface ProvenanceMarkerFact {
  description: string;
  label: string;
  severity: 'info' | 'warning';
}

const provenanceTitle = (facts: ProvenanceMarkerFact[]) =>
  facts.map((fact) => `${fact.label}: ${fact.description}`).join('\n');

export const ProvenanceMarker = (props: { facts: ProvenanceMarkerFact[] }) => {
  if (!props.facts.length) {
    return null;
  }
  const hasWarning = props.facts.some((fact) => fact.severity === 'warning');
  return (
    <span
      aria-label={provenanceTitle(props.facts)}
      class={hasWarning ? `${provenanceMarker} ${provenanceMarkerWarning}` : provenanceMarker}
      role="img"
      title={provenanceTitle(props.facts)}
    >
      !
    </span>
  );
};

export const CellWithProvenance = (props: { children: JSX.Element; facts: ProvenanceMarkerFact[] }) => {
  if (!props.facts.length) {
    return <>{props.children}</>;
  }
  return (
    <span class={provenanceCell}>
      <span>{props.children}</span>
      <ProvenanceMarker facts={props.facts} />
    </span>
  );
};
