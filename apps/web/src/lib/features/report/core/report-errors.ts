export class ReportBootstrapUnavailableError extends Error {
  readonly status = 503;

  constructor() {
    super('Report data is temporarily unavailable.');
    this.name = 'ReportBootstrapUnavailableError';
  }
}

/** A sanitized failure returned by a report read, as distinct from a local invariant defect. */
export class ReportReadUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportReadUnavailableError';
  }
}
