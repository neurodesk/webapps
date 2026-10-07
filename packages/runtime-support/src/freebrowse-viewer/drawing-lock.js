// FreeBrowse's own drawing controls: its Drawing tab (trigger and panel) and
// the "Edit as drawing" button of each volume. A host that edits the drawing
// layer with its own tools (the shared nd-mask-editor) locks them for the
// session, so FreeBrowse cannot open, replace or close the layer under it.
// Locked controls stay visible; `inert` takes them out of pointer, keyboard
// and accessibility interaction until the session ends.
export const DRAWING_CONTROLS = [
  '[role="tab"][id$="-trigger-drawing"]',
  '[role="tabpanel"][id$="-content-drawing"]',
  'button[title="Edit as drawing"]',
].join(', ');

export const LOCKED_ATTRIBUTE = 'data-nd-drawing-locked';

// Applies `locked` to every drawing control under `root`. FreeBrowse renders
// these controls lazily, so the host calls this again whenever its DOM changes.
// Unlocking only touches controls this lock marked.
export function applyDrawingLock(root, locked) {
  for (const node of root.querySelectorAll(DRAWING_CONTROLS)) {
    if (!locked && !node.hasAttribute(LOCKED_ATTRIBUTE)) continue;
    node.toggleAttribute('inert', locked);
    node.toggleAttribute(LOCKED_ATTRIBUTE, locked);
  }
}
