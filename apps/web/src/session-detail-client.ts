import {
  parseSessionDetailResponse,
  type SessionDetailRequest,
  type SessionDetailResponse,
  supportsSessionDetailHarness,
} from '@ai-usage/report-core/session-detail';
import type { DashboardRow } from './shared';

export interface SessionDetailSource {
  getDetail(request: SessionDetailRequest): Promise<unknown>;
}

const unavailable = (
  reason: Extract<SessionDetailResponse, { status: 'unavailable' }>['reason'],
  message: string,
): SessionDetailResponse => ({ message, reason, status: 'unavailable' });

export const sessionDetailRequestForRow = (row: DashboardRow): SessionDetailRequest | SessionDetailResponse => {
  const source = row.source;
  if (!(source?.machineId && source.sourceSessionId)) {
    return unavailable(
      'history-unavailable',
      'This report row does not include enough source metadata to find local history.',
    );
  }
  if (!supportsSessionDetailHarness(source.harnessKey)) {
    return unavailable('unsupported', 'Detailed chronology is not available for this harness yet.');
  }
  return {
    harnessKey: source.harnessKey,
    machineId: source.machineId,
    sourceSessionId: source.sourceSessionId,
  };
};

export const canAnalyzeSession = (row: DashboardRow): boolean => {
  const request = sessionDetailRequestForRow(row);
  return !('status' in request);
};

const servedSessionDetailSource: SessionDetailSource = {
  getDetail: async (request) => {
    const { getReportSessionDetail } = await import('./server/report-payload');
    return await getReportSessionDetail({ data: request });
  },
};

export const loadSessionDetail = async (
  row: DashboardRow,
  source: SessionDetailSource = servedSessionDetailSource,
): Promise<SessionDetailResponse> => {
  const request = sessionDetailRequestForRow(row);
  if ('status' in request) {
    return request;
  }
  return parseSessionDetailResponse(await source.getDetail(request));
};
