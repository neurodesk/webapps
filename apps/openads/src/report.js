// Renders the OpenADS radiological report, JHU-ICBM atlas overlap, exact TreeSHAP attributions,
// and StrokeView 1,861-patient UMAP cohort explorer inside .nd-viewer-report.
import { createElement } from '@neurodesk/webapp-components/core';
import { downloadFile } from '@neurodesk/webapp-components/file-io';
import { formatRegionName, projectSubjectOntoCohort, cohortSummaryCsv } from '@neurodesk/openads';

function kpi(label, value) {
  return createElement('div', { className: 'openads-kpi' }, [
    createElement('span', { className: 'openads-kpi-label', text: label }),
    createElement('span', { className: 'openads-kpi-value', text: String(value) }),
  ]);
}

function rfTable(title, rows) {
  const wrap = createElement('div');
  wrap.append(createElement('h3', { className: 'openads-section-h', text: title }));
  const scroll = createElement('div', { className: 'nd-table-scroll' });
  const table = createElement('table', { className: 'nd-data-table' });
  table.append(
    createElement('thead', {}, [
      createElement('tr', {}, [
        createElement('th', { text: 'Region' }),
        createElement('th', { text: 'Prediction' }),
        createElement('th', { text: 'Probability' }),
        createElement('th', { text: 'Overlap (mL)' }),
      ]),
    ]),
  );
  const tbody = createElement('tbody');
  const sorted = [...rows].sort((a, b) => (b.probability ?? 0) - (a.probability ?? 0));
  for (const row of sorted) {
    const tr = createElement('tr', row.predict === 'AFFECTED' ? { 'data-flag': 'affected' } : {}, [
      createElement('td', { text: formatRegionName(row.region) }),
      createElement('td', { text: row.predict }),
      createElement('td', { text: row.probability == null ? 'N.A.' : `${(row.probability * 100).toFixed(1)}%` }),
      createElement('td', { text: row.volumeMl == null ? '—' : row.volumeMl.toFixed(2) }),
    ]);
    tbody.append(tr);
  }
  table.append(tbody);
  scroll.append(table);
  wrap.append(scroll);
  return wrap;
}

function overlapTable(title, rows) {
  const wrap = createElement('div');
  wrap.append(createElement('h3', { className: 'openads-section-h', text: title }));
  const hit = (rows || []).filter((r) => r.overlapVoxels > 0).sort((a, b) => b.probability - a.probability);
  if (!hit.length) {
    wrap.append(createElement('p', { className: 'nd-hint', text: 'No overlap in this atlas.' }));
    return wrap;
  }
  const scroll = createElement('div', { className: 'nd-table-scroll' });
  const table = createElement('table', { className: 'nd-data-table' });
  table.append(
    createElement('thead', {}, [
      createElement('tr', {}, [
        createElement('th', { text: 'Region' }),
        createElement('th', { text: 'Overlap (vox)' }),
        createElement('th', { text: 'Atlas (vox)' }),
        createElement('th', { text: 'Injured %' }),
      ]),
    ]),
  );
  const tbody = createElement('tbody');
  for (const r of hit.slice(0, 30)) {
    tbody.append(
      createElement('tr', {}, [
        createElement('td', { text: r.region }),
        createElement('td', { text: r.overlapVoxels.toLocaleString() }),
        createElement('td', { text: Math.round(r.regionTotalVoxels).toLocaleString() }),
        createElement('td', { text: `${(r.probability * 100).toFixed(1)}%` }),
      ]),
    );
  }
  table.append(tbody);
  scroll.append(table);
  wrap.append(scroll);
  return wrap;
}

