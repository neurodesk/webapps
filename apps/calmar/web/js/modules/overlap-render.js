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

function appendTextCell(row, text) {
  const cell = document.createElement('td');
  cell.textContent = text;
  row.appendChild(cell);
  return cell;
}

function appendPctCell(row, pct, color) {
  // Bar lives inside the % cell so the table stays 3 columns and matches the
  // static <thead> in index.html. The numeric label is on top, a thin bar
  // beneath it shows magnitude at a glance.
  const cell = document.createElement('td');
  cell.className = 'overlap-pct-cell';

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

export function renderOverlapTable(tableEl, summary, {
  colormap,
  labelHeader = 'Atlas label',
  percentHeader = '% of lesion',
  emptyLabel = 'No overlap'
} = {}) {
  tableEl.innerHTML = '';

  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (const label of [labelHeader, 'Voxels', percentHeader]) {
    const th = document.createElement('th');
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
    cell.colSpan = 3;
    cell.textContent = emptyLabel;
    row.appendChild(cell);
    tbody.appendChild(row);
    tableEl.appendChild(tbody);
    return;
  }

  for (const network of networks) {
    const row = document.createElement('tr');
    const pct = (Number(network.fractionOfLesion) || 0) * 100;
    appendTextCell(row, network.network);
    appendTextCell(row, `${Number(network.voxelsInLesion) || 0}`);
    appendPctCell(row, pct, colorForNetwork(network.network, colormap));
    tbody.appendChild(row);
  }

  tableEl.appendChild(tbody);
}
