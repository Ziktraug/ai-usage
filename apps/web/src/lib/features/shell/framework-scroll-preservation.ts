/**
 * Whether SvelteKit's scroll handling is skipped for one navigation, decided in `onNavigate` and
 * honoured there with `disableScrollHandling()`. A navigation asks for it with a click on a link
 * marked `data-ai-usage-preserve-scroll` or with a shell goto passing `preserveScroll`.
 *
 * SvelteKit 3 skips `beforeNavigate` for a navigation that starts while another one is in flight,
 * but still runs `onNavigate` for it, and the superseded navigation never reaches `onNavigate`. So
 * the decision has two sources:
 *
 * - The request `beforeNavigate` records when it runs, because it consumes the shell goto intent.
 *   The request is keyed to the target URL it was made for and cleared by every `onNavigate` and by
 *   a cancelled or failed navigation, so it never carries into a navigation to another target.
 * - What the navigation itself carries in `onNavigate`, for the one whose `beforeNavigate` was
 *   skipped: the click of a link navigation, and the intent of a shell goto that is still pending
 *   because no `beforeNavigate` consumed it.
 */
export interface FrameworkScrollPreservation {
  /** A blocked, cancelled or failed navigation never reaches `onNavigate`. */
  readonly cancel: () => void;
  /** From `onNavigate`: whether `navigation` keeps the scroll position. Always clears the request. */
  readonly decide: (navigation: ScrollPreservationNavigation) => boolean;
  /** From `beforeNavigate`: records whether the navigation to `targetHref` keeps the scroll position. */
  readonly request: (targetHref: string | undefined, preserve: boolean) => void;
}

/** The part of SvelteKit's `onNavigate` argument the decision reads. */
export interface ScrollPreservationNavigation {
  /** The click of a `link` navigation. A redirect hop carries none. */
  readonly event?: { readonly target: EventTarget | null } | undefined;
  readonly to: { readonly url: { readonly href: string } } | null;
  readonly type: string;
}

export interface FrameworkScrollPreservationPort {
  /** Whether a click on `target` is a click on a link marked to keep the scroll position. */
  readonly linkAsks: (target: EventTarget | null) => boolean;
  /** Whether a shell goto to `href` that asks to keep the scroll position is pending; never consumes it. */
  readonly pendingGotoAsks: (href: string) => boolean;
}

export const createFrameworkScrollPreservation = (
  port: FrameworkScrollPreservationPort,
): FrameworkScrollPreservation => {
  let requestedHref: string | undefined;
  return {
    cancel: () => {
      requestedHref = undefined;
    },
    decide: (navigation) => {
      const targetHref = navigation.to?.url.href;
      const requested = targetHref !== undefined && targetHref === requestedHref;
      requestedHref = undefined;
      if (targetHref === undefined) {
        return false;
      }
      if (requested) {
        return true;
      }
      if (navigation.type === 'link') {
        return port.linkAsks(navigation.event?.target ?? null);
      }
      return navigation.type === 'goto' && port.pendingGotoAsks(targetHref);
    },
    request: (targetHref, preserve) => {
      requestedHref = preserve ? targetHref : undefined;
    },
  };
};
