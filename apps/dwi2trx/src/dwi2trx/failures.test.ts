/**
 * Failures from tasks started by event callbacks reach the status bar exactly once.
 * Run: node --experimental-strip-types src/dwi2trx/failures.test.ts
 */

import assert from 'node:assert/strict'
import { createFailureReporter } from './failures.ts'

function recorder() {
  const status: Array<[string, boolean, string | undefined]> = []
  const log: string[] = []
  const reporter = createFailureReporter({
    setStatus: (message, error, detail) => status.push([message, error, detail]),
    log: (message) => log.push(message),
  })
  return { status, log, ...reporter }
}

// A rejected task its callback started reaches the status bar as an error.
{
  const { status, log, reportFailure } = recorder()
  await Promise.reject(new Error('setModulationImage lost the device')).catch(reportFailure('Display mode'))
  assert.deepEqual(status, [['Display mode failed: setModulationImage lost the device', true, undefined]])
  assert.deepEqual(log, [])
}

// Non-Error rejections are reported too.
{
  const { status, reportFailure } = recorder()
  await Promise.reject('worker gone').catch(reportFailure('Loading'))
  assert.deepEqual(status, [['Loading failed: worker gone', true, undefined]])
}

// A failure the task already showed keeps its own message instead of a generic one.
{
  const { status, showFailure, reportFailure } = recorder()
  const error = new Error('memory access out of bounds')
  const task = async () => {
    showFailure(error, 'Too large for in-browser tensor fitting (WebAssembly memory limit).', 'Try a cropped acquisition.')
    throw error
  }
  await task().catch(reportFailure('Tensor fit'))
  assert.deepEqual(status, [['Too large for in-browser tensor fitting (WebAssembly memory limit).', true, 'Try a cropped acquisition.']])
}

// A run for a replaced input goes to the technical log, not over the newer input's status.
{
  const { status, log, logSupersededFailure, reportFailure } = recorder()
  const error = new DOMException('Input superseded', 'AbortError')
  const task = async () => {
    logSupersededFailure(error, 'Streamline tracking')
    throw error
  }
  await task().catch(reportFailure('Streamline tracking'))
  assert.deepEqual(status, [])
  assert.deepEqual(log, ['Streamline tracking for a replaced input stopped: Input superseded'])
}

// Marking one error does not hide a different failure.
{
  const { status, showFailure, reportFailure } = recorder()
  showFailure(new Error('first'), 'Tensor fit failed: first')
  await Promise.reject(new Error('second')).catch(reportFailure('Tensor fit'))
  assert.deepEqual(status.map(([message]) => message), ['Tensor fit failed: first', 'Tensor fit failed: second'])
}

console.log('failures.test: OK')
