# Keep bounded workers and isolate observability per execution

- **Status**: Accepted
- **Date**: 2026-07-21

## Context

The source-control queue currently uses `workerCount` long-lived workers. Each
worker takes one job, runs it to completion, then takes the next job. This keeps
queue depth, FIFO admission, shutdown, and the default single-worker ordering
simple and already covered by tests.

A wide event needs fresh state for each real unit of work. That state must not
survive into the next job, but this does not require the carrier worker fiber to
end. A boundary runner can allocate a fresh controller and `Ref`, reset the
current-hop `FiberRef` with `FiberRef.locally`, provide the resulting
`WideEventService` only to the job body, emit exactly once, and restore the
worker context afterward.

## Decision

Keep the existing bounded `Effect.forever(queue.take -> processJob)` workers.
The worker loop is infrastructure and is never a wide-event boundary.

For source and publication jobs, start a boundary only after the pure start
transition confirms that the job will actually run. Stale, superseded, or
otherwise skipped queue entries do not emit. The boundary includes the admitted
business operation, its completion transition, and its immediate scheduling or
publication follow-up.

Every boundary invocation owns fresh observability state even when two
invocations run sequentially on the same worker fiber. Concurrent workers share
only the process-scoped sink; event controllers, annotations, hop parents, and
completion state are never shared.

Runtime shutdown interrupts an active boundary and gives it an
`interrupted` outcome. A job that remained in the queue or was rejected by its
start transition never started and therefore emits nothing.

## Consequences

- `workerCount`, queue backpressure, queue depth, cadence, and publication
  ordering keep their current semantics.
- Tests must prove isolation across sequential jobs on one worker and parallel
  jobs on multiple workers, plus interruption emission and no emission for
  skipped jobs.
- The boundary runner, not every call site, owns correct `FiberRef` scoping.
- A later fork-per-job refactor requires its own operational reason and ADR. It
  must not be introduced merely to support logging.

## Rejected Alternative

Forking one fiber per dequeued job behind a semaphore was rejected for this
plan. If permit acquisition occurs in the child, the dispatcher can drain the
bounded queue into permit-waiting fibers and change observable backpressure. If
the permit is acquired before dequeue, the implementation becomes a second
worker-pool design without adding observability isolation. Neither tradeoff is
needed for wide events.
