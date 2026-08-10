interface PendingTask<Result> {
  task: () => Promise<Result>
  resolve: (result: Result | undefined) => void
  reject: (error: unknown) => void
}

/** Serialize async mutations while discarding queued work superseded by a newer request. */
export class LatestTaskQueue {
  private running = false
  private pending: PendingTask<unknown> | null = null

  run<Result>(task: () => Promise<Result>): Promise<Result | undefined> {
    return new Promise<Result | undefined>((resolve, reject) => {
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
        try {
          current.resolve(await current.task())
        } catch (error) {
          current.reject(error)
        }
      }
    } finally {
      this.running = false
    }
  }
}
