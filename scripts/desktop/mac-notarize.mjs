import { execFile, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { setTimeout as wait } from 'node:timers/promises';
import { basename, dirname, join, resolve } from 'node:path';

const require = createRequire(resolve(import.meta.dirname, '../../packages/desktop/package.json'));
// Resolve @electron/notarize the way electron-builder does, so the hook runs the
// version builder pins rather than one the desktop package would have to track.
function electronNotarize() {
  const builder = createRequire(require.resolve('electron-builder'));
  return createRequire(builder.resolve('app-builder-lib'))('@electron/notarize');
}

// NSURLErrorDomain transport failures a retry can outlast: connection lost,
// timed out, offline, cannot connect, DNS lookup failures. Trust errors such as -1202 are not.
const TRANSIENT_URL_CODES = new Set([-1005, -1001, -1009, -1004, -1003, -1006]);
const SUBMISSION_URL = /https:\/\/appstoreconnect\.apple\.com\/notary\/v2\/submissions\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;

export function transientStapleError(error) {
  const message = String(error?.message ?? error);
  const staple = message.match(/^Failed to staple your application with code: (\d+)/);
  if (!staple) return false;
  const url = message.match(/NSURLErrorDomain Code=(-\d+)/);
  if (url) return TRANSIENT_URL_CODES.has(Number(url[1]));
  return Number(staple[1]) === 68;
}

function isTransientOutput(text) {
  const url = text.match(/NSURLErrorDomain Code=(-\d+)/);
  if (url) return TRANSIENT_URL_CODES.has(Number(url[1]));
  return /\bError: HTTP status code: 50[0234]\b|\bHTTPError\(statusCode: Optional\(50[0234]\)/.test(text);
}

export function transientNotaryWaitError(error) {
  const message = String(error?.message ?? error);
  if (!/^Failed to notarize via notarytool\.\s+Failed with unexpected result:/m.test(message)) return false;
  return isTransientOutput(message);
}

export function transientSubmissionId(error) {
  if (!transientNotaryWaitError(error)) return null;
  return String(error?.message ?? error).match(SUBMISSION_URL)?.[1] ?? null;
}

export async function retryTransient(run, { attempts = 4, delay = 15000, sleep = wait, log = console.log, isTransient = transientStapleError, action = 'stapling' } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run(attempt);
    } catch (error) {
      if (attempt >= attempts || !isTransient(error)) throw error;
      const pause = delay * 2 ** (attempt - 1);
      const label = typeof action === 'function' ? action() : action;
      log(`Transient network error ${label} on attempt ${attempt} of ${attempts}, retry in ${pause / 1000} s:\n${error.message}`);
      await sleep(pause);
    }
  }
}

function runXcrun(args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('xcrun', args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    const stdout = [];
    const stderr = [];
    const output = [];
    child.stdout?.on('data', chunk => {
      const text = chunk.toString();
      stdout.push(text);
      output.push(text);
    });
    child.stderr?.on('data', chunk => {
      const text = chunk.toString();
      stderr.push(text);
      output.push(text);
    });
    child.on('error', error => {
      // Drop spawnargs so credentials passed on argv never sit on the error object.
      const sanitized = new Error(`spawn xcrun ${error.code ?? error.message}`);
      sanitized.code = error.code;
      sanitized.path = 'xcrun';
      reject(sanitized);
    });
    child.on('close', (code, signal) => resolvePromise({
      code,
      signal,
      stdout: stdout.join(''),
      stderr: stderr.join(''),
      output: output.join(''),
    }));
  });
}

function redactCredentials(text, credentials) {
  let redacted = String(text ?? '');
  for (const secret of [credentials.appleIdPassword, credentials.appleId, credentials.teamId]) {
    if (secret) redacted = redacted.replaceAll(secret, '***');
  }
  return redacted;
}

