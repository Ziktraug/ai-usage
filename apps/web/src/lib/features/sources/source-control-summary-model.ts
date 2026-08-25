import type { SourceControlClientState } from '../../../source-control-client';
import { presentSourceState, type SourcePresentationTone } from '../../../source-control-presentation-model';

export interface SourceControlSummaryStatus {
  /** `snapshot.generation`, or null before the engine has pushed its first snapshot. */
  readonly generation: number | null;
  readonly label: string;
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

  if (awaitingFirstSnapshot) {
    return { generation, label: 'Checking sources…', tone: 'info', warningSources };
  }
  if (!snapshot) {
    return {
      generation,
      label: connection === 'protocol-mismatch' ? 'Incompatible' : 'Unavailable',
      tone: 'warning',
      warningSources,
    };
  }
  if (connection === 'protocol-mismatch') {
    return { generation, label: 'Incompatible', tone: 'warning', warningSources };
  }
  if (connection === 'disconnected') {
    return { generation, label: 'Reconnecting', tone: 'warning', warningSources };
  }
  if (warningSources.length > 0) {
    return {
      generation,
      label: `${warningSources.length} warning${warningSources.length === 1 ? '' : 's'}`,
      tone: 'danger',
      warningSources,
    };
  }
  if (snapshot.runningCount > 0) {
    return { generation, label: `${snapshot.runningCount} running`, tone: 'ok', warningSources };
  }
  return { generation, label: 'Sources ready', tone: 'ok', warningSources };
};