function renderSummaryTab(container, data) {
  const { report, volumes, icvMl, interpretation, hydrocephalus, mismatch, downloads } = data;
  const kpis = createElement('div', { className: 'openads-kpis' }, [
    kpi('Lesion volume', `${volumes.totalMl.toFixed(2)} mL`),
    kpi('Left / Right', `${volumes.leftMl.toFixed(1)} / ${volumes.rightMl.toFixed(1)} mL`),
    kpi('Lesion / ICV', icvMl != null && icvMl > 0 ? `${((volumes.totalMl / icvMl) * 100).toFixed(2)}%` : 'N.A.'),
    kpi('MCA ASPECTS', report.aspectsScore != null ? `${report.aspectsScore} / 10` : 'N.A.'),
    kpi('Hydrocephalus', hydrocephalus ? `${hydrocephalus.predict} (${(hydrocephalus.probability * 100).toFixed(0)}%)` : 'N.A.'),
  ]);
  if (mismatch) {
    kpis.append(
      kpi('Hypoperfusion', `${mismatch.hpMl.toFixed(2)} mL`),
      kpi('Mismatch', `${mismatch.mismatchVolumeMl.toFixed(2)} mL${mismatch.mismatchRatio != null ? ` (${mismatch.mismatchRatio.toFixed(2)}×)` : ''}`),
    );
  }
  container.append(kpis);
  container.append(
    createElement('p', {
      className: 'nd-report-notes',
      text: 'Research use only — automated predictions are not clinical diagnostic reports.',
    }),
  );

  const tablesGrid = createElement('div', { className: 'openads-grid-2' }, [
    rfTable('Arterial territories (RF)', interpretation.vascular || []),
    rfTable('Anatomical structures (RF)', interpretation.lobe || []),
  ]);
  container.append(tablesGrid);
  container.append(rfTable('MCA ASPECTS regions (RF)', interpretation.aspects || []));

  container.append(createElement('h3', { className: 'openads-section-h', text: 'Automatic radiological report' }));
  container.append(createElement('pre', { className: 'openads-pre', text: report.text }));

  const actions = createElement('div', { className: 'openads-actions' });
  const copyBtn = createElement('button', { type: 'button', className: 'nd-btn nd-btn-secondary nd-btn-sm', text: 'Copy report' });
  copyBtn.onclick = () => navigator.clipboard?.writeText(report.text);
  actions.append(copyBtn);
  for (const item of downloads || []) {
    const btn = createElement('button', { type: 'button', className: 'nd-btn nd-btn-secondary nd-btn-sm', text: `Download ${item.label}` });
    btn.onclick = () => downloadFile(item.file);
    actions.append(btn);
  }
  container.append(actions);
}

