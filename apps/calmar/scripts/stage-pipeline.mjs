import { cp, mkdir } from 'node:fs/promises';
await mkdir('web/vendor/calmar', { recursive: true });
await cp('../../packages/calmar/src', 'web/vendor/calmar/src', { recursive: true });
// The disconnectome engine (nii2tvx WebAssembly) for the knowledge-base report's
// tract-disconnection stage; the Disconnectome app shares the same package.
await mkdir('web/vendor/nii2tvx', { recursive: true });
await cp('../../packages/nii2tvx/src', 'web/vendor/nii2tvx/src', { recursive: true });
await cp('../../packages/nii2tvx/wasm', 'web/vendor/nii2tvx/wasm', { recursive: true });
