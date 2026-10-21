import {
  projectSessionCampaignChildren,
  projectSessionLookup,
  projectSessionNeighbors,
  projectSessionPage,
} from '@ai-usage/report-core/session-query';
import { demoReportPayload } from '../../../report-data';
import type { SessionClientAdapter } from '../../rpc/session-client';

export const WORK_DEMO_REVISION = 'synthetic-work-v1';
export const WORK_DEMO_TIME = demoReportPayload.generatedAt;

/** Demo rows are the existing report's synthetic rows, so its detail links remain usable. */
export const createSyntheticWorkClient = (): SessionClientAdapter => ({
  page: (request) => {
    const data = projectSessionPage(demoReportPayload.rows, request);
    return Promise.resolve({ data, ok: true, requestFingerprint: data.requestFingerprint, revision: data.revision });
  },
  campaignChildren: (request) => {
    const data = projectSessionCampaignChildren(demoReportPayload.rows, request);
    return Promise.resolve({ data, ok: true, requestFingerprint: data.requestFingerprint, revision: data.revision });
  },
  lookup: (request) => {
    const data = projectSessionLookup(demoReportPayload.rows, request);
    return Promise.resolve({ data, ok: true, requestFingerprint: data.requestFingerprint, revision: data.revision });
  },
  neighbors: (request) => {
    const data = projectSessionNeighbors(demoReportPayload.rows, request);
    return Promise.resolve({ data, ok: true, requestFingerprint: data.requestFingerprint, revision: data.revision });
  },
  detail: () => Promise.resolve({ status: 'unavailable', reason: 'unsupported', message: 'Synthetic session.' }),
  vcs: () => Promise.reject(new Error('Synthetic Work does not resolve local VCS.')),
});
