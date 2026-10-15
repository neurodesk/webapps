/**
 * Failure reporting for work started from synchronous event callbacks.
 *
 * A task that reports its own failure (the tensor fit, tracking) marks the error,
 * so the callback's rejection handler does not overwrite that message. Anything
 * else the task did not report reaches the status bar and technical log.
 */

export interface FailureSinks {
  /** The status bar; an error status is also written to the technical log. */
  setStatus(message: string, error: boolean, detail?: string): void
  /** The technical log alone. */
  log(message: string, level: 'info'): void
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createFailureReporter({ setStatus, log }: FailureSinks) {
  const reported = new WeakSet<object>()
  const markReported = (error: unknown) => {
    if (error instanceof Object) reported.add(error)
  }
  return {
    /** Show the failure of the current input's task in the status bar. */
    showFailure(error: unknown, message: string, detail?: string): void {
      setStatus(message, true, detail)
      markReported(error)
    },
    /** A run whose input was replaced: log it without replacing the newer input's status. */
    logSupersededFailure(error: unknown, action: string): void {
      log(`${action} for a replaced input stopped: ${errorMessage(error)}`, 'info')
      markReported(error)
    },
    /** Rejection handler for a task started from an event callback. */
    reportFailure(action: string): (error: unknown) => void {
      return (error) => {
        if (error instanceof Object && reported.has(error)) return
        setStatus(`${action} failed: ${errorMessage(error)}`, true)
      }
    },
  }
}
