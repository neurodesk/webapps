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

  const columns = [
    { label: labelHeader, key: 'label', value: row => row.network },
    { label: 'Voxels', key: 'voxels', value: row => Number(row.voxelsInLesion) || 0 },
    { label: percentHeader, key: 'lesion', value: row => Number(row.fractionOfLesion) || 0 },
    ...(networkSizes ? [{ label: 'ROI covered %', key: 'roi', value: row => networkSizes[row.network] > 0 ? row.voxelsInLesion / networkSizes[row.network] : null }] : []),
  ];
  const networks = orderedNetworks(summary);
  const thead = tableEl.createTHead();
  const headerRow = thead.insertRow();
  const tbody = tableEl.createTBody();
  let expanded = false;
  let sortKey = tableEl.dataset.sortKey;
  let descending = tableEl.dataset.sortDirection === 'descending';
  const headers = [];

  function renderRows() {
    tbody.replaceChildren();
    let ordered = [...networks];
    const column = columns.find(item => item.key === sortKey);
    if (column) {
      ordered.sort((a, b) => {
        const av = column.value(a);
        const bv = column.value(b);
        if (av == null) return bv == null ? 0 : 1;
        if (bv == null) return -1;
        const difference = typeof av === 'string' ? av.localeCompare(bv, undefined, { numeric: true }) : av - bv;
        return (descending ? -difference : difference) || a.network.localeCompare(b.network);
      });
    }
    for (const { th, button, column } of headers) {
      const selected = column.key === sortKey;
      th.setAttribute('aria-sort', selected ? descending ? 'descending' : 'ascending' : 'none');
      button.textContent = column.label + (selected ? descending ? ' ↓' : ' ↑' : ' ↕');
    }
    if (!ordered.length) {
      const cell = tbody.insertRow().insertCell();
      cell.colSpan = columns.length;
      cell.textContent = emptyLabel;
      return;
    }
    const extra = [];
    ordered.forEach((network, index) => {
      const row = tbody.insertRow();
      appendTextCell(row, network.network);
      appendTextCell(row, `${Number(network.voxelsInLesion) || 0}`, 'nd-numeric');
      appendPctCell(row, (Number(network.fractionOfLesion) || 0) * 100, colorForNetwork(network.network, colormap));
      if (networkSizes) {
        const size = networkSizes[network.network];
        appendTextCell(row, size > 0 ? `${(100 * network.voxelsInLesion / size).toFixed(1)}%` : '—', 'nd-numeric');
      }
      if (maxRows > 0 && index >= maxRows) {
        row.hidden = !expanded;
        row.className = 'overlap-row-extra';
        extra.push(row);
      }
    });
    if (extra.length) {
      const row = tbody.insertRow();
      row.className = 'overlap-fold-row';
      const cell = row.insertCell();
      cell.colSpan = columns.length;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'nd-btn nd-btn-secondary nd-btn-sm overlap-fold';
      const label = `${networks.length} labels`;
      const update = () => {
        button.textContent = expanded ? `Show first ${maxRows} of ${label}` : `Show all ${label}`;
        button.setAttribute('aria-expanded', String(expanded));
      };
      update();
      button.addEventListener('click', () => {
        expanded = !expanded;
        for (const hidden of extra) hidden.hidden = !expanded;
        update();
      });
      cell.appendChild(button);
    }
  }
  for (const column of columns) {
    const th = document.createElement('th');
    th.scope = 'col';
    if (column.key !== 'label') th.className = 'nd-numeric';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'nd-btn nd-btn-secondary nd-btn-sm';
    button.dataset.columnLabel = column.label;
    button.setAttribute('aria-label', `Sort by ${column.label}`);
    button.addEventListener('click', () => {
      descending = sortKey === column.key ? !descending : column.key !== 'label';
      sortKey = column.key;
      tableEl.dataset.sortKey = sortKey;
      tableEl.dataset.sortDirection = descending ? 'descending' : 'ascending';
      renderRows();
    });
    th.appendChild(button);
    headerRow.appendChild(th);
    headers.push({ th, button, column });
  }
  renderRows();
}
