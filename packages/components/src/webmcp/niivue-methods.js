/**
 * What a browser agent may do with each nv-mcp core tool through viewers_niivue. Every method nv-mcp
 * offers is listed, and the tests fail when nv-mcp adds one, so a new method stays out until someone
 * classifies it here.
 *
 *   read     reads the scene
 *   display  changes what the viewer shows, not the data
 *   fetch    loads from an address, which the person approves first
 *   denied   not offered: exports pixels or files, edits or removes data, adds page controls, or
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
  set_signal: 'display',
  set_slide: 'display',
  set_view: 'display',
  set_viewport: 'display',
  set_volume: 'display',

  add_mesh_layer: 'fetch',
  add_overlay: 'fetch',
  load_document: 'fetch',
  load_mesh: 'fetch',
  load_signal: 'fetch',
  load_volume: 'fetch',

  save: 'denied',
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
 * The addresses a call would fetch: every `url`, at any depth, and a `labels` table other than the
 * built-in FreeSurfer one (set_volume and add_overlay take a label table's address there).
 */
export function niivueAddresses(params = {}) {
  const found = [];
  const visit = value => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        if (typeof item === 'string' && (key === 'url' || (key === 'labels' && item !== 'freesurfer'))) found.push(item);
        else visit(item);
      }
    }
  };
  visit(params);
  return found;
}
