// Session-only clinical context. Never stored, transmitted or used by the models.
export function bindPatientBehavior(doc) {
  const notes = doc.getElementById('patientBehaviorNotes');
  const include = doc.getElementById('includePatientBehavior');
  const rows = doc.getElementById('patientBehaviorAssessments');
  const report = doc.getElementById('patientBehaviorReport');
  const body = doc.getElementById('patientBehaviorReportBody');
  if (!notes || !include || !rows || !report || !body) return null;
  let nextId = 0;

  function render() {
    body.replaceChildren();
    const assessments = [...rows.children].map(row => [...row.querySelectorAll('input')].map(input => input.value.trim()))
      .filter(values => values.some(Boolean));
    report.hidden = !include.checked || (!notes.value.trim() && !assessments.length);
    if (report.hidden) return;
    for (const text of notes.value.trim().split(/\n+/).filter(Boolean)) {
      const paragraph = doc.createElement('p');
      paragraph.textContent = text;
      body.appendChild(paragraph);
    }
    if (!assessments.length) return;
    const wrapper = doc.createElement('div');
    wrapper.className = 'nd-table-scroll';
    const table = doc.createElement('table');
    table.className = 'nd-data-table nd-table-right';
    const header = table.createTHead().insertRow();
    for (const label of ['Assessment', 'Score / result', 'Date']) {
      const cell = doc.createElement('th');
      cell.scope = 'col';
      cell.textContent = label;
      header.appendChild(cell);
    }
    const tbody = table.createTBody();
    for (const values of assessments) {
      const row = tbody.insertRow();
      for (const value of values) row.insertCell().textContent = value || '—';
    }
    wrapper.appendChild(table);
    body.appendChild(wrapper);
  }

  function addAssessment() {
    const row = doc.createElement('div');
    row.className = 'nd-section-content';
    const id = nextId++;
    for (const [key, label, type] of [['name', 'Assessment name', 'text'], ['result', 'Score / result', 'text'], ['date', 'Assessment date', 'date']]) {
      const field = doc.createElement('div');
      field.className = 'nd-field';
      const caption = doc.createElement('label');
      const input = doc.createElement('input');
      input.id = `patient-assessment-${id}-${key}`;
      input.type = type;
      if (type === 'text') input.maxLength = 500;
      caption.htmlFor = input.id;
      caption.textContent = label;
      field.append(caption, input);
      row.appendChild(field);
    }
    const remove = doc.createElement('button');
    remove.type = 'button';
    remove.className = 'nd-btn nd-btn-secondary nd-btn-sm';
    remove.textContent = 'Remove assessment';
    remove.addEventListener('click', () => {
      row.remove();
      doc.getElementById('addPatientAssessment').focus();
      render();
    });
    row.appendChild(remove);
    rows.appendChild(row);
  }
  const add = doc.getElementById('addPatientAssessment');
  add.addEventListener('click', () => {
    addAssessment();
    rows.lastElementChild.querySelector('input').focus();
  });
  for (const control of [notes, include, rows]) control.addEventListener('input', render);
  include.addEventListener('change', render);
  function reset() {
    notes.value = '';
    include.checked = true;
    rows.replaceChildren();
    addAssessment();
    render();
  }
  reset();
  return { reset, render };
}