// Resumes polling an existing notarization submission without uploading the app again.
export async function waitForNotarization(submissionId, credentials) {
  const auth = ['--apple-id', credentials.appleId, '--password', credentials.appleIdPassword, '--team-id', credentials.teamId];
  const result = await runXcrun(['notarytool', 'wait', submissionId, ...auth, '--output-format', 'json']);
  const stdout = redactCredentials(result.stdout, credentials);
  const stderr = redactCredentials(result.stderr, credentials);
  const rawOut = redactCredentials(result.output, credentials).trim();
  const suffix = result.signal ? `\n\nProcess terminated by signal: ${result.signal}` : '';
  let parsed;
  try {
    parsed = JSON.parse(stdout.trim() || rawOut);
  } catch {
    throw new Error(`Failed to notarize via notarytool.  Failed with unexpected result: \n\n${rawOut}${suffix}`);
  }
  if (result.code === 0 && parsed?.status === 'Accepted') return parsed;
  if (parsed?.status !== 'Invalid' && parsed?.status !== 'Rejected' && (result.signal || isTransientOutput(stderr))) {
    const detail = stderr.trim() || rawOut;
    throw new Error(`Failed to notarize via notarytool.  Failed with unexpected result: \n\n${detail}${suffix}`);
  }
  let logOutput = '';
  try {
    const logResult = await runXcrun(['notarytool', 'log', submissionId, ...auth]);
    const redactedLog = redactCredentials(logResult.output, credentials);
    if (redactedLog.trim()) logOutput = redactedLog;
  } catch {
    // Best-effort diagnostics, matching @electron/notarize.
  }
  let message = `Failed to notarize via notarytool\n\n${rawOut}${suffix}`;
  if (logOutput) message += `\n\nDiagnostics from notarytool log: ${logOutput}`;
  throw new Error(message);
}

// Same command and failure message as @electron/notarize's stapleApp, which the
// package does not export.
export function stapleApp(appPath) {
  return new Promise((resolvePromise, reject) => {
    execFile('xcrun', ['stapler', 'staple', '-v', basename(appPath)], { cwd: dirname(appPath) }, (error, stdout, stderr) => {
      if (!error) return resolvePromise();
      if (typeof error.code !== 'number') return reject(error);
      reject(new Error(`Failed to staple your application with code: ${error.code}\n\n${stdout}${stderr}`));
    });
  });
}

export function macNotarizeConfig(platform = process.platform, env = process.env, tools = {}) {
  if (platform !== 'darwin' || !env.APPLE_ID) return {};
  const credentials = { appleId: env.APPLE_ID, appleIdPassword: env.APPLE_APP_SPECIFIC_PASSWORD, teamId: env.APPLE_TEAM_ID };
  const { notarize = electronNotarize().notarize, waitNotary = waitForNotarization, staple = stapleApp, sleep = wait, log = console.log } = tools;
  return {
    // electron-builder would otherwise notarize inside signApp, before afterSign,
    // and the hook would submit the app a second time.
    mac: { notarize: false },
    afterSign: async ({ appOutDir, electronPlatformName, packager }) => {
      if (electronPlatformName !== 'darwin') throw new Error('Expected macOS packaging');
      const appPath = join(appOutDir, `${packager.appInfo.productFilename}.app`);
      // Submit and staple once through the public API. On a transient staple failure,
      // retry only stapling; on a transient polling drop that includes a submission id,
      // resume waiting on that submission (30 s -> 60 s -> 120 s -> 240 s) and then staple.
      // The app is never submitted twice.
      try {
        await notarize({ tool: 'notarytool', appPath, ...credentials });
      } catch (error) {
        if (transientStapleError(error)) {
          await retryTransient(
            attempt => (attempt === 1 ? Promise.reject(error) : staple(appPath)),
            { sleep, log },
          );
        } else {
          const submissionId = transientSubmissionId(error);
          if (!submissionId) throw error;
          await retryTransient(
            attempt => (attempt === 1 ? Promise.reject(error) : waitNotary(submissionId, credentials)),
            {
              attempts: 5,
              delay: 30000,
              sleep,
              log,
              isTransient: transientNotaryWaitError,
              action: `waiting for notarization ${submissionId}`,
            },
          );
          await retryTransient(() => staple(appPath), { sleep, log });
        }
      }
      log(`notarization successful: ${appPath}`);
    },
  };
}
