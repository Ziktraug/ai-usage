import { mount } from 'svelte';
import Fixture from './recoverable-region.fixture.svelte';

// Imported only by the isolated browser test, never by a production route or entry point.
export const installFixture = (target: HTMLElement, initialFailure = true): void => {
  mount(Fixture, { target, props: { initialFailure } });
};
