import {
  parseSessionCampaignChildrenRequest,
  type SessionQueryRequest,
  SessionQueryValidationError,
} from '@ai-usage/report-core/session-query';

export type CampaignSelection =
  | { readonly status: 'automatic' | 'invalid' }
  | { readonly campaignKey: string; readonly status: 'selected' };

/** A malformed bookmark must not crash either SSR or client-side navigation. */
export const readCampaignSelection = (url: URL, query: SessionQueryRequest): CampaignSelection => {
  const campaignKey = url.searchParams.get('selectedCampaign');
  if (campaignKey === null) {
    return { status: 'automatic' };
  }
  try {
    return { campaignKey: parseSessionCampaignChildrenRequest({ campaignKey, query }).campaignKey, status: 'selected' };
  } catch (cause) {
    if (cause instanceof SessionQueryValidationError) {
      return { status: 'invalid' };
    }
    throw cause;
  }
};
