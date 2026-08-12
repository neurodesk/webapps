#!/usr/bin/env node

// PROTOTYPE — interactively inspect streaming slabs calculated from NiiVue's
// rendered screen-slice geometry. It does not change rendering or export.

import readline from 'node:readline'
import { prototypeStreamingFovBoundsFromScreenSlices } from '../src/adaptive_streaming_fov_prototype.ts'

const shape = [16821, 7494, 2070]
const volumeMinMM = [0, 0, 0]
const volumeMaxMM = [...shape]
const focus = [0.5, 0.5, 0.5]
const pan = [0, 0, 0, 4]
const planes = ['axial', 'coronal', 'sagittal']
const axisOrders = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 2, 0],
]

function screenSlices() {
  const side = Math.max(...shape)
  return axisOrders.map((axes, axCorSag) => ({
    axCorSag,
    leftTopWidthHeight: [0, 0, 600, 600],
    screen: {
      mnMM: [
        (shape[axes[0]] - side) / 2,
        (shape[axes[1]] - side) / 2,
        0,
      ],
      mxMM: [
        (shape[axes[0]] + side) / 2,
        (shape[axes[1]] + side) / 2,
        shape[axes[2]],
      ],
    },
  }))
}

function frame() {
  const bounds = prototypeStreamingFovBoundsFromScreenSlices(
    shape,
    volumeMinMM,
    volumeMaxMM,
    focus,
    pan,
    screenSlices(),
  )
  const spans = bounds.map((slab, index) => ({
    plane: planes[index],
    min: slab.min.map((value) => Number(value.toFixed(1))),
    max: slab.max.map((value) => Number(value.toFixed(1))),
    voxels: slab.max.map((maximum, axis) =>
      Number((maximum - slab.min[axis]).toFixed(1)),
    ),
  }))
  console.clear()
  console.log('\x1b[1mScreen-slice streaming FOV prototype\x1b[0m')
  console.log('\x1b[2mDisplay zoom and NIfTI export remain unchanged.\x1b[0m\n')
  console.log(`\x1b[1mVolume shape\x1b[0m  ${shape.join(' × ')}`)
  console.log(`\x1b[1mCamera zoom\x1b[0m   ${pan[3]}x`)
  console.log(`\x1b[1mPan (mm)\x1b[0m       ${pan.slice(0, 3).join(' / ')}`)
  console.log(`\x1b[1mScreen slices\x1b[0m  ${bounds.length}`)
  console.log('\x1b[1mProtected slabs\x1b[0m')
  console.log(JSON.stringify(spans, null, 2))
  console.log('\n\x1b[1m[+]\x1b[0m zoom in  \x1b[1m[-]\x1b[0m zoom out')
  console.log('\x1b[1m[←/→]\x1b[0m pan X  \x1b[1m[↑/↓]\x1b[0m pan Y  \x1b[1m[q]\x1b[0m quit')
}

readline.emitKeypressEvents(process.stdin)
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.on('keypress', (_text, key) => {
  if (key.name === 'q' || (key.ctrl && key.name === 'c')) process.exit(0)
  if (key.name === '+' || key.name === '=') pan[3] = Math.min(128, pan[3] * 2)
  if (key.name === '-' || key.name === '_') pan[3] = Math.max(1, pan[3] / 2)
  if (key.name === 'left') pan[0] -= shape[0] * 0.05
  if (key.name === 'right') pan[0] += shape[0] * 0.05
  if (key.name === 'up') pan[1] -= shape[1] * 0.05
  if (key.name === 'down') pan[1] += shape[1] * 0.05
  frame()
})

frame()
