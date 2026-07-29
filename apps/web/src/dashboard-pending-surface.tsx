import { unavailablePanel, unavailableText } from '@ai-usage/design-system/report';

export const DashboardPendingSurface = () => (
  <section aria-live="polite" class={unavailablePanel} data-report-pending>
    <div class={unavailableText}>Loading report…</div>
  </section>
);
