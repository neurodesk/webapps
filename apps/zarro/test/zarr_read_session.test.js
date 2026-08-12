import assert from 'node:assert/strict'
import test from 'node:test'
import { ZarrReadSession } from '../src/zarr_read_session.ts'

test('renew aborts obsolete reads while keeping the new session usable', () => {
  const session = new ZarrReadSession()
  const obsolete = session.signal

  session.renew()

  assert.equal(obsolete.aborted, true)
  assert.equal(obsolete.reason.name, 'AbortError')
  assert.equal(session.signal.aborted, false)
  assert.notStrictEqual(session.signal, obsolete)
})

test('parent cancellation aborts the current renewed session', () => {
  const parent = new AbortController()
  const session = new ZarrReadSession(parent.signal)
  session.renew()
  const current = session.signal

  parent.abort(new DOMException('reload superseded', 'AbortError'))

  assert.equal(current.aborted, true)
  assert.equal(session.signal.aborted, true)
})
