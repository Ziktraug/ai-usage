import type { Updater } from '@tanstack/solid-table';

// Resolves a tanstack-table Updater<T> — which may be a value or a function
// over the current value — into the next value.
export const applyTableUpdate = <T>(updater: Updater<T>, current: T) =>
  typeof updater === 'function' ? (updater as (old: T) => T)(current) : updater;