function renderShapTab(container, data) {
  const { atlasStats, shap } = data;
  const shapSection = createElement('div');
  shapSection.append(createElement('h3', { className: 'openads-section-h', text: 'TreeSHAP feature attributions' }));
  const atlasKeys = Object.keys(shap || {}).filter((k) => Array.isArray(shap[k]) && shap[k].length);
  if (!atlasKeys.length) {
    shapSection.append(createElement('p', { className: 'nd-hint', text: 'Enable TreeSHAP in Advanced settings to inspect per-ROI attributions.' }));
  } else {
    const controls = createElement('div', { className: 'nd-report-form openads-grid-2' });
    const atlasSelect = createElement('select', { 'aria-label': 'SHAP atlas' });
    for (const key of atlasKeys) {
      atlasSelect.append(createElement('option', { value: key, text: key.toUpperCase() }));
    }
    const roiSelect = createElement('select', { 'aria-label': 'SHAP region' });
    controls.append(
      createElement('div', { className: 'nd-field' }, [createElement('label', { text: 'Atlas' }), atlasSelect]),
      createElement('div', { className: 'nd-field' }, [createElement('label', { text: 'Predicted ROI' }), roiSelect]),
    );
    const chartBox = createElement('div');

    const renderRoi = () => {
      const list = shap[atlasSelect.value] || [];
      const item = list.find((entry) => entry.roi === roiSelect.value) || list[0];
      chartBox.replaceChildren();
      if (!item || !item.attributions?.length) {
        chartBox.append(createElement('p', { className: 'nd-hint', text: 'No forest attributions for this ROI.' }));
        return;
      }
      const maxAbs = Math.max(1e-4, ...item.attributions.map((a) => Math.abs(a.attribution)));
      const scroll = createElement('div', { className: 'nd-table-scroll' });
      const table = createElement('table', { className: 'nd-data-table' });
      table.append(
        createElement('thead', {}, [
          createElement('tr', {}, [
            createElement('th', { text: 'Feature' }),
            createElement('th', { text: 'QFV' }),
            createElement('th', { text: 'SHAP (+ → affected)' }),
            createElement('th', { text: 'Magnitude' }),
          ]),
        ]),
      );
      const tbody = createElement('tbody');
      for (const attr of item.attributions.slice(0, 10)) {
        const pct = Math.min(100, (Math.abs(attr.attribution) / maxAbs) * 100);
        const fill = createElement('span', {
          className: attr.attribution >= 0 ? 'openads-bar-pos' : 'openads-bar-neg',
        });
        fill.style.width = `${pct.toFixed(1)}%`;
        const bar = createElement('span', { className: 'openads-bar-track' }, [fill]);
        tbody.append(
          createElement('tr', {}, [
            createElement('td', { text: formatRegionName(attr.feature) }),
            createElement('td', { text: attr.value.toFixed(4) }),
            createElement('td', { text: `${attr.attribution >= 0 ? '+' : ''}${attr.attribution.toFixed(4)}` }),
            createElement('td', {}, [bar]),
          ]),
        );
      }
      table.append(tbody);
      scroll.append(table);
      chartBox.append(scroll);
    };

    const populateRois = () => {
      const list = shap[atlasSelect.value] || [];
      const sorted = [...list].sort((a, b) => (b.probability ?? 0) - (a.probability ?? 0));
      roiSelect.replaceChildren(
        ...sorted.map((item) =>
          createElement('option', {
            value: item.roi,
            text: `${formatRegionName(item.roi)} (${item.predictedAffected ? 'AFFECTED' : 'normal'}${item.probability != null ? `, ${(item.probability * 100).toFixed(0)}%` : ''})`,
          }),
        ),
      );
      renderRoi();
    };
    atlasSelect.onchange = populateRois;
    roiSelect.onchange = renderRoi;
    populateRois();
    shapSection.append(controls, chartBox);
  }
  container.append(shapSection);

  const grid = createElement('div', { className: 'openads-grid-2' }, [
    overlapTable('Arterial territory overlap', atlasStats.vascular),
    overlapTable('Lobe / structure overlap', atlasStats.lobe),
    overlapTable('MCA ASPECTS overlap', atlasStats.aspects),
    overlapTable('Posterior-circulation ASPECTS overlap', atlasStats.aspectpc),
  ]);
  container.append(grid);
}

function buildUmapSvg(refData, projection) {
  const ns = 'http://www.w3.org/2000/svg';
  const W = 640;
  const H = 340;
  const pad = 28;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of refData.points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const rx = maxX - minX || 1;
  const ry = maxY - minY || 1;
  const sx = (x) => pad + ((x - minX) / rx) * (W - 2 * pad);
  const sy = (y) => H - pad - ((y - minY) / ry) * (H - 2 * pad);

  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'openads-umap-svg');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `${refData.title} scatter plot of ${refData.points.length} reference stroke cases and the current subject`);

  const nnSet = new Set(projection.neighbors.map((n) => `${n.x.toFixed(4)},${n.y.toFixed(4)}`));
  for (const p of refData.points) {
    const circle = document.createElementNS(ns, 'circle');
    circle.setAttribute('cx', sx(p.x).toFixed(1));
    circle.setAttribute('cy', sy(p.y).toFixed(1));
    const isNN = nnSet.has(`${p.x.toFixed(4)},${p.y.toFixed(4)}`);
    circle.setAttribute('r', isNN ? '3.2' : '2.1');
    circle.setAttribute('class', isNN ? 'openads-umap-nn' : 'openads-umap-dot');
    const title = document.createElementNS(ns, 'title');
    title.textContent = `${p.ColorLabel || 'Unknown'} — ${String(p.HoverText || '').replace(/<br\s*\/?>/gi, ' · ')}`;
    circle.append(title);
    svg.append(circle);
  }

  // Current patient star marker
  const cx = sx(projection.position.x);
  const cy = sy(projection.position.y);
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const angle = (Math.PI / 5) * i - Math.PI / 2;
    const rad = i % 2 === 0 ? 9 : 4;
    pts.push(`${(cx + rad * Math.cos(angle)).toFixed(1)},${(cy + rad * Math.sin(angle)).toFixed(1)}`);
  }
  const star = document.createElementNS(ns, 'polygon');
  star.setAttribute('points', pts.join(' '));
  star.setAttribute('class', 'openads-umap-self');
  const selfTitle = document.createElementNS(ns, 'title');
  selfTitle.textContent = `Current subject (${projection.dominantLabel})`;
  star.append(selfTitle);
  svg.append(star);

  return svg;
}

