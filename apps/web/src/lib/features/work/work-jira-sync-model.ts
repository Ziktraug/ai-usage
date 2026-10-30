import type { SourceControlClientState } from '../../../source-control-client';

export const presentJiraSync = (state: SourceControlClientState) => {
  const source = state.snapshot?.sources.find((entry) => entry.id === 'jira.issues');
  const lastFinishedAt = source?.lastFinishedAt ?? null;
  if (state.connection !== 'live') {
    return {
      label: state.connection === 'connecting' ? 'Connecting to Jira sync…' : 'Jira sync disconnected',
      lastFinishedAt,
      checked: false,
    };
  }
  if (source?.availability !== 'detected') {
    return { label: 'Jira sync unavailable', lastFinishedAt, checked: false };
  }
  if (source.policy === 'disabled') {
    return { label: 'Jira sync paused', lastFinishedAt, checked: false };
  }
  const pending = source.warnings.find((warning) => warning.code === 'jira-sync-pending');
  if (source.lifecycle === 'running' || source.lifecycle === 'pausing') {
    return { label: 'Syncing Jira…', lastFinishedAt, checked: false };
  }
  if (
    source.warnings.some((warning) => warning.code !== 'jira-sync-pending') ||
    ['failed', 'timed-out', 'skipped'].includes(source.lastOutcome)
  ) {
    return {
      label: pending?.message ? `Jira sync incomplete — ${pending.message}` : 'Jira sync incomplete',
      lastFinishedAt,
      checked: false,
    };
  }
  if (pending) {
    return {
      label: `Catching up Jira — ${pending.message ?? 'tickets awaiting details'}`,
      lastFinishedAt,
      checked: false,
    };
  }
  if (source.lifecycle === 'queued') {
    return { label: 'Jira sync queued', lastFinishedAt, checked: false };
  }

  return {
    label: lastFinishedAt ? 'Jira checked' : 'Jira not checked yet',
    lastFinishedAt,
    checked: lastFinishedAt !== null,
  };
};
