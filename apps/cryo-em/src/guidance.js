import { EXAMPLE_ROOT, EXAMPLE_SETTINGS } from './example.js';
import { stepLabel } from './steps.js';

/** Idle help depends on current prerequisites, never on which event ran last. */
export function idleGuidance(state) {
  if (state.connectionState === 'connecting') return 'Connecting to server…';
  const movies = state.values.import.inputs.movies;
  const tutorial = state.tutorial && state.command === 'import'
    && ['root', 'path', 'pattern'].every(key => movies?.[key] === EXAMPLE_SETTINGS.import.inputs.movies[key]);
  if (!state.client) {
    if (tutorial) return 'Tutorial settings ready. Connect a server with its movies; see Standalone for setup.';
    return state.connectionState === 'initial' ? 'Drag and drop files' : 'Connect a server to continue; see Standalone for setup.';
  }
  if (state.projectLoading) return 'Opening project…';
  if (tutorial) {
    if (!state.info.dataRoots?.some(root => root.id === EXAMPLE_ROOT)) return 'Fetch movies on the server: neurodesk-compute fetch-example relion-tutorial';
    if (state.tutorial.client !== state.client) return 'Tutorial settings ready. Load the example again to check this server’s movies.';
    return state.project
      ? `${state.tutorial.movies.length} tutorial movies found on the server. Ready to import into this project.`
      : `${state.tutorial.movies.length} tutorial movies found on the server · choose or create a project before importing.`;
  }
  if (!state.project) return 'No project selected · choose or create a project';
  return `${stepLabel(state.command)} selected · review its inputs`;
}
