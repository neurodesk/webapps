// The editable review is a view of in-memory series, not a second copy of their
// scientific state. Closing a disclosure never resets the user's assignments.
import { DIRECTIONS, SCAN_TYPES, directionLabel } from './bids.js';

const TYPE_LABELS = { exclude: 'Exclude', T1w: 'T1w', T2w: 'T2w', FLAIR: 'FLAIR', dwi: 'DWI', epi: 'Reverse DWI (fmap)' };

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function createSeriesReview({ rows, editor, onChange }) {
  let series = [];
  let selected = null;
  const controls = new Map();
  const gradientReads = new Map();

  function changed(item) {
    item.reviewed = false;
    const check = rows.querySelector(`[data-review="${item.id}"]`);
    if (check) {
      check.checked = false;
      check.disabled = gradientReads.has(item);
    }
    onChange();
  }

  function field(parent, item, key, label, { options, type = 'text', value, update, event = 'change' } = {}) {
    const group = element('div', 'nd-field nd-report-form');
    const id = `${item.id}-${key}`;
    const title = element('label', '', label);
    title.htmlFor = id;
    const input = element(options ? 'select' : type === 'textarea' ? 'textarea' : 'input');
    input.id = id;
    if (input.tagName === 'INPUT') input.type = type;
    if (type === 'number') {
      input.min = '0';
      input.step = 'any';
    }
    if (options) {
      for (const [val, text] of options) {
        const option = element('option', '', text);
        option.value = val;
        input.append(option);
      }
    }
    input.value = value ?? '';
    input.addEventListener(event, () => {
      update(input.value);
      input.removeAttribute('aria-invalid');
      changed(item);
    });
    group.append(title, input);
    parent.append(group);
    controls.set(`${item.id}:${key}`, input);
    return input;
  }

  function show(item) {
    selected = item.id;
    editor.replaceChildren();
    controls.clear();
    const section = element('details', 'nd-sidebar-section');
    section.open = true;
    section.append(element('summary', 'nd-section-title', `Metadata · ${item.description}`));
    const body = element('div', 'nd-section-content');
    section.append(body);
    editor.append(section);
    field(body, item, 'acquisition', 'Acquisition label (optional)', {
      value: item.acquisition,
      update: (value) => { item.acquisition = value.trim(); },
    });
    if (['dwi', 'epi'].includes(item.type)) {
      field(body, item, 'direction', 'Direction label for filename', {
        value: item.direction,
        update: (value) => { item.direction = value.trim(); },
      });
      field(body, item, 'PhaseEncodingDirection', 'Phase encoding direction (NIfTI axes)', {
        options: [['', 'Not specified'], ...DIRECTIONS.map((value) => [value, value])],
        value: item.metadata.PhaseEncodingDirection,
        update: (value) => {
          if (value) item.metadata.PhaseEncodingDirection = value;
          else delete item.metadata.PhaseEncodingDirection;
        },
      });
      field(body, item, 'TotalReadoutTime', 'Total readout time (s)', {
        type: 'number',
        value: item.metadata.TotalReadoutTime,
        update: (value) => {
          if (value.trim()) item.metadata.TotalReadoutTime = Number(value);
          else delete item.metadata.TotalReadoutTime;
        },
      });
    }
    field(body, item, 'EchoTime', 'Echo time (s)', {
      type: 'number',
      value: item.metadata.EchoTime,
      update: (value) => {
        if (value.trim()) item.metadata.EchoTime = Number(value);
        else delete item.metadata.EchoTime;
      },
    });
    if (item.type === 'epi') {
      const targets = element('fieldset');
      targets.id = `${item.id}-targets`;
      targets.append(element('legend', '', 'DWI acquisitions served by this fieldmap'));
      for (const target of series.filter((candidate) => candidate.type === 'dwi')) {
        const label = element('label', 'nd-check');
        const check = element('input');
        check.type = 'checkbox';
        check.value = target.id;
        check.checked = item.targets.includes(target.id);
        check.addEventListener('change', () => {
          item.targets = check.checked ? [...new Set([...item.targets, target.id])] : item.targets.filter((id) => id !== target.id);
          changed(item);
        });
        label.append(check, document.createTextNode(target.description));
        targets.append(label);
      }
      body.append(targets);
      controls.set(`${item.id}:targets`, targets);
    }
    if (['dwi', 'epi'].includes(item.type)) {
      const gradients = element('details', 'nd-sidebar-section');
      gradients.id = `${item.id}-gradients`;
      gradients.append(element('summary', 'nd-section-title', 'Diffusion gradients'));
      const content = element('div', 'nd-section-content');
      gradients.append(content);
      const label = element('label', 'nd-file', 'Load matching bval and bvec files');
      const files = element('input');
      files.type = 'file';
      files.multiple = true;
      files.accept = '.bval,.bvec';
      files.setAttribute('data-neurodesk-input', 'gradients');
      files.addEventListener('change', async () => {
        const selection = Array.from(files.files).filter(file => /\.(bval|bvec)$/i.test(file.name));
        if (!selection.length) return;
        const read = Symbol();
        gradientReads.set(item, read);
        files.setCustomValidity('');
        changed(item);
        let applied = false;
        try {
          const gradients = {};
          for (const file of selection) {
            gradients[file.name.split('.').at(-1).toLowerCase()] = await file.text();
            if (gradientReads.get(item) !== read || !series.includes(item)) return;
          }
          Object.assign(item, gradients);
          applied = true;
        } catch {
          if (gradientReads.get(item) === read && series.includes(item)) {
            files.setCustomValidity('Could not read gradient files. Select them again.');
            files.reportValidity();
          }
        } finally {
          if (gradientReads.get(item) === read && series.includes(item)) {
            gradientReads.delete(item);
            changed(item);
            if (applied && selected === item.id) {
              for (const key of ['bval', 'bvec']) {
                const control = controls.get(`${item.id}:${key}`);
                if (control) control.value = item[key];
              }
              files.value = '';
            }
          }
        }
      });
      label.prepend(files);
      content.append(label);
      for (const key of ['bval', 'bvec']) {
        field(content, item, key, key === 'bval' ? 'b-values' : 'b-vectors (three rows)', {
          type: 'textarea',
          event: 'input',
          value: item[key],
          update: (value) => {
            gradientReads.delete(item);
            item[key] = value;
          },
        });
      }
      body.append(gradients);
      controls.set(`${item.id}:gradients`, gradients);
    }
    const advanced = element('details', 'nd-sidebar-section');
    advanced.append(element('summary', 'nd-section-title', 'All acquisition metadata'));
    const content = element('div', 'nd-section-content');
    advanced.append(content);
    const json = field(content, item, 'metadata', 'JSON sidecar', {
      type: 'textarea',
      value: JSON.stringify(item.metadata, null, 2),
      update: () => {},
    });
    const apply = element('button', 'nd-btn nd-btn-secondary', 'Apply metadata');
    apply.type = 'button';
    apply.addEventListener('click', () => {
      try {
        const value = JSON.parse(json.value);
        if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Enter a JSON object.');
        item.metadata = value;
        json.setCustomValidity('');
        changed(item);
        show(item);
      } catch {
        json.setCustomValidity('Enter a valid JSON object.');
        json.reportValidity();
      }
    });
    content.append(apply);
    body.append(advanced);
  }

  function render(items) {
    gradientReads.clear();
    series = items;
    rows.replaceChildren();
    editor.replaceChildren();
    for (const item of series) {
      const row = element('tr');
      row.dataset.series = item.id;
      row.append(element('td', '', item.description), element('td', '', String(item.volumes)));
      const typeCell = element('td');
      const select = field(typeCell, item, 'type', 'Scan type', {
        options: SCAN_TYPES.map((type) => [type, TYPE_LABELS[type]]),
        value: item.type,
        update: (value) => {
          item.type = value;
          if (!item.direction) item.direction = directionLabel(item);
          show(item);
        },
      });
      select.setAttribute('aria-label', `Scan type for ${item.description}`);
      typeCell.querySelector('label').classList.add('nd-sr-only');
      const confirmedCell = element('td');
      const check = element('input');
      check.type = 'checkbox';
      check.dataset.review = item.id;
      check.checked = item.reviewed;
      check.setAttribute('aria-label', `Confirm ${item.description}`);
      check.addEventListener('change', () => {
        if (gradientReads.has(item)) {
          check.checked = false;
          return;
        }
        item.reviewed = check.checked;
        row.removeAttribute('data-flag');
        onChange();
      });
      const checkLabel = element('label', 'nd-check');
      checkLabel.append(check, element('span', 'nd-sr-only', 'Confirm'));
      confirmedCell.append(checkLabel);
      const editCell = element('td');
      const edit = element('button', 'nd-btn nd-btn-secondary nd-btn-sm', 'Edit');
      edit.type = 'button';
      edit.setAttribute('aria-label', `Edit ${item.description}`);
      edit.addEventListener('click', () => show(item));
      editCell.append(edit);
      row.append(typeCell, confirmedCell, editCell);
      rows.append(row);
    }
    if (series.length) show(series.find((item) => item.id === selected) || series[0]);
  }

  function revealErrors(errors) {
    for (const row of rows.children) row.removeAttribute('data-flag');
    for (const error of errors) {
      if (error.id) rows.querySelector(`[data-series="${error.id}"]`)?.setAttribute('data-flag', 'error');
    }
    const error = errors.find((entry) => entry.id);
    if (!error) return;
    const item = series.find((entry) => entry.id === error.id);
    show(item);
    const control = controls.get(`${item.id}:${error.field}`);
    if (control) {
      control.setAttribute('aria-invalid', 'true');
      if (control.tagName === 'DETAILS') control.open = true;
      control.focus();
    } else {
      rows.querySelector(`[data-series="${item.id}"] input`)?.focus();
    }
  }

  return { render, revealErrors, hasPendingEdits: () => gradientReads.size > 0 };
}
