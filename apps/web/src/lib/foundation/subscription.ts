export type Disposer = () => void;
export type StateListener<State> = (state: State) => void;

export interface StateSubscription<State> {
  readonly getState: () => State;
  readonly subscribe: (listener: StateListener<State>) => Disposer;
}
