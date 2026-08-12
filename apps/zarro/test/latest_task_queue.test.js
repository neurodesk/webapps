import assert from 'node:assert/strict'
import test from 'node:test'
import { LatestTaskQueue } from '../src/latest_task_queue.ts'

test('runs one task at a time and coalesces pending work to the latest request', async () => {
  let releaseFirst
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve
  })
  const order = []
  let active = 0
  let maximumActive = 0
  const queue = new LatestTaskQueue()
  const task = (name, gate = Promise.resolve()) => async () => {
    active++
    maximumActive = Math.max(maximumActive, active)
    order.push(`${name}:start`)
    await gate
    order.push(`${name}:end`)
    active--
    return name
  }

  const first = queue.run(task('first', firstGate))
  await Promise.resolve()
  const superseded = queue.run(task('superseded'))
  const latest = queue.run(task('latest'))

  assert.equal(await superseded, undefined)
  assert.deepEqual(order, ['first:start'])
  releaseFirst()

  assert.equal(await first, undefined)
  assert.equal(await latest, 'latest')
  assert.equal(maximumActive, 1)
  assert.deepEqual(order, [
    'first:start',
    'first:end',
    'latest:start',
    'latest:end',
  ])
})

test('aborts running work when a newer task supersedes it', async () => {
  const queue = new LatestTaskQueue()
  let started
  const running = new Promise((resolve) => {
    started = resolve
  })
  let obsoleteSignal

  const obsolete = queue.run(async (signal) => {
    obsoleteSignal = signal
    started()
    await new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), {
        once: true,
      })
    })
  })
  await running
  const latest = queue.run(async (signal) => {
    assert.equal(signal.aborted, false)
    return 'latest'
  })

  assert.equal(await obsolete, undefined)
  assert.equal(obsoleteSignal.aborted, true)
  assert.equal(await latest, 'latest')
})
