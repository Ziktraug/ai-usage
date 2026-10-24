/**
 * A request to skip SvelteKit's scroll handling for one navigation, made in `beforeNavigate` and
 * honoured in `onNavigate` with `disableScrollHandling()`.
 *
 * SvelteKit 3 skips `beforeNavigate` for a navigation that starts while another one is in flight,
 * but still runs `onNavigate` for it, and the superseded navigation never reaches `onNavigate`. A
 * bare flag would therefore carry one navigation's request into the next. The request is keyed to
 * the target URL it was made for and cleared by every `onNavigate` and by a cancelled or failed
 * navigation.
 */
export interface FrameworkScrollPreservation {
  /** A blocked, cancelled or failed navigation never reaches `onNavigate`. */
  readonly cancel: () => void;
  /** Whether the navigation to `targetHref` asked to keep the scroll position. Always clears. */
  readonly consume: (targetHref: string | undefined) => boolean;
  /** Records whether the navigation to `targetHref` asks to keep the scroll position. */
  readonly request: (targetHref: string | undefined, preserve: boolean) => void;
}

export const createFrameworkScrollPreservation = (): FrameworkScrollPreservation => {
  let requestedHref: string | undefined;
  return {
    cancel: () => {
      requestedHref = undefined;
    },
    consume: (targetHref) => {
      const preserve = targetHref !== undefined && targetHref === requestedHref;
      requestedHref = undefined;
      return preserve;
    },
    request: (targetHref, preserve) => {
      requestedHref = preserve ? targetHref : undefined;
    },
  };
};
