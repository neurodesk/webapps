function abortError(message: string): DOMException {
  return new DOMException(message, 'AbortError')
}

/** Owns the cancellation signal for the currently relevant OME-Zarr read plan. */
export class ZarrReadSession {
  private controller = new AbortController()
  private currentSignal: AbortSignal
  private readonly parent: AbortSignal | undefined

  constructor(parent?: AbortSignal) {
    this.parent = parent
    this.currentSignal = this.combineSignals()
  }

  get signal(): AbortSignal {
    return this.currentSignal
  }

  renew(): void {
    this.controller.abort(abortError('OME-Zarr read plan superseded'))
    this.controller = new AbortController()
    this.currentSignal = this.combineSignals()
  }

  abort(message = 'OME-Zarr read session disposed'): void {
    this.controller.abort(abortError(message))
  }

  private combineSignals(): AbortSignal {
    return this.parent
      ? AbortSignal.any([this.parent, this.controller.signal])
      : this.controller.signal
  }
}
