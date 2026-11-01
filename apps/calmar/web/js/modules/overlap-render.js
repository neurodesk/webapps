function orderedNetworks(summary) {
  const networks = Array.isArray(summary?.networks) ? summary.networks : [];
  return networks
    .filter(row => row.network !== 'Unassigned')
    .concat(networks.filter(row => row.network === 'Unassigned'));
}

function colorForNetwork(network, colormap) {
  if (network === 'Unassigned' || !colormap?.labels) return '#888';
  const index = colormap.labels.indexOf(network);
  if (index < 0) return '#888';
  const r = colormap.R?.[index];
  const g = colormap.G?.[index];
  const b = colormap.B?.[index];
  if (r == null || g == null || b == null) return '#888';
  return `rgb(${r}, ${g}, ${b})`;
}

function appendTextCell(row, text, className = '') {
  const cell = document.createElement('td');
  if (className) cell.className = className;
  cell.textContent = text;
  row.appendChild(cell);
  return cell;
}

function appendPctCell(row, pct, color) {
  // Bar lives inside the % cell so the table stays 3 columns and matches the
  // static <thead> in index.html. The numeric label is on top, a thin bar
  // beneath it shows magnitude at a glance.
  const cell = document.createElement('td');
  cell.className = 'nd-numeric overlap-pct-cell';

  const label = document.createElement('span');
  label.className = 'overlap-pct';
  label.textContent = `${pct.toFixed(1)}%`;

  const bar = document.createElement('div');
  bar.className = 'overlap-bar';
  const fill = document.createElement('div');
  fill.className = 'overlap-bar-fill';
  fill.style.width = `${pct}%`;
  fill.style.backgroundColor = color;
  bar.appendChild(fill);

  cell.appendChild(label);
  cell.appendChild(bar);
  row.appendChild(cell);
  return cell;
}

// Long parcel tables (Schaefer lists every hit parcel) show the first
// `maxRows` labels and fold the rest behind one "Show all" row; the CSV
// export and the functional profiles still use every row.
export function renderOverlapTable(tableEl, summary, {
  colormap,
  labelHeader = 'Atlas label',
  percentHeader = 'Lesion %',
  emptyLabel = 'No overlap',
  networkSizes = null,
  maxRows = 12
} = {}) {
  tableEl.innerHTML = '';

  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (const [label, className] of [[labelHeader, ''], ['Voxels', 'nd-numeric'], [percentHeader, 'nd-numeric'], ...(networkSizes ? [['ROI covered %', 'nd-numeric']] : [])]) {
    const th = document.createElement('th');
    if (className) th.className = className;
    th.textContent = label;
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  tableEl.appendChild(thead);

  const tbody = document.createElement('tbody');
  const networks = orderedNetworks(summary);
  if (networks.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = networkSizes ? 4 : 3;
    cell.textContent = emptyLabel;
    row.appendChild(cell);
    tbody.appendChild(row);
    tableEl.appendChild(tbody);
    return;
  }

  const extra = [];
  networks.forEach((network, index) => {
    const row = document.createElement('tr');
    const pct = (Number(network.fractionOfLesion) || 0) * 100;
    appendTextCell(row, network.network);
    appendTextCell(row, `${Number(network.voxelsInLesion) || 0}`, 'nd-numeric');
    appendPctCell(row, pct, colorForNetwork(network.network, colormap));
    if (networkSizes) {
      const size = networkSizes[network.network];
      appendTextCell(row, size > 0 ? `${(100 * network.voxelsInLesion / size).toFixed(1)}%` : '—', 'nd-numeric');
    }
    if (maxRows > 0 && index >= maxRows) {
      row.hidden = true;
      row.className = 'overlap-row-extra';
      extra.push(row);
    }
    tbody.appendChild(row);
  });
  if (extra.length) {
    const row = document.createElement('tr');
    row.className = 'overlap-fold-row';
    const cell = document.createElement('td');
    cell.colSpan = networkSizes ? 4 : 3;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'nd-btn nd-btn-secondary nd-btn-sm overlap-fold';
    const label = `${networks.length} labels`;
    button.textContent = `Show all ${label}`;
    button.addEventListener('click', () => {
      const open = extra[0].hidden;
      for (const hidden of extra) hidden.hidden = !open;
      button.textContent = open ? `Show first ${maxRows} of ${label}` : `Show all ${label}`;
    });
    cell.appendChild(button);
    row.appendChild(cell);
    tbody.appendChild(row);
  }

  tableEl.appendChild(tbody);
}
