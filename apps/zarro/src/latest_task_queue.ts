interface PendingTask<Result> {
  task: (signal: AbortSignal) => Promise<Result>
  resolve: (result: Result | undefined) => void
  reject: (error: unknown) => void
}

/** Serialize async mutations while discarding queued work superseded by a newer request. */
export class LatestTaskQueue {
  private running = false
  private pending: PendingTask<unknown> | null = null
  private currentController: AbortController | null = null

  run<Result>(
    task: (signal: AbortSignal) => Promise<Result>,
  ): Promise<Result | undefined> {
    return new Promise<Result | undefined>((resolve, reject) => {
      this.currentController?.abort(
        new DOMException('Task superseded by a newer request', 'AbortError'),
      )
      this.pending?.resolve(undefined)
      this.pending = {
        task,
        resolve: resolve as (result: unknown) => void,
        reject,
      }
      void this.drain()
    })
  }

  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (this.pending) {
        const current = this.pending
        this.pending = null
        const controller = new AbortController()
        this.currentController = controller
        try {
          const result = await current.task(controller.signal)
          current.resolve(controller.signal.aborted ? undefined : result)
        } catch (error) {
          if (controller.signal.aborted) current.resolve(undefined)
          else current.reject(error)
        }
      }
    } finally {
      this.running = false
    }
  }
}
