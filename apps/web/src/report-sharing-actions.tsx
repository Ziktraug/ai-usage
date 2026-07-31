import { css, cx } from '@ai-usage/design-system/css';
import { ghostButton } from '@ai-usage/design-system/report';
import { createSignal, Show } from 'solid-js';

const actions = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '8px',
  alignItems: 'center',
  minW: 0,
  ml: { base: '0', md: 'auto' },
  _print: { display: 'none' },
});

const noticeText = css({
  color: 'muted',
  fontSize: '12px',
});

const errorNoticeText = css({
  color: 'status.danger',
});

interface ReportSharingNotice {
  message: string;
  tone: 'error' | 'success';
}

export interface ReportSharingActionsProps {
  createExport: () => Promise<{ csv: string; filename: string }>;
}

export const ReportSharingActions = (props: ReportSharingActionsProps) => {
  const [notice, setNotice] = createSignal<ReportSharingNotice>();
  const copyCurrentLink = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setNotice({ message: 'Link copied', tone: 'success' });
    } catch {
      setNotice({ message: 'Could not copy link', tone: 'error' });
    }
  };
  const exportCurrentBreakdown = async (): Promise<void> => {
    try {
      const exportFile = await props.createExport();
      const { downloadReportCsv } = await import('./report-export');
      downloadReportCsv(exportFile.filename, exportFile.csv);
      setNotice({ message: 'CSV download started', tone: 'success' });
    } catch {
      setNotice({ message: 'Could not export CSV', tone: 'error' });
    }
  };

  return (
    <div class={actions}>
      <button class={ghostButton} onClick={copyCurrentLink} type="button">
        Copy link
      </button>
      <button class={ghostButton} onClick={exportCurrentBreakdown} type="button">
        Export CSV
      </button>
      <Show when={notice()}>
        {(currentNotice) => (
          <span
            aria-live="polite"
            class={cx(noticeText, currentNotice().tone === 'error' ? errorNoticeText : undefined)}
            role={currentNotice().tone === 'error' ? 'alert' : 'status'}
          >
            {currentNotice().message}
          </span>
        )}
      </Show>
    </div>
  );
};
