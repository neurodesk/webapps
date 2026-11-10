import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const policy = resolve(import.meta.dirname, '../lib/windows_signing.py');
const python = () => process.platform === 'win32' ? 'python' : 'python3';
// Each catalogue's suite has its own executable (`desktop.executable` in the
// registry), so signing and verification require the one the archive carries.
function requiredExecutable(executable) {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(executable ?? '')) throw new Error('Name the suite executable that Windows signing requires');
  return `${executable}.exe`;
}
export function signingEnabled() {
  execFileSync(python(), [policy, 'check-config'], { stdio: 'inherit' });
  return process.env.WINDOWS_SIGNING_ENABLED === 'true';
}
export function verifyWindowsArchive(path, executable) {
  execFileSync(python(), [policy, 'verify', path, '--required', requiredExecutable(executable)], { stdio: 'inherit' });
}
export function windowsSigningConfig(executable, platform = process.platform) {
  const required = requiredExecutable(executable);
  if (platform !== 'win32' || !signingEnabled()) return {};
  return {
    // In builder 26, afterSign runs after Windows resource editing, even when
    // signExecutable is false. Our hook owns signing and verification before ZIP.
    win: { signExecutable: false },
    afterSign: async ({ appOutDir, electronPlatformName }) => {
      if (electronPlatformName !== 'win32') throw new Error('Expected Windows packaging');
      execFileSync(python(), [policy, 'sign', appOutDir, '--required', required], { stdio: 'inherit' });
    },
  };
}
