import assert from 'node:assert/strict'
import test from 'node:test'
import { AbortableTaskPool } from '../src/abortable_task_pool.ts'

test('runs at the configured concurrency and cancels obsolete queued work', async () => {
  const pool = new AbortableTaskPool(2)
  const controller = new AbortController()
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  let active = 0
  let maximumActive = 0
  const started = []
  const run = (name) =>
    pool.run(controller.signal, async () => {
      started.push(name)
      active++
      maximumActive = Math.max(maximumActive, active)
      await gate
      active--
      return name
    })

  const first = run('first')
  const second = run('second')
  const obsolete = run('obsolete')
  await Promise.resolve()
  controller.abort(new DOMException('superseded', 'AbortError'))

  await assert.rejects(obsolete, { name: 'AbortError' })
  assert.deepEqual(started, ['first', 'second'])
  assert.equal(maximumActive, 2)
  release()
  assert.equal(await first, 'first')
  assert.equal(await second, 'second')
})
