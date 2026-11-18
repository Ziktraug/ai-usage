export class ReportBootstrapUnavailableError extends Error {
  readonly status = 503;

  constructor() {
    super('Report data is temporarily unavailable.');
    this.name = 'ReportBootstrapUnavailableError';
  }
}

/**
 * Demo and e2e reports run on the Vite development server only (`tools/run-web-demo.ts`,
 * `playwright.config.ts`). A production build compiles the synthetic destination and its fixtures
 * out of the bundle, so a production server started in a synthetic mode refuses the report rather
 * than rendering a report it no longer contains.
 */
export class SyntheticReportUnavailableError extends Error {
  readonly status = 500;

  constructor(mode: 'demo' | 'e2e') {
    super(`The ${mode} report runs on the development server only; a production build serves the live report.`);
    this.name = 'SyntheticReportUnavailableError';
  }
}

/** A sanitized failure returned by a report read, as distinct from a local invariant defect. */
export class ReportReadUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportReadUnavailableError';
  }
}
