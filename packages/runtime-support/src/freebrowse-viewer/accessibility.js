// Accessibility repairs to FreeBrowse's markup. FreeBrowse renders lazily, so
// the host reapplies them whenever its DOM changes.

// FreeBrowse selects a volume or surface when its row, a div that takes no
// focus, is clicked; only then does it show that item's contrast, opacity and
// colormap controls. The row's name becomes a toggle button so a keyboard user
// can reach them. The row itself holds other buttons, so it cannot be one.
export const ROW_NAMES = '[role="tabpanel"] div.cursor-pointer > div.flex-1 > p';

export function syncRowNames(root) {
  for (const name of root.querySelectorAll(ROW_NAMES)) {
    if (name.getAttribute('role') !== 'button') {
      name.setAttribute('role', 'button');
      name.setAttribute('tabindex', '0');
    }
    const selected = String(name.closest('div.cursor-pointer').classList.contains('bg-muted'));
    if (name.getAttribute('aria-pressed') !== selected) name.setAttribute('aria-pressed', selected);
  }
}

export function activateRowName(event) {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  if (!event.target.matches?.(ROW_NAMES)) return;
  event.preventDefault();
  event.target.click();
}

// FreeBrowse's labelled sliders (contrast, opacity, frame) render the label
// beside the slider and its number field without associating them, so neither
// control has a name. Each takes the label's text.
export function labelSliders(root) {
  for (const label of root.querySelectorAll('label')) {
    const controls = label.nextElementSibling;
    if (!controls?.querySelector('[role="slider"]')) continue;
    const name = label.textContent.trim();
    for (const control of controls.querySelectorAll('[role="slider"], input[type="number"]')) {
      if (control.getAttribute('aria-label') !== name) control.setAttribute('aria-label', name);
    }
  }
}
