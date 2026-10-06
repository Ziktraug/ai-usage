import type { SourceControlClientState } from '../../../source-control-client';
import { presentSourceState, type SourcePresentationTone } from '../../../source-control-presentation-model';

export interface SourceControlSummaryStatus {
  readonly detail: string;
  /** `snapshot.generation`, or null before the engine has pushed its first snapshot. */
  readonly generation: number | null;
  readonly label: string;
  readonly phase: 'checking' | 'collecting' | 'preparing' | 'queued' | 'current' | 'unavailable' | 'failed';
  readonly tone: SourcePresentationTone;
  /** Labels of the enabled sources the warning count is counting. */
  readonly warningSources: readonly string[];
}

const WARNING_TONES: readonly SourcePresentationTone[] = ['danger', 'warning'];

/**
 * The header pill's whole derivation, as a total function of the engine's own source-control state.
 * The signature is the guarantee: no report, filter, route or query value can reach the label, so a
 * change in what it says is always a change in what the engine pushed — which is what the generation
 * stamped next to it lets a reader confirm.
 */
export const summarizeSourceControlStatus = (state: SourceControlClientState): SourceControlSummaryStatus => {
  const { connection, snapshot } = state;
  const enabledSources = snapshot?.sources.filter((source) => source.policy === 'enabled') ?? [];
  const warningSources = enabledSources
    .filter((source) => WARNING_TONES.includes(presentSourceState(source).tone))
    .map((source) => source.label);
  // 'stopped' is the state before the client has even been started — which is what the server render
  // and every frame before hydration see. Reporting that as "Unavailable" told the user sources were
  // broken when nothing had been attempted yet, so not-yet-known reads as its own neutral state.
  const awaitingFirstSnapshot = !snapshot && (connection === 'stopped' || connection === 'connecting');
  const generation = snapshot?.generation ?? null;
  const common = { generation, warningSources };

  if (awaitingFirstSnapshot) {
    return {
      ...common,
      label: 'Checking…',
      tone: 'info',
      phase: 'checking',
      detail: 'Checking collection status. Your saved data remains available.',
    };
  }
  if (!snapshot) {
    return {
      ...common,
      label: connection === 'protocol-mismatch' ? 'Incompatible' : 'Unavailable',
      tone: 'warning',
      phase: 'unavailable',
      detail: 'Collection status is unavailable. Your saved data remains available.',
    };
  }
  if (connection === 'protocol-mismatch') {
    return {
      ...common,
      label: 'Incompatible',
      tone: 'warning',
      phase: 'unavailable',
      detail: 'The collection status connection is incompatible. Open Sources for details.',
    };
  }
  if (connection === 'disconnected') {
    return {
      ...common,
      label: 'Reconnecting',
      tone: 'warning',
      phase: 'unavailable',
      detail: 'Reconnecting to collection status. Freshness cannot currently be confirmed.',
    };
  }
  if (snapshot.runningCount > 0) {
    const running = snapshot.sources.filter(({ lifecycle }) => lifecycle === 'running' || lifecycle === 'pausing');
    return {
      ...common,
      label: 'Updating…',
      tone: 'info',
      phase: 'collecting',
      detail: `Collecting ${running.map(({ label }) => label).join(', ') || 'local usage'}. You can keep exploring.`,
    };
  }
  if (snapshot.publication.running) {
    return {
      ...common,
      label: 'Preparing…',
      tone: 'info',
      phase: 'preparing',
      detail: 'Preparing the updated report. Your current data remains available.',
    };
  }
  if (snapshot.publication.lastOutcome === 'failed') {
    return {
      ...common,
      label: 'Update failed',
      tone: 'danger',
      phase: 'failed',
      detail: 'Report preparation failed. Your previous report is still available.',
    };
  }
  if (snapshot.publication.queued || snapshot.publication.pendingDemand || snapshot.queueDepth > 0) {
    return {
      ...common,
      label: 'Update queued',
      tone: 'info',
      phase: 'queued',
      detail: 'An update is queued. Collection runs automatically in the background.',
    };
  }
  if (warningSources.length > 0) {
    return {
      ...common,
      label: `${warningSources.length} warning${warningSources.length === 1 ? '' : 's'}`,
      tone: 'danger',
      phase: 'current',
      detail: 'Collection needs attention. The latest available data is ready to explore.',
    };
  }
  return {
    ...common,
    label: 'Sources ready',
    tone: 'ok',
    phase: 'current',
    detail: 'The report includes the latest collected data. Collection runs automatically.',
  };
};
