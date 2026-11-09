import { mount } from 'svelte';
import Fixture from './recoverable-region.fixture.svelte';

export interface RecoveryFixtureOptions {
  readonly holdRetry?: boolean;
  readonly initialFailure?: boolean;
}

export interface RecoveryFixtureControls {
  readonly breakRegion: () => void;
  readonly releaseRetry: () => void;
  readonly releaseRetryFailing: () => void;
}

// Imported only by the isolated browser test, never by a production route or entry point.
export const installFixture = (
  target: HTMLElement,
  initialFailure = true,
  options: RecoveryFixtureOptions = {},
): RecoveryFixtureControls => mount(Fixture, { target, props: { ...options, initialFailure } });
