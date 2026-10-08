import { loadAppsRegistry } from '../scripts/lib/apps-registry.mjs';
import { loadAppExamples } from '../scripts/lib/app-examples.mjs';

/** @returns {Promise<{ id: string, path: string, title: string, examples: import('../packages/components/src/elements/example-selector.js').AppExample[] }[]>} */
export async function agenticCatalog(selection = process.env.E2E_APPS) {
  const { apps } = await loadAppsRegistry();
  const ids = selection ? selection.split(',') : apps.map(app => app.id);
  if (ids.some(id => !apps.some(app => app.id === id))) {
    throw new Error(`E2E_APPS contains an unknown app: ${selection}`);
  }
  return Promise.all(apps.filter(app => ids.includes(app.id)).map(async app => ({
    id: app.id,
    path: app.path,
    title: app.title,
    examples: await loadAppExamples(app),
  })));
}
