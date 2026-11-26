import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  macNotarizeConfig,
  retryTransient,
  stapleApp,
  transientNotaryWaitError,
  transientStapleError,
  transientSubmissionId,
  waitForNotarization,
} from '../../../scripts/desktop/mac-notarize.mjs';

const directory = resolve(import.meta.dirname, '..');
const require = createRequire(resolve(directory, 'package.json'));
const builderRequire = createRequire(require.resolve('electron-builder'));
const { getConfig } = builderRequire('app-builder-lib/out/util/config/config.js');

const stapleOutput = (urlError) => `Failed to staple your application with code: 68

Processing: /Users/runner/work/webapps/webapps/packages/desktop/release/mac-arm64/neurodesk-webapps.app
Domain is api.apple-cloudkit.com
error is Error Domain=NSURLErrorDomain Code=${urlError}
CloudKit's response is inconsistent with expections: (null)
The staple and validate action failed! Error 68.`;
const connectionLost = new Error(stapleOutput('-1005 "The network connection was lost."'));
const tlsTrust = new Error(stapleOutput('-1202 "The certificate for this server is invalid."'));
const ticketNotFound = new Error('Failed to staple your application with code: 65\n\nThe staple and validate action failed! Error 65.');
const notaryLost = new Error('Failed to complete notarization: Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."');
const SUBMISSION_ID = '685b19e7-f973-4ce7-b231-70c875ab0fbd';
const notaryPollOutput = (urlError, id = SUBMISSION_ID) => `Failed to notarize via notarytool.  Failed with unexpected result: 

Error: HTTPError(statusCode: nil, error: Error Domain=NSURLErrorDomain Code=${urlError} UserInfo={NSErrorFailingURLStringKey=https://appstoreconnect.apple.com/notary/v2/submissions/${id}?})`;
const pollOffline = new Error(notaryPollOutput('-1009 "The Internet connection appears to be offline."'));
const pollHttp503 = new Error('Failed to notarize via notarytool.  Failed with unexpected result: \n\nError: HTTP status code: 503. Service Unavailable');
const pollTlsTrust = new Error(notaryPollOutput('-1202 "The certificate for this server is invalid."'));
const pollAgreement = new Error('Failed to notarize via notarytool.  Failed with unexpected result: \n\nError: HTTP status code: 403. A required agreement is missing or has expired.');
const pollInvalid = new Error(`Failed to notarize via notarytool\n\n{"status":"Invalid","id":"${SUBMISSION_ID}","message":"Processing complete"}`);
const credentials = { APPLE_ID: 'id', APPLE_APP_SPECIFIC_PASSWORD: 'secret', APPLE_TEAM_ID: 'team' };
const packager = { appInfo: { productFilename: 'neurodesk-webapps' } };
const appPath = '/release/mac-arm64/neurodesk-webapps.app';

test('only a staple failure on a retryable transport error, or stapler code 68 alone, is transient', () => {
  assert.equal(transientStapleError(connectionLost), true);
  assert.equal(transientStapleError(new Error(stapleOutput('-1001 "The request timed out."'))), true);
  assert.equal(transientStapleError(new Error(stapleOutput('-1009 "The Internet connection appears to be offline."'))), true);
  assert.equal(transientStapleError(new Error(stapleOutput('-1004 "Could not connect to the server."'))), true);
  assert.equal(transientStapleError(new Error('Failed to staple your application with code: 68\n\nCloudKit query for ticket failed.')), true);
  assert.equal(transientStapleError(tlsTrust), false);
  assert.equal(transientStapleError(ticketNotFound), false);
  assert.equal(transientStapleError(notaryLost), false);
  assert.equal(transientStapleError(new Error('Invalid signature')), false);
});

test('a transient staple failure is retried with backoff, then succeeds', async () => {
  const outcomes = [connectionLost, connectionLost, 'stapled'];
  const log = [];
  const waits = [];
  const result = await retryTransient(() => {
    const outcome = outcomes.shift();
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }, { attempts: 4, delay: 1000, sleep: async ms => { waits.push(ms); }, log: line => log.push(line) });
  assert.equal(result, 'stapled');
  assert.deepEqual(waits, [1000, 2000]);
  assert.equal(log.length, 2);
  assert.match(log[0], /attempt 1 of 4.*retry in 1 s/s);
  assert.match(log[0], /network connection was lost/);
  assert.match(log[1], /attempt 2 of 4.*retry in 2 s/s);
});

test('a permanent TLS error is thrown at once, without a retry', async () => {
  let calls = 0;
  const waits = [];
  await assert.rejects(retryTransient(() => { calls += 1; throw tlsTrust; }, { attempts: 4, delay: 1000, sleep: async ms => { waits.push(ms); } }), tlsTrust);
  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
});

