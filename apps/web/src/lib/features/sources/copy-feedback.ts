export const copyFeedbackDurationMs = 1500;

export interface CopyFeedbackScheduler {
  readonly cancel: (handle: number) => void;
  readonly schedule: (callback: () => void, delayMs: number) => number;
}

export type CopyFeedbackDisposalRegistrar = (dispose: () => void) => void;

export interface CopyFeedback {
  readonly clear: () => void;
  readonly dispose: () => void;
  readonly show: (revision: string) => void;
}

export const registerCopyFeedbackDisposal = (register: CopyFeedbackDisposalRegistrar, feedback: CopyFeedback): void =>
  register(feedback.dispose);

export const createCopyFeedback = (
  scheduler: CopyFeedbackScheduler,
  onChange: (revision: string | undefined) => void,
): CopyFeedback => {
  let timeoutHandle: number | undefined;

  const cancelPending = (): void => {
    if (timeoutHandle === undefined) {
      return;
    }
    scheduler.cancel(timeoutHandle);
    timeoutHandle = undefined;
  };

  const clear = (): void => {
    cancelPending();
    onChange(undefined);
  };

  const show = (revision: string): void => {
    cancelPending();
    onChange(revision);
    timeoutHandle = scheduler.schedule(() => {
      timeoutHandle = undefined;
      onChange(undefined);
    }, copyFeedbackDurationMs);
  };

  return { clear, dispose: clear, show };
};
