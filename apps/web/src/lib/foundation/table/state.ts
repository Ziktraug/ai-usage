export interface TableSort {
  desc: boolean;
  id: string;
}

export type TableSortingState = TableSort[];
export type TableVisibilityState = Record<string, boolean>;
export type StateUpdater<Value> = Value | ((current: Value) => Value);
export type StateChangeHandler<Value> = (updater: StateUpdater<Value>) => void;

export const applyStateUpdate = <Value>(updater: StateUpdater<Value>, current: Value): Value =>
  typeof updater === 'function' ? (updater as (value: Value) => Value)(current) : updater;
