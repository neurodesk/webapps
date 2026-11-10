/** Physical GPU commands stay small; logical seed batches and RNG IDs stay unchanged. */
export const MAX_WORKGROUPS_PER_DISPATCH = 16

/** Tracking steps per seed row in one generation command (#598): Intel/Mesa resets
 *  a workgroup that does not yield to preemption within 640 ms. */
export const MAX_STEPS_PER_DISPATCH = 32

/** BootTrackingParams' workgroup_offset; the preceding fields keep their ABI offsets. */
export const WORKGROUP_OFFSET_BYTES = 92

export async function dispatchBootWindows(
  device: GPUDevice,
  pipeline: GPUComputePipeline,
  gridX: number,
  groups: GPUBindGroup[],
  parameters: GPUBuffer,
  shouldStop?: () => boolean,
  maxWorkgroups = MAX_WORKGROUPS_PER_DISPATCH,
  include: (first: number) => boolean = () => true,
): Promise<boolean> {
  if (!Number.isSafeInteger(gridX) || gridX < 0
      || !Number.isSafeInteger(maxWorkgroups) || maxWorkgroups < 1) {
    throw new Error('Dispatch workgroup counts must be nonnegative and the window positive.')
  }
  for (let first = 0; first < gridX; first += maxWorkgroups) {
    if (!include(first)) continue
    if (shouldStop?.()) return false
    device.queue.writeBuffer(parameters, WORKGROUP_OFFSET_BYTES, new Uint32Array([first]))
    const encoder = device.createCommandEncoder()
    const pass = encoder.beginComputePass()
    pass.setPipeline(pipeline)
    groups.forEach((group, index) => pass.setBindGroup(index, group))
    pass.dispatchWorkgroups(Math.min(maxWorkgroups, gridX - first), 1, 1)
    pass.end()
    device.queue.submit([encoder.finish()])
    // Completing each command bounds watchdog exposure and provides a cancellation boundary.
    await device.queue.onSubmittedWorkDone()
    // Also allow UI/abort tasks when completion promises are already resolved.
    await new Promise<void>(resolve => setTimeout(resolve, 0))
  }
  return !shouldStop?.()
}