test('a transient failure on the last attempt is thrown', async () => {
  let calls = 0;
  const waits = [];
  await assert.rejects(retryTransient(() => { calls += 1; throw connectionLost; }, { attempts: 3, delay: 500, sleep: async ms => { waits.push(ms); }, log: () => {} }), connectionLost);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [500, 1000]);
});

test('the hook replaces electron-builder notarization only on macOS with Apple credentials', async (t) => {
  t.mock.method(builderRequire('builder-util').log, 'info', console.error);
  assert.deepEqual(macNotarizeConfig('darwin', {}), {});
  assert.deepEqual(macNotarizeConfig('win32', credentials), {});
  const config = macNotarizeConfig('darwin', credentials);
  assert.equal(config.mac.notarize, false);
  assert.equal(typeof config.afterSign, 'function');
  const merged = await getConfig(directory, null, config);
  assert.equal(merged.mac.notarize, false);
  assert.deepEqual(merged.mac.target, [{ target: 'zip', arch: ['arm64'] }]);
  await assert.rejects(config.afterSign({ appOutDir: '/release', electronPlatformName: 'win32', packager }), /Expected macOS packaging/);
});

function hook(outcomes) {
  const calls = [];
  const waits = [];
  const logs = [];
  const { afterSign } = macNotarizeConfig('darwin', credentials, {
    notarize: async options => {
      calls.push(['notarize', options]);
      const outcome = outcomes.notarize.shift();
      if (outcome) throw outcome;
    },
    waitNotary: async (id, creds) => {
      calls.push(['waitNotary', id, creds]);
      const outcome = (outcomes.waitNotary ?? []).shift();
      if (outcome) throw outcome;
    },
    staple: async path => {
      calls.push(['staple', path]);
      const outcome = outcomes.staple.shift();
      if (outcome) throw outcome;
    },
    sleep: async ms => { waits.push(ms); },
    log: line => { logs.push(line); },
  });
  return { calls, waits, logs, run: () => afterSign({ appOutDir: '/release/mac-arm64', electronPlatformName: 'darwin', packager }) };
}

test('the hook notarizes once, then retries only stapling after a transient staple failure', async () => {
  const { calls, waits, run } = hook({ notarize: [connectionLost], staple: [connectionLost, null] });
  await run();
  assert.deepEqual(calls, [
    ['notarize', { tool: 'notarytool', appPath, appleId: 'id', appleIdPassword: 'secret', teamId: 'team' }],
    ['staple', appPath],
    ['staple', appPath],
  ]);
  assert.deepEqual(waits, [15000, 30000]);
});

test('a permanent TLS error while stapling fails the hook at once', async () => {
  const { calls, waits, run } = hook({ notarize: [tlsTrust], staple: [] });
  await assert.rejects(run(), tlsTrust);
  assert.equal(calls.length, 1);
  assert.deepEqual(waits, []);
});

test('a notarization failure is not retried', async () => {
  const invalid = new Error('Failure: Notarization failed. The signature of the binary is invalid.');
  const { calls, waits, run } = hook({ notarize: [invalid], staple: [] });
  await assert.rejects(run(), invalid);
  assert.deepEqual(calls.map(([name]) => name), ['notarize']);
  assert.deepEqual(waits, []);
});

test('a lost connection after submission does not submit the app again', async () => {
  const { calls, waits, run } = hook({ notarize: [notaryLost], staple: [] });
  await assert.rejects(run(), notaryLost);
  assert.deepEqual(calls.map(([name]) => name), ['notarize']);
  assert.deepEqual(waits, []);
});

test('the production hook uses the public notarize of the @electron/notarize electron-builder pins', () => {
  const appBuilder = createRequire(builderRequire.resolve('app-builder-lib'));
  assert.equal(typeof appBuilder('@electron/notarize').notarize, 'function');
  assert.equal(appBuilder('@electron/notarize').stapleApp, undefined);
});

test('stapleApp reports a missing xcrun as its own error, not a staple failure', { skip: process.platform === 'darwin' }, async (t) => {
  const release = await mkdtemp(join(tmpdir(), 'release-'));
  t.after(() => rm(release, { recursive: true, force: true }));
  await assert.rejects(stapleApp(join(release, 'neurodesk-webapps.app')), error => error.code === 'ENOENT' && error.path === 'xcrun' && !transientStapleError(error));
});

