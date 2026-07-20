import {
  parseSessionDetailRequest,
  parseSessionDetailResponse,
  type SessionDetailRequest,
  type SessionDetailResponse,
  SessionDetailValidationError,
} from '@ai-usage/report-core/session-detail';

export interface SessionDetailSource {
  getDetail(request: SessionDetailRequest): Promise<unknown>;
}

export interface SessionAnalysisAvailability {
  revision: string | null | undefined;
  rowId: string;
}

export const canAnalyzeSession = ({ revision, rowId }: SessionAnalysisAvailability): boolean =>
  typeof revision === 'string' && revision.length > 0 && rowId.length > 0;

const servedSessionDetailSource: SessionDetailSource = {
  getDetail: async (request) => {
    const { getReportSessionDetail } = await import('./server/report-payload');
    return await getReportSessionDetail({ data: request });
  },
};

export const loadSessionDetail = async (
  input: SessionDetailRequest,
  source: SessionDetailSource = servedSessionDetailSource,
): Promise<SessionDetailResponse> => {
  const request = parseSessionDetailRequest(input);
  const response = parseSessionDetailResponse(await source.getDetail(request));
  if (response.status === 'available' && response.revision !== request.revision) {
    throw new SessionDetailValidationError('Session detail response does not match its requested revision');
  }
  return response;
};
