export interface ReportFilterShortcutInput {
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly defaultPrevented: boolean;
  readonly editableTarget: boolean;
  readonly isComposing: boolean;
  readonly key: string;
  readonly metaKey: boolean;
}

export const shouldFocusReportFilter = (input: ReportFilterShortcutInput): boolean =>
  input.key === '/' &&
  !input.altKey &&
  !input.ctrlKey &&
  !input.metaKey &&
  !input.defaultPrevented &&
  !input.isComposing &&
  !input.editableTarget;
