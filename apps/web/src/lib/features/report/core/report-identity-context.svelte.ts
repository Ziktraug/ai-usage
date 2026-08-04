import { getContext, setContext } from 'svelte';

export interface ReportQueryIdentity {
  readonly requestFingerprint: string;
  readonly revision: string;
}

export interface ReportIdentityChannel {
  clear(identity: ReportQueryIdentity): void;
  publish(identity: ReportQueryIdentity): void;
}

const reportIdentityKey = Symbol('ai-usage-report-query-identity');

const identityMatches = (left: ReportQueryIdentity, right: ReportQueryIdentity): boolean =>
  left.requestFingerprint === right.requestFingerprint && left.revision === right.revision;

export const createReportIdentityChannel = (
  onChange: (identity: ReportQueryIdentity | undefined) => void,
): ReportIdentityChannel => {
  let current: ReportQueryIdentity | undefined;
  return {
    clear: (identity) => {
      if (!(current && identityMatches(current, identity))) {
        return;
      }
      current = undefined;
      onChange(undefined);
    },
    publish: (identity) => {
      if (current && identityMatches(current, identity)) {
        return;
      }
      current = identity;
      onChange(identity);
    },
  };
};

export const provideReportIdentityChannel = (
  onChange: (identity: ReportQueryIdentity | undefined) => void,
): ReportIdentityChannel => {
  const channel = createReportIdentityChannel(onChange);
  setContext(reportIdentityKey, channel);
  return channel;
};

export const useReportIdentityChannel = (): ReportIdentityChannel => {
  const channel = getContext<ReportIdentityChannel | undefined>(reportIdentityKey);
  if (!channel) {
    throw new Error('Report query identity context is unavailable.');
  }
  return channel;
};
