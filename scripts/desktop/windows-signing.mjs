import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const policy = resolve(import.meta.dirname, '../lib/windows_signing.py');
const python = () => process.platform === 'win32' ? 'python' : 'python3';
export function signingEnabled() {
  execFileSync(python(), [policy, 'check-config'], { stdio: 'inherit' });
  return process.env.WINDOWS_SIGNING_ENABLED === 'true';
}
export function verifyWindowsArchive(path) {
  execFileSync(python(), [policy, 'verify', path, '--required', 'neurodesk-webapps.exe'], { stdio: 'inherit' });
}
export function windowsSigningConfig(platform = process.platform) {
  if (platform !== 'win32' || !signingEnabled()) return {};
  return {
    // In builder 26, afterSign runs after Windows resource editing, even when
    // signExecutable is false. Our hook owns signing and verification before ZIP.
    win: { signExecutable: false },
    afterSign: async ({ appOutDir, electronPlatformName }) => {
      if (electronPlatformName !== 'win32') throw new Error('Expected Windows packaging');
      execFileSync(python(), [policy, 'sign', appOutDir, '--required', 'neurodesk-webapps.exe'], { stdio: 'inherit' });
    },
  };
}
