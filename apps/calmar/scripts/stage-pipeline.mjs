import { cp, mkdir } from 'node:fs/promises';
await mkdir('web/vendor/calmar', { recursive: true });
await cp('../../packages/calmar/src', 'web/vendor/calmar/src', { recursive: true });
