import { EXAMPLE_ROOT, EXAMPLE_SETTINGS } from './example.js';
import { stepLabel } from './steps.js';

/** Idle help depends on current prerequisites, never on which event ran last. */
export function idleGuidance({ connectionState, client, projectLoading, project, command, values, tutorial, info }) {
  if (connectionState === 'connecting') return 'Connecting to server…';
  const movies = values.import.inputs.movies;
  const tutorialSelected = tutorial && command === 'import'
    && ['root', 'path', 'pattern'].every(key => movies?.[key] === EXAMPLE_SETTINGS.import.inputs.movies[key]);
  if (!client) {
    if (tutorialSelected) return 'Tutorial settings ready. Connect a server with its movies; see Standalone for setup.';
    return connectionState === 'initial' ? 'Drag and drop files' : 'Connect a server to continue; see Standalone for setup.';
  }
  if (projectLoading) return 'Opening project…';
  if (tutorialSelected) {
    if (!info.dataRoots?.some(root => root.id === EXAMPLE_ROOT)) return 'Fetch movies on the server: neurodesk-compute fetch-example relion-tutorial';
    if (tutorial.client !== client) return 'Tutorial settings ready. Load the example again to check this server’s movies.';
    return project
      ? `${tutorial.movies.length} tutorial movies found on the server. Ready to import into this project.`
      : `${tutorial.movies.length} tutorial movies found on the server · choose or create a project before importing.`;
  }
  if (!project) return 'No project selected · choose or create a project';
  return `${stepLabel(command)} selected · review its inputs`;
}
