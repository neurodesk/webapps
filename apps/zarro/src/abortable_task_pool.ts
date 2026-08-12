interface QueuedTask {
  signal: AbortSignal
  task: () => Promise<unknown>
  resolve: (result: unknown) => void
  reject: (error: unknown) => void
  onAbort: () => void
}

/** A bounded async pool that drops queued work as soon as its signal aborts. */
export class AbortableTaskPool {
  private active = 0
  private readonly pending: QueuedTask[] = []
  private readonly concurrency: number

  constructor(concurrency: number) {
    this.concurrency = Math.max(1, Math.floor(concurrency))
  }

  run<Result>(
    signal: AbortSignal,
    task: () => Promise<Result>,
  ): Promise<Result> {
    if (signal.aborted) return Promise.reject(signal.reason)
    return new Promise<Result>((resolve, reject) => {
      const queued: QueuedTask = {
        signal,
        task,
        resolve: (result) => resolve(result as Result),
        reject,
        onAbort: () => {
          const index = this.pending.indexOf(queued)
          if (index < 0) return
          this.pending.splice(index, 1)
          reject(signal.reason)
        },
      }
      signal.addEventListener('abort', queued.onAbort, { once: true })
      this.pending.push(queued)
      this.pump()
    })
  }

  private pump(): void {
    while (this.active < this.concurrency) {
      const queued = this.pending.shift()
      if (!queued) return
      queued.signal.removeEventListener('abort', queued.onAbort)
      if (queued.signal.aborted) {
        queued.reject(queued.signal.reason)
        continue
      }
      this.active++
      Promise.resolve()
        .then(queued.task)
        .then(queued.resolve, queued.reject)
        .finally(() => {
          this.active--
          this.pump()
        })
    }
  }
}
