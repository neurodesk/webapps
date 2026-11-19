/**
 * What a browser agent may do with each nv-mcp core tool through viewers_niivue. Every method nv-mcp
 * offers is listed, and the tests fail when nv-mcp adds one, so a new method stays out until someone
 * classifies it here. The components tests hold the audit of each offered method against the pinned
 * nv-mcp source.
 *
 *   read     reads the scene
 *   display  changes what the viewer shows, not the data
 *   fetch    loads one file from an address the person approves first: the tool fetches it, refusing
 *            redirects, and the viewer receives the bytes, never the address
 *   denied   not offered: exports pixels or files, edits or removes data, loads a payload that can
 *            name further addresses, adds page controls, or takes settings that can name an address
 *
 * The desktop agent server and the nv-mcp WebSocket connection keep nv-mcp's full vocabulary.
 */
export const NIIVUE_METHODS = Object.freeze({
  capabilities: 'read',
  describe_volume: 'read',
  get_options: 'read',
  list_annotations: 'read',
  list_measurements: 'read',
  list_meshes: 'read',
  list_regions: 'read',
  list_signals: 'read',
  map_point: 'read',
  where_am_i: 'read',

  animate: 'display',
  go_to_point: 'display',
  go_to_region: 'display',
  nudge_crosshair: 'display',
  set_boxes: 'display',
  set_camera: 'display',
  set_clip_plane: 'display',
  set_custom_layout: 'display',
  set_graph: 'display',
  set_instances: 'display',
  set_labels: 'display',
  set_mesh: 'display',
  set_mesh_layer: 'display',
  set_view: 'display',
  set_viewport: 'display',
  set_volume: 'display',

  add_mesh_layer: 'fetch',
  add_overlay: 'fetch',
  load_mesh: 'fetch',
  load_signal: 'fetch',
  load_volume: 'fetch',

  load_document: 'denied',
  save: 'denied',
  set_signal: 'denied',
  set_slide: 'denied',
  screenshot: 'denied',
  chunk_stats: 'denied',
  add_colormap: 'denied',
  edit_annotations: 'denied',
  edit_drawing: 'denied',
  edit_measurements: 'denied',
  transform_volume: 'denied',
  update_mesh_positions: 'denied',
  update_volume_data: 'denied',
  remove_mesh: 'denied',
  remove_mesh_layer: 'denied',
  remove_signal: 'denied',
  remove_volume: 'denied',
  reorder_volume: 'denied',
  add_data: 'denied',
  list_data: 'denied',
  load_data: 'denied',
  remove_data: 'denied',
  add_control: 'denied',
  list_controls: 'denied',
  remove_control: 'denied',
  set_control: 'denied',
  set_font: 'denied',
  set_options: 'denied',
});

/** The methods viewers_niivue offers. */
export const offeredNiivueMethods = () => Object.keys(NIIVUE_METHODS).filter(method => NIIVUE_METHODS[method] !== 'denied').sort();

/** Parameters of an offered method that move, edit or load data, which viewers_niivue refuses. */
export const REFUSED_PARAMETERS = Object.freeze({
  set_volume: Object.freeze(['affine', 'reset_affine', 'transform', 'load_all_frames']),
});

// set_volume and add_overlay take a label table's address in `labels`; a name without a slash is built in.
const isAddress = (key, value) => typeof value === 'string' && (key === 'url' || (key === 'labels' && value.includes('/')));

/** The addresses a call would fetch: every `url`, at any depth, and a `labels` table's address. */
export function niivueAddresses(params = {}) {
  const found = [];
  const visit = value => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        if (isAddress(key, item)) found.push(item);
        else visit(item);
      }
    }
  };
  visit(params);
  return found;
}

const fileName = href => decodeURIComponent(new URL(href).pathname.split('/').pop() || 'download');

/**
 * A copy of `params` in which each address names local bytes instead: `load(address)` fetches it and
 * resolves `{ blob, href }`. An object whose `url` is replaced keeps its `name`, or takes the file name
 * of the address, since the viewer reads the format from the name. `release()` frees the copies.
 */
export async function withLocalAddresses(params, load) {
  const made = [];
  const local = async address => {
    const { blob, href } = await load(address);
    const url = URL.createObjectURL(blob);
    made.push(url);
    return { url, href };
  };
  const visit = async value => {
    if (Array.isArray(value)) return Promise.all(value.map(visit));
    if (!value || typeof value !== 'object') return value;
    const copy = {};
    for (const [key, item] of Object.entries(value)) {
      if (!isAddress(key, item)) copy[key] = await visit(item);
      else if (key === 'labels') copy[key] = (await local(item)).url;
      else {
        const { url, href } = await local(item);
        copy[key] = url;
        if (typeof value.name !== 'string') copy.name = fileName(href);
      }
    }
    return copy;
  };
  try {
    return { params: await visit(params), release: () => made.forEach(url => URL.revokeObjectURL(url)) };
  } catch (error) {
    made.forEach(url => URL.revokeObjectURL(url));
    throw error;
  }
}