test('stapleApp turns a stapler exit code and its output into the error the predicate reads', { skip: process.platform === 'win32' }, async (t) => {
  const release = await mkdtemp(join(tmpdir(), 'release-'));
  t.after(() => rm(release, { recursive: true, force: true }));
  await writeFile(join(release, 'xcrun'), `#!/bin/sh\necho "$*"\necho 'error is Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."'\nexit 68\n`, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${release}:${path}`;
  t.after(() => { process.env.PATH = path; });
  await assert.rejects(stapleApp(join(release, 'neurodesk-webapps.app')), error => {
    assert.match(error.message, /^Failed to staple your application with code: 68\n\nstapler staple -v neurodesk-webapps.app\n/);
    return transientStapleError(error);
  });
});

test('transientNotaryWaitError and transientSubmissionId match only transient notarytool transport or 5xx errors', () => {
  assert.equal(transientNotaryWaitError(pollOffline), true);
  assert.equal(transientSubmissionId(pollOffline), SUBMISSION_ID);
  assert.equal(transientNotaryWaitError(new Error(notaryPollOutput('-1005 "The network connection was lost."'))), true);
  assert.equal(transientNotaryWaitError(new Error(notaryPollOutput('-1003 "A server with the specified hostname could not be found."'))), true);
  assert.equal(transientNotaryWaitError(pollHttp503), true);
  assert.equal(transientSubmissionId(pollHttp503), null);
  assert.equal(transientNotaryWaitError(pollTlsTrust), false);
  assert.equal(transientSubmissionId(pollTlsTrust), null);
  assert.equal(transientNotaryWaitError(pollAgreement), false);
  assert.equal(transientNotaryWaitError(pollInvalid), false);
  assert.equal(transientNotaryWaitError(notaryLost), false);
  assert.equal(transientSubmissionId(notaryLost), null);
});

test('a transient polling drop with a submission id resumes waiting on that submission and then staples', async () => {
  const { calls, waits, logs, run } = hook({
    notarize: [pollOffline],
    waitNotary: [pollHttp503, null],
    staple: [connectionLost, null],
  });
  await run();
  const expectedCreds = { appleId: 'id', appleIdPassword: 'secret', teamId: 'team' };
  assert.deepEqual(calls, [
    ['notarize', { tool: 'notarytool', appPath, ...expectedCreds }],
    ['waitNotary', SUBMISSION_ID, expectedCreds],
    ['waitNotary', SUBMISSION_ID, expectedCreds],
    ['staple', appPath],
    ['staple', appPath],
  ]);
  assert.deepEqual(waits, [30000, 60000, 15000]);
  assert.match(logs[0], new RegExp(`waiting for notarization ${SUBMISSION_ID} on attempt 1 of 5`));
});

test('exhausting all wait retries throws the last transient error without stapling', async () => {
  const finalError = new Error(notaryPollOutput('-1001 "The request timed out."'));
  const { calls, waits, run } = hook({
    notarize: [pollOffline],
    waitNotary: [pollHttp503, pollOffline, pollHttp503, finalError],
    staple: [],
  });
  await assert.rejects(run(), finalError);
  assert.deepEqual(calls.map(([name]) => name), ['notarize', 'waitNotary', 'waitNotary', 'waitNotary', 'waitNotary']);
  assert.deepEqual(waits, [30000, 60000, 120000, 240000]);
});

test('a rejected or refused resumed wait fails at once without stapling', async () => {
  for (const permanent of [pollInvalid, pollAgreement, pollTlsTrust]) {
    const { calls, waits, run } = hook({ notarize: [pollOffline], waitNotary: [permanent], staple: [] });
    await assert.rejects(run(), permanent);
    assert.deepEqual(calls.map(([name]) => name), ['notarize', 'waitNotary']);
    assert.deepEqual(waits, [30000]);
  }
});

test('waitForNotarization runs xcrun notarytool wait, reports diagnostics on rejection, redacts credentials, and preserves stderr/signal errors', { skip: process.platform === 'win32' }, async (t) => {
  const release = await mkdtemp(join(tmpdir(), 'notary-wait-'));
  t.after(() => rm(release, { recursive: true, force: true }));
  const creds = { appleId: 'user@example.com', appleIdPassword: 'super-secret-password', teamId: 'TEAM123' };
  const assertNoCreds = error => {
    const serialized = `${error.message}\n${JSON.stringify(error)}`;
    for (const secret of Object.values(creds)) assert.ok(!serialized.includes(secret), `leaked ${secret}`);
  };
  const path = process.env.PATH;
  t.after(() => { process.env.PATH = path; });

  await writeFile(join(release, 'xcrun'), `#!/bin/sh
if [ "$1" = "notarytool" ] && [ "$2" = "wait" ]; then
  echo '{"status":"Accepted","id":"${SUBMISSION_ID}","message":"Processing complete"}'
  exit 0
fi
exit 1
`, { mode: 0o755 });
  process.env.PATH = `${release}:${path}`;
  const accepted = await waitForNotarization(SUBMISSION_ID, creds);
  assert.equal(accepted.status, 'Accepted');
  assert.equal(accepted.id, SUBMISSION_ID);

  // Explicit rejection with diagnostics, echoing credentials on both streams to verify redaction.
  await writeFile(join(release, 'xcrun'), `#!/bin/sh
if [ "$2" = "wait" ]; then
  echo '{"status":"Invalid","id":"${SUBMISSION_ID}","message":"failed for user@example.com TEAM123"}'
  echo "stderr echo super-secret-password user@example.com TEAM123" >&2
  exit 0
fi
if [ "$2" = "log" ]; then
  echo '{"status":"Invalid","issues":[{"message":"The binary is not signed (super-secret-password)."}]}'
  exit 0
fi
exit 1
`, { mode: 0o755 });
  await assert.rejects(waitForNotarization(SUBMISSION_ID, creds), error => {
    assert.match(error.message, /^Failed to notarize via notarytool\n\n\{"status":"Invalid"/);
    assert.match(error.message, /Diagnostics from notarytool log:.*"The binary is not signed \(\*\*\*\)\."/);
    assertNoCreds(error);
    assert.equal(transientNotaryWaitError(error), false);
    return true;
  });

  // Explicit rejection when fetching diagnostics log fails still throws cleanly without diagnostics.
  await writeFile(join(release, 'xcrun'), `#!/bin/sh
if [ "$2" = "wait" ]; then
  echo '{"status":"Invalid","id":"${SUBMISSION_ID}","message":"Processing complete"}'
  exit 0
fi
exit 1
`, { mode: 0o755 });
  await assert.rejects(waitForNotarization(SUBMISSION_ID, creds), error => {
    assert.match(error.message, /^Failed to notarize via notarytool\n\n\{"status":"Invalid"/);
    assert.doesNotMatch(error.message, /Diagnostics from notarytool log:/);
    assert.equal(transientNotaryWaitError(error), false);
    return true;
  });

  // Nonzero exit with Accepted JSON on stdout is still rejected.
  await writeFile(join(release, 'xcrun'), `#!/bin/sh
if [ "$2" = "wait" ]; then
  echo '{"status":"Accepted","id":"${SUBMISSION_ID}","message":"Processing complete"}'
  exit 1
fi
exit 1
`, { mode: 0o755 });
  await assert.rejects(waitForNotarization(SUBMISSION_ID, creds), error => {
    assert.match(error.message, /^Failed to notarize via notarytool\n\n\{"status":"Accepted"/);
    assert.equal(transientNotaryWaitError(error), false);
    return true;
  });

  // Nonzero exit with parseable non-rejection JSON on stdout and retryable error on stderr stays transient without calling log.
  await writeFile(join(release, 'xcrun'), `#!/bin/sh
if [ "$2" = "wait" ]; then
  echo '{"status":"In Progress","id":"${SUBMISSION_ID}"}'
  echo 'Error: HTTP status code: 503. Service Unavailable for user@example.com super-secret-password TEAM123' >&2
  exit 1
fi
echo 'log should not be called' >&2
exit 99
`, { mode: 0o755 });
  await assert.rejects(waitForNotarization(SUBMISSION_ID, creds), error => {
    assert.equal(transientNotaryWaitError(error), true);
    assert.doesNotMatch(error.message, /Diagnostics from notarytool log:/);
    assertNoCreds(error);
    return true;
  });

  // Killed by signal includes signal name in error and is not retried.
  await writeFile(join(release, 'xcrun'), `#!/bin/sh
kill -KILL $$
`, { mode: 0o755 });
  await assert.rejects(waitForNotarization(SUBMISSION_ID, creds), error => {
    assert.match(error.message, /Process terminated by signal: SIGKILL/);
    assert.equal(transientNotaryWaitError(error), false);
    assertNoCreds(error);
    return true;
  });

  // Transient error echoing all credentials on stderr is redacted and retryable.
  await writeFile(join(release, 'xcrun'), `#!/bin/sh
echo 'Error: HTTPError(statusCode: nil, error: Error Domain=NSURLErrorDomain Code=-1009 "The Internet connection appears to be offline.") user@example.com super-secret-password TEAM123' >&2
exit 1
`, { mode: 0o755 });
  await assert.rejects(waitForNotarization(SUBMISSION_ID, creds), error => {
    assert.equal(transientNotaryWaitError(error), true);
    assertNoCreds(error);
    return true;
  });

  // Missing xcrun fails with ENOENT and does not expose spawnargs/credentials on the error object.
  process.env.PATH = release;
  await rm(join(release, 'xcrun'));
  await assert.rejects(waitForNotarization(SUBMISSION_ID, creds), error => {
    assert.equal(error.code, 'ENOENT');
    assert.equal(error.spawnargs, undefined);
    assertNoCreds(error);
    assert.equal(transientNotaryWaitError(error), false);
    return true;
  });
});
