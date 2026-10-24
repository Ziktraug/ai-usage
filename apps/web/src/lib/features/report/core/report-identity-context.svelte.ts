import { createContext } from 'svelte';

export interface ReportQueryIdentity {
  readonly requestFingerprint: string;
  readonly revision: string;
}

export interface ReportIdentityChannel {
  clear: (identity: ReportQueryIdentity) => void;
  publish: (identity: ReportQueryIdentity) => void;
}

const [useReportIdentityChannel, setReportIdentityChannel] = createContext<ReportIdentityChannel>();

export { useReportIdentityChannel };

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
): ReportIdentityChannel => setReportIdentityChannel(createReportIdentityChannel(onChange));
