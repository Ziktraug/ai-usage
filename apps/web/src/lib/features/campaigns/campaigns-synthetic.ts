import {
  projectSessionCampaignChildren,
  projectSessionNeighbors,
  projectSessionPage,
} from '@ai-usage/report-core/session-query';
import { campaignMapFixtureRows } from '../../../campaign-map-fixture';
import type { SessionClientAdapter } from '../../rpc/session-client';

export const createSyntheticCampaignClient = (): SessionClientAdapter => ({
  campaignChildren: (request) => {
    const data = projectSessionCampaignChildren(campaignMapFixtureRows, request);
    return Promise.resolve({ data, ok: true, requestFingerprint: data.requestFingerprint, revision: data.revision });
  },
  detail: () =>
    Promise.resolve({
      message: 'Session analysis is unavailable for synthetic campaigns.',
      reason: 'unsupported',
      status: 'unavailable',
    }),
  neighbors: (request) => {
    const data = projectSessionNeighbors(campaignMapFixtureRows, request);
    return Promise.resolve({ data, ok: true, requestFingerprint: data.requestFingerprint, revision: data.revision });
  },
  page: (request) => {
    const data = projectSessionPage(campaignMapFixtureRows, request);
    return Promise.resolve({ data, ok: true, requestFingerprint: data.requestFingerprint, revision: data.revision });
  },
  vcs: () => Promise.reject(new Error('VCS resolution is unavailable for synthetic campaigns.')),
});
