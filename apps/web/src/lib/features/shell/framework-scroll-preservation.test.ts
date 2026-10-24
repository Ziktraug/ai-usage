import { describe, expect, test } from 'bun:test';
import { createFrameworkScrollPreservation, type ScrollPreservationNavigation } from './framework-scroll-preservation';
import { createShellNavigationOwner } from './navigation-owner-context';

const SESSIONS = 'http://local/?tab=sessions';
const OVERVIEW = 'http://local/?tab=overview';

// Stand-ins for a click inside a link marked `data-ai-usage-preserve-scroll` and inside any other link.
const preservingLink = new EventTarget();
const plainLink = new EventTarget();

const navigationTo = (
  type: 'goto' | 'link' | 'popstate',
  href: string | null,
  clicked?: EventTarget,
): ScrollPreservationNavigation => ({
  ...(clicked === undefined ? {} : { event: { target: clicked } }),
  to: href === null ? null : { url: new URL(href) },
  type,
});

const pendingGoto = () => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve: () => resolve() };
};

/** The shell's own navigation owner, so a goto intent is read exactly where the shell keeps it. */
const preservationFixture = () => {
  const gotos: { readonly resolve: () => void }[] = [];
  const owner = createShellNavigationOwner({
    currentUrl: () => new URL(SESSIONS),
    goto: () => {
      const navigation = pendingGoto();
      gotos.push(navigation);
      return navigation.promise;
    },
  });
  const preservation = createFrameworkScrollPreservation({
    linkAsks: (target) => target === preservingLink,
    pendingGotoAsks: (href) => owner.peekIntent('goto', { href }).preserveScroll,
  });
  return {
    owner,
    preservation,
    settle: () => {
      for (const navigation of gotos) {
        navigation.resolve();
      }
    },
  };
};

describe('framework scroll preservation', () => {
  test('preserves scroll only for the navigation that asked for it, once', () => {
    const { preservation } = preservationFixture();

    preservation.request(SESSIONS, true);

    expect(preservation.decide(navigationTo('goto', SESSIONS))).toBe(true);
    expect(preservation.decide(navigationTo('goto', SESSIONS))).toBe(false);
  });

  test('does not leak into a navigation that superseded the one that asked', () => {
    const { preservation } = preservationFixture();

    // SvelteKit skips `beforeNavigate` for a navigation that starts while another is in flight, but
    // still runs `onNavigate` for it; the aborted one never reaches `onNavigate`.
    preservation.request(SESSIONS, true);

    expect(preservation.decide(navigationTo('goto', OVERVIEW))).toBe(false);
    expect(preservation.decide(navigationTo('goto', SESSIONS))).toBe(false);
  });

  test('does not leak into a superseding link or shell goto that does not ask', async () => {
    const { owner, preservation, settle } = preservationFixture();

    preservation.request(SESSIONS, true);
    expect(preservation.decide(navigationTo('link', OVERVIEW, plainLink))).toBe(false);

    preservation.request(SESSIONS, true);
    const superseding = owner.goto(OVERVIEW);
    expect(preservation.decide(navigationTo('goto', OVERVIEW))).toBe(false);
    settle();
    await superseding;
  });

  test('preserves scroll for a superseding link that asks, from its own click', () => {
    const { preservation } = preservationFixture();

    // The navigation it superseded did not ask; its `beforeNavigate` was the last one to run.
    preservation.request(SESSIONS, false);

    expect(preservation.decide(navigationTo('link', OVERVIEW, preservingLink))).toBe(true);
  });

  test('preserves scroll for a superseding shell goto that asks, from its still pending intent', async () => {
    const { owner, preservation, settle } = preservationFixture();
    preservation.request(SESSIONS, false);

    // No `beforeNavigate` runs for the superseding goto, so nothing consumes its intent.
    const superseding = owner.goto(OVERVIEW, { preserveScroll: true });

    expect(preservation.decide(navigationTo('goto', OVERVIEW))).toBe(true);
    settle();
    await superseding;
    expect(preservation.decide(navigationTo('goto', OVERVIEW))).toBe(false);
  });

  test('reads a pending goto intent only for a goto to its own target', async () => {
    const { owner, preservation, settle } = preservationFixture();
    const pending = owner.goto(OVERVIEW, { preserveScroll: true });

    expect(preservation.decide(navigationTo('goto', SESSIONS))).toBe(false);
    expect(preservation.decide(navigationTo('link', OVERVIEW, plainLink))).toBe(false);
    expect(preservation.decide(navigationTo('popstate', OVERVIEW))).toBe(false);
    settle();
    await pending;
  });

  test('a link navigation without its click, such as a redirect hop, does not ask', () => {
    const { preservation } = preservationFixture();

    expect(preservation.decide(navigationTo('link', OVERVIEW))).toBe(false);
  });

  test('forgets a request whose navigation was cancelled or failed', () => {
    const { preservation } = preservationFixture();

    preservation.request(SESSIONS, true);
    preservation.cancel();

    expect(preservation.decide(navigationTo('goto', SESSIONS))).toBe(false);
  });

  test('a navigation that does not ask replaces an earlier request', () => {
    const { preservation } = preservationFixture();

    preservation.request(SESSIONS, true);
    preservation.request(SESSIONS, false);

    expect(preservation.decide(navigationTo('goto', SESSIONS))).toBe(false);
  });

  test('a navigation without a target never preserves', () => {
    const { preservation } = preservationFixture();

    preservation.request(undefined, true);

    expect(preservation.decide(navigationTo('goto', null))).toBe(false);
    expect(preservation.decide(navigationTo('link', null, preservingLink))).toBe(false);
  });
});