function renderCohortTab(container, data) {
  const { cohortRefs, qfv, defaultK = 50, subjectId } = data;
  if (!cohortRefs || (!cohortRefs.lobe && !cohortRefs.vas)) {
    container.append(createElement('p', { className: 'nd-hint', text: 'StrokeView cohort reference data is unavailable.' }));
    return;
  }

  let activeModel = cohortRefs.lobe ? 'lobe' : 'vas';
  let kVal = defaultK;

  const controls = createElement('div', { className: 'nd-report-form openads-grid-2' });
  const modelSelect = createElement('select', { 'aria-label': 'StrokeView cohort space' }, [
    ...(cohortRefs.lobe ? [createElement('option', { value: 'lobe', text: 'Lobe QFV UMAP (N = 1,861)' })] : []),
    ...(cohortRefs.vas ? [createElement('option', { value: 'vas', text: 'Vascular QFV UMAP (N = 1,861)' })] : []),
  ]);
  const kInput = createElement('input', { type: 'number', min: '10', max: '250', step: '5', value: String(kVal), 'aria-label': 'Nearest neighbors' });
  const dlBtn = createElement('button', { type: 'button', className: 'nd-btn nd-btn-secondary nd-btn-sm', text: 'Download summary CSV' });
  controls.append(
    createElement('div', { className: 'nd-field' }, [createElement('label', { text: 'Cohort embedding' }), modelSelect]),
    createElement('div', { className: 'nd-field' }, [createElement('label', { text: 'Nearest neighbors (k)' }), kInput]),
    dlBtn,
  );

  const body = createElement('div');
  let latestProjection = null;

  const draw = () => {
    const refData = cohortRefs[activeModel];
    const qfvObj = activeModel === 'lobe' ? qfv.lobe?.byRegion : qfv.vascular?.byRegion;
    latestProjection = projectSubjectOntoCohort({ qfvByRegion: qfvObj, refData, kNeighbors: kVal });
    body.replaceChildren();

    const umapBox = createElement('div', { className: 'openads-umap-wrap' }, [
      createElement('p', {
        className: 'nd-hint',
        text: `Star = current subject (${latestProjection.dominantLabel}). Highlighted dots = ${latestProjection.neighbors.length} nearest StrokeFAIR cases.`,
      }),
      buildUmapSvg(refData, latestProjection),
    ]);
    body.append(umapBox);

    const summaryScroll = createElement('div', { className: 'nd-table-scroll' });
    const summaryTable = createElement('table', { className: 'nd-data-table' });
    summaryTable.append(
      createElement('thead', {}, [
        createElement('tr', {}, [
          createElement('th', { text: `Clinical phenotype (${latestProjection.summary.count} nearest cases)` }),
          createElement('th', { text: 'Mean (SD) or Count (%)' }),
          createElement('th', { text: 'N' }),
        ]),
      ]),
    );
    const stbody = createElement('tbody');
    for (const c of latestProjection.summary.continuous) {
      stbody.append(
        createElement('tr', {}, [
          createElement('td', { text: c.label }),
          createElement('td', { text: `${c.mean.toFixed(1)} (${c.sd.toFixed(1)})` }),
          createElement('td', { text: String(c.n) }),
        ]),
      );
    }
    for (const g of latestProjection.summary.categorical) {
      for (const entry of g.entries) {
        stbody.append(
          createElement('tr', {}, [
            createElement('td', { text: `${g.label}: ${entry.value}` }),
            createElement('td', { text: `${entry.count} (${entry.percent.toFixed(0)}%)` }),
            createElement('td', { text: String(g.n) }),
          ]),
        );
      }
    }
    summaryTable.append(stbody);
    summaryScroll.append(summaryTable);
    body.append(summaryScroll);

    body.append(createElement('h3', { className: 'openads-section-h', text: 'Closest reference cases' }));
    const nnScroll = createElement('div', { className: 'nd-table-scroll' });
    const nnTable = createElement('table', { className: 'nd-data-table' });
    nnTable.append(
      createElement('thead', {}, [
        createElement('tr', {}, [
          createElement('th', { text: '#' }),
          createElement('th', { text: 'Primary region' }),
          createElement('th', { text: 'Distance' }),
          createElement('th', { text: 'Age' }),
          createElement('th', { text: 'NIHSS' }),
          createElement('th', { text: '90d mRS' }),
          createElement('th', { text: 'Side' }),
        ]),
      ]),
    );
    const nntbody = createElement('tbody');
    for (const n of latestProjection.neighbors.slice(0, 15)) {
      nntbody.append(
        createElement('tr', {}, [
          createElement('td', { text: String(n.rank) }),
          createElement('td', { text: n.colorLabel }),
          createElement('td', { text: n.distance.toFixed(3) }),
          createElement('td', { text: n.phenotype?.Age != null ? String(n.phenotype.Age) : '—' }),
          createElement('td', { text: n.phenotype?.NIHSS != null ? String(n.phenotype.NIHSS) : '—' }),
          createElement('td', { text: n.phenotype?.['90days-mRS'] != null ? String(n.phenotype['90days-mRS']) : '—' }),
          createElement('td', { text: n.phenotype?.Side || '—' }),
        ]),
      );
    }
    nnTable.append(nntbody);
    nnScroll.append(nnTable);
    body.append(nnScroll);
  };

  modelSelect.onchange = () => {
    activeModel = modelSelect.value;
    draw();
  };
  kInput.onchange = () => {
    const parsed = parseInt(kInput.value, 10);
    kVal = Number.isFinite(parsed) ? Math.max(10, Math.min(250, parsed)) : 50;
    kInput.value = String(kVal);
    draw();
  };
  dlBtn.onclick = () => {
    if (!latestProjection) return;
    const csv = cohortSummaryCsv(latestProjection.summary);
    downloadFile(new File([csv], `${subjectId}_strokeview_${activeModel}_neighbors.csv`, { type: 'text/csv' }));
  };

  container.append(controls, body);
  draw();
}

