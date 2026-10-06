import { resolve } from 'node:path';
import { serveSite } from '../test-utils/serve-site.mjs';

const server = await serveSite(resolve(process.env.E2E_SITE_DIR ?? 'dist'), {
  port: Number(process.env.PORT ?? 0),
});
console.log(`Serving production apps at ${server.origin}`);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await server.close();
    process.exit(0);
  });
}
