import assert from 'node:assert/strict';
import test from 'node:test';
import { idleGuidance } from '../src/guidance.js';
import { EXAMPLE_SETTINGS } from '../src/example.js';
import { STEPS } from '../src/steps.js';

const client = {};
const otherClient = {};
const tutorial = { movies: Array(24).fill('movie.tiff'), client };
const values = { import: structuredClone(EXAMPLE_SETTINGS.import) };

// Exhaust prerequisites independently: every combination has one bounded message,
// and readiness requires the checked server, matching movies and an open project.
test('tutorial readiness depends on all current prerequisites', () => {
  for (const connected of [false, true]) {
    for (const project of [null, { id: 'project' }]) {
      for (const projectLoading of [false, true]) {
        for (const checkedClient of [client, otherClient]) {
          for (const rootAvailable of [false, true]) {
            for (const step of STEPS) {
              for (const pattern of ['*.tiff', 'missing*.tiff']) {
                const current = structuredClone(values);
                current.import.inputs.movies.pattern = pattern;
                const message = idleGuidance({
                  connectionState: 'connected', client: connected ? client : null,
                  project, projectLoading, command: step.command,
                  tutorial: { ...tutorial, client: checkedClient }, values: current,
                  info: { dataRoots: rootAvailable ? [{ id: 'examples' }] : [] },
                });
                assert.ok(message.length <= 90, message);
                assert.equal(message.includes('Ready to import'), Boolean(connected && project && !projectLoading
                  && checkedClient === client && rootAvailable && step.command === 'import' && pattern === '*.tiff'));
              }
            }
          }
        }
      }
    }
  }
});

test('restoring the same selection restores the same guidance without event history', () => {
  const state = { connectionState: 'connected', client, project: { id: 'project' }, command: 'import',
    info: { dataRoots: [{ id: 'examples' }] }, tutorial, values: structuredClone(values) };
  const ready = idleGuidance(state);
  state.values.import.inputs.movies.pattern = 'missing*.tiff';
  assert.ok(!idleGuidance(state).includes('Ready to import'));
  state.values.import.inputs.movies.pattern = '*.tiff';
  assert.equal(idleGuidance(state), ready);
  state.command = 'motioncorr';
  assert.match(idleGuidance(state), /Motion correction/);
  state.command = 'import';
  assert.equal(idleGuidance(state), ready);
  state.client = otherClient;
  assert.match(idleGuidance(state), /check this server/);
});
