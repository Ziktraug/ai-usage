import type { SessionDetailReportAnchor } from '@ai-usage/report-core/session-detail';

export type LocalSessionAuthorization =
  | { anchor: SessionDetailReportAnchor; status: 'authorized' }
  | { reason: 'machine-unavailable' | 'not-local' | 'provenance-unavailable'; status: 'unauthorized' };

export const authorizeLocalSessionAnchor = async (
  anchor: SessionDetailReportAnchor,
  readMachine: () => Promise<{ id: string }>,
): Promise<LocalSessionAuthorization> => {
  if (anchor.sourceAuthority !== 'local-observed') {
    return { reason: 'not-local', status: 'unauthorized' };
  }
  if (!anchor.machineId) {
    return { reason: 'provenance-unavailable', status: 'unauthorized' };
  }
  let machine: { id: string };
  try {
    machine = await readMachine();
  } catch {
    return { reason: 'machine-unavailable', status: 'unauthorized' };
  }
  if (machine.id !== anchor.machineId) {
    return { reason: 'not-local', status: 'unauthorized' };
  }
  return { anchor, status: 'authorized' };
};