export function renderReportView(root, data) {
  root.replaceChildren();
  if (!data) {
    root.append(createElement('p', { className: 'nd-hint', text: 'Run OpenADS analysis to populate the radiological report, TreeSHAP attributions and StrokeView cohort.' }));
    return;
  }

  let activeTab = 'summary';
  const nav = createElement('div', { className: 'nd-report-controls' });
  const tabGroup = createElement('div', { className: 'nd-view-tabs', role: 'group', 'aria-label': 'Report sections' });
  nav.append(tabGroup);
  const tabs = [
    { id: 'summary', label: 'Radiological report' },
    { id: 'shap', label: 'Atlases & TreeSHAP' },
    { id: 'cohort', label: 'StrokeView cohort (UMAP)' },
  ];
  const buttons = {};
  const panel = createElement('div', { className: 'openads-panel' });

  const show = (id) => {
    activeTab = id;
    for (const [tid, btn] of Object.entries(buttons)) {
      const isActive = tid === id;
      btn.setAttribute('aria-pressed', String(isActive));
      btn.classList.toggle('active', isActive);
    }
    panel.replaceChildren();
    if (id === 'summary') renderSummaryTab(panel, data);
    else if (id === 'shap') renderShapTab(panel, data);
    else renderCohortTab(panel, data);
  };

  for (const tab of tabs) {
    const btn = createElement('button', {
      type: 'button',
      className: `nd-view-tab${tab.id === activeTab ? ' active' : ''}`,
      text: tab.label,
      'aria-pressed': String(tab.id === activeTab),
    });
    btn.onclick = () => show(tab.id);
    buttons[tab.id] = btn;
    tabGroup.append(btn);
  }

  root.append(nav, panel);
  show('summary');
}
