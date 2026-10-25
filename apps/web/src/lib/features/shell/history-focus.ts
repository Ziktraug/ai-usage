/** SvelteKit's navigation types; only `popstate` is a history traversal. */
export type HistoryFocusNavigationType = 'enter' | 'form' | 'goto' | 'leave' | 'link' | 'popstate';

/**
 * Back and Forward reset focus the way SvelteKit 2 did.
 *
 * SvelteKit 2 reset focus after every history traversal: it blurred the focused element before the
 * new page rendered and, unless a component claimed focus meanwhile, moved the sequential focus
 * starting point to an `[autofocus]` element, the fragment target or the body. SvelteKit 3 does so
 * only when the entry it returns to was created with a different reset index, so Back across the
 * entries the app pushes with `reset: false` (campaign selection, Memory filters, kept-focus search
 * edits) left focus on a control of the page the reader just left. Keyboard and assistive
 * technology equivalence (ADR 0005, ADR 0013) needs the old behaviour. Repeating SvelteKit 3's own
 * reset after a traversal it did reset is harmless: the starting point is the same.
 */
export interface HistoryFocusReset {
  /** From `afterNavigate`. */
  readonly afterUpdate: (type: HistoryFocusNavigationType, url: URL) => void;
  /** From `onNavigate`, before the new page renders. */
  readonly beforeUpdate: (type: HistoryFocusNavigationType) => void;
}

export interface HistoryFocusPort {
  /** Blurs the focused element, if any element other than the body has focus. */
  readonly blur: () => void;
  /** The focused element, or `undefined` when the body or nothing has focus. */
  readonly focused: () => unknown;
  /** SvelteKit's focus reset: an `[autofocus]` element, else the fragment target or the body. */
  readonly resetFocus: (url: URL) => void;
}

export const createHistoryFocusReset = (port: HistoryFocusPort): HistoryFocusReset => {
  let traversal: { readonly focused: unknown } | undefined;
  return {
    afterUpdate: (type, url) => {
      const pending = traversal;
      traversal = undefined;
      if (type !== 'popstate' || pending === undefined) {
        return;
      }
      const focused = port.focused();
      if (focused !== undefined && focused !== pending.focused) {
        return;
      }
      port.resetFocus(url);
    },
    beforeUpdate: (type) => {
      if (type !== 'popstate') {
        traversal = undefined;
        return;
      }
      port.blur();
      traversal = { focused: port.focused() };
    },
  };
};

const isFocusable = (element: Element | null): element is HTMLElement | SVGElement =>
  element instanceof HTMLElement || element instanceof SVGElement;

/** Mirrors SvelteKit's `reset_focus` without its selection bookkeeping. */
const resetDocumentFocus = (url: URL): void => {
  const autofocus = document.querySelector('[autofocus]');
  if (isFocusable(autofocus)) {
    autofocus.focus();
    return;
  }
  const fragment = url.hash.slice(1);
  const fragmentTarget = fragment === '' ? null : document.getElementById(decodeURIComponent(fragment));
  const target = isFocusable(fragmentTarget) ? fragmentTarget : document.body;
  const tabindex = target.getAttribute('tabindex');
  target.setAttribute('tabindex', '-1');
  target.focus({ focusVisible: false, preventScroll: true });
  // Removing the temporary tabindex leaves the starting point there without keeping focus.
  if (tabindex === null) {
    target.removeAttribute('tabindex');
  } else {
    target.setAttribute('tabindex', tabindex);
  }
};

export const documentHistoryFocusPort = (): HistoryFocusPort => ({
  blur: () => {
    const element = document.activeElement;
    if (isFocusable(element) && element !== document.body) {
      element.blur();
    }
  },
  focused: () => {
    const element = document.activeElement;
    return element === null || element === document.body ? undefined : element;
  },
  resetFocus: resetDocumentFocus,
});
