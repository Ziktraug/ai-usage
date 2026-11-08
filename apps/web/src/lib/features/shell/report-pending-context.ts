import { getContext, setContext } from 'svelte';

const key = Symbol('visible-report-pending');
interface ReportPendingIndicator {
  observe: (pending: () => boolean) => () => void;
}

export const provideReportPendingIndicator = (indicator: ReportPendingIndicator): void => {
  setContext(key, indicator);
};
export const useOptionalReportPendingIndicator = (): ReportPendingIndicator | undefined => getContext(key);
