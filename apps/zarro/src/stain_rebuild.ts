import type { Shape3 } from './logical_volume'
import type { PrototypeFovBounds } from './adaptive_streaming_fov_prototype'

export interface RenewableReadSession {
  renew(): void
}

export interface RefocusableStainVolume {
  setMaxDetail(levelIndex: number): void
  setFocus(focus: Shape3, bounds?: PrototypeFovBounds[]): void
}

export interface StainRefocusRequest<
  Controller extends RefocusableStainVolume = RefocusableStainVolume,
> {
  readSession: RenewableReadSession
  controller: Controller
  targetLevel: number
  focus: Shape3
  bounds: PrototypeFovBounds[]
}

export type WaitForStainRefocus<
  Controller extends RefocusableStainVolume = RefocusableStainVolume,
> = (controller: Controller) => Promise<void>

/**
 * Cancel every obsolete read before scheduling any replacement plan. NiiVue
 * has one shared renderer upload pump, so settle each controller's debounced
 * plan swap before allowing the next controller to enter that pump.
 */
export async function refocusLoadedStainVolumes<
  Controller extends RefocusableStainVolume,
>(
  requests: readonly StainRefocusRequest<Controller>[],
  waitForRefocus: WaitForStainRefocus<Controller>,
): Promise<void> {
  for (const request of requests) request.readSession.renew()
  for (const request of requests) {
    request.controller.setMaxDetail(request.targetLevel)
    request.controller.setFocus(request.focus, request.bounds)
    await waitForRefocus(request.controller)
  }
}
