// dicompare's acquisitions as tables: fields constant across an acquisition, then the
// fields that vary between its series with each series' value.
//
// ProtocolRow = { field, value, varies }

function fieldName(field) {
  return field.keyword || field.name || field.tag || '';
}

function valueText(value) {
  if (Array.isArray(value)) return value.map(valueText).join('\\');
  if (value === null || value === undefined) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

export function protocolRows(acquisition) {
  const rows = (acquisition.acquisitionFields ?? []).map((field) => ({ field: fieldName(field), value: valueText(field.value), varies: false }));
  const series = acquisition.series ?? [];
  const names = [...new Set(series.flatMap((entry) => (entry.fields ?? []).map(fieldName)))];
  for (const name of names) {
    const values = series.map((entry) => valueText(entry.fields?.find((field) => fieldName(field) === name)?.value));
    rows.push({ field: name, value: values.join(' / '), varies: true });
  }
  return rows;
}

export function acquisitionCaption(acquisition) {
  const parts = [acquisition.protocolName || 'Acquisition'];
  if (acquisition.series?.length) parts.push(`${acquisition.series.length} series`);
  if (acquisition.totalFiles) parts.push(`${acquisition.totalFiles} files`);
  return parts.join(' · ');
}

// The status line after a compliance check. results: ProtocolSession.check's, where an
// acquisition the worker could not check carries an error. Any such error fails the run.
export function checkOutcome(results, schemaName) {
  const failures = results.filter((result) => result.error);
  const count = `${results.length} acquisition${results.length === 1 ? '' : 's'}`;
  if (!failures.length) return { message: `${count} checked against ${schemaName}`, failed: false };
  const which = failures.length === results.length ? count : `${failures.length} of ${count}`;
  return { message: `${which} could not be checked against ${schemaName}: ${failures[0].error}`, failed: true };
}

// One table per acquisition, for the Protocol view.
export function protocolTables(acquisitions, doc) {
  return acquisitions.map((acquisition) => {
    const table = doc.createElement('table');
    table.className = 'nd-data-table';
    table.createCaption().textContent = acquisitionCaption(acquisition);
    const head = table.createTHead().insertRow();
    for (const label of ['Field', 'Value']) head.append(Object.assign(doc.createElement('th'), { textContent: label }));
    const body = table.createTBody();
    for (const row of protocolRows(acquisition)) {
      const tr = body.insertRow();
      if (row.varies) tr.dataset.flag = '';
      tr.insertCell().textContent = row.field;
      tr.insertCell().textContent = row.value;
    }
    const scroll = doc.createElement('div');
    scroll.className = 'nd-table-scroll';
    scroll.append(table);
    return scroll;
  });
}
