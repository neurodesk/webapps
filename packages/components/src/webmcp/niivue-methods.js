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
 *            name further addresses, reads a file's format from its address, adds page controls, or
 *            takes settings that can name an address
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
  load_volume: 'fetch',

  // NiiVue picks a signal's reader from its address and looks for a sidecar beside it, so it cannot be
  // given the approved bytes under a local address.
  load_signal: 'denied',

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

/**
 * The parameters each offered method takes over WebMCP: those that read the scene, change what it
 * shows, or name the one file a fetch method loads. Any other parameter is refused, so a parameter
 * nv-mcp adds stays out until someone classifies it here; the components tests hold this table to
 * nv-mcp's own schemas at the pinned version. Left out on purpose: `tab` (the desktop server's tab
 * choice), and set_volume's `affine`, `reset_affine` and `transform` (move the volume),
 * `load_all_frames` (fetches from the volume's own address) and `v1` (turns a vector volume into a
 * one-frame colour image for good).
 */
export const NIIVUE_PARAMETERS = Object.freeze(Object.fromEntries(Object.entries({
  capabilities: '',
  describe_volume: 'volume stats mask mask_labels drawing affine',
  get_options: 'names describe',
  list_annotations: 'polygons json svg slice slice_position',
  list_measurements: '',
  list_meshes: '',
  list_regions: 'query',
  list_signals: '',
  map_point: 'canvas mm vox',
  where_am_i: '',
  animate: 'azimuth elevation zoom render_pan pan_2d crosshair_mm clip_planes volumes meshes duration_ms easing angles interrupt_on_input wait stop',
  go_to_point: 'mm vox plane label',
  go_to_region: 'region plane',
  nudge_crosshair: 'vox',
  set_boxes: 'focus boxes',
  set_camera: 'azimuth elevation pan_2d render_pan pivot center_on global',
  set_clip_plane: 'plane azimuth elevation index planes depth face',
  set_custom_layout: 'tiles clear',
  set_graph: 'cursor step zoom pan range reset',
  set_instances: 'instances camera clear',
  set_labels: 'labels dim_others clear',
  set_mesh: 'mesh name opacity color shader slice_shader visible colorbar legend tract connectome',
  set_mesh_layer: 'mesh layer colormap colormap_negative cal_min cal_max cal_min_neg cal_max_neg opacity colorbar invert transparent_below_cal_min additive outline_width frame',
  set_view: 'slice layout mosaic show_render radiological colorbar',
  set_viewport: 'pan zoom bounds reset',
  set_volume: 'volume colormap colormap_negative opacity cal_min cal_max cal_min_neg cal_max_neg colormap_type transparent_below_cal_min frame invert colorbar nearest atlas_outline modulate_alpha labels modulate auto_window chunk_grid spread',
  add_mesh_layer: 'mesh url name colormap colormap_negative cal_min cal_max cal_min_neg cal_max_neg opacity colorbar invert transparent_below_cal_min additive outline_width',
  add_overlay: 'url name labels colormap opacity cal_min cal_max colormap_negative cal_min_neg cal_max_neg colorbar',
  load_mesh: 'url name replace opacity color shader slice_shader visible colorbar legend layers',
  load_volume: 'url name colormap mni',
}).map(([method, names]) => [method, Object.freeze(names.split(' ').filter(Boolean))])));

/** Why viewers_niivue refuses these parameters of `method`, if it does. */
export function niivueParameterIssues(method, params = {}) {
  if (method === undefined) return Object.keys(params).length ? ['params need a method'] : [];
  const allowed = NIIVUE_PARAMETERS[method] ?? [];
  const refused = Object.keys(params).filter(name => !allowed.includes(name));
  return refused.length ? [`${method} over WebMCP does not take ${refused.join(', ')}: it takes only ${allowed.join(', ') || 'no parameters'}`] : [];
}

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
