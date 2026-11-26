// Renders the VesselCharter quantitative morphometry report inside the shared
// section.nd-viewer-report view using only shared imaging-workspace.css classes.

function fmt(value, digits = 2, suffix = '') {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '—';
  }
  return `${value.toFixed(digits)}${suffix}`;
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, val] of Object.entries(props)) {
    if (key === 'className') {
      node.className = val;
    } else if (key === 'text') {
      node.textContent = val;
    } else if (key === 'dataset') {
      for (const [dk, dv] of Object.entries(val)) {
        node.dataset[dk] = dv;
      }
    } else if (key.startsWith('on') && typeof val === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), val);
    } else if (val !== undefined && val !== null) {
      node.setAttribute(key, String(val));
    }
  }
  for (const child of children) {
    if (child !== null && child !== undefined) {
      node.append(typeof child === 'string' ? document.createTextNode(child) : child);
    }
  }
  return node;
}

function makeTable(headers, rows) {
  const thead = el('thead', {}, [
    el(
      'tr',
      {},
      headers.map((h) => el('th', { text: h })),
    ),
  ]);
  const tbody = el('tbody', {}, rows);
  return el('div', { className: 'nd-table-scroll' }, [
    el('table', { className: 'nd-data-table' }, [thead, tbody]),
  ]);
}

export function renderVesselReport(container, reportData, { onJumpWorld } = {}) {
  container.replaceChildren();
  if (!reportData) {
    container.append(el('p', { className: 'nd-report-notes', text: 'Run characterisation to view vessel morphometry tables.' }));
    return;
  }

  const { summary, segments, junctions } = reportData;
  const inp = summary.input;
  const net = summary.network;

  // 1. Quality / resolution notes
  if (inp.assumedUnitsMm) {
    container.append(
      el('p', {
        className: 'nd-message info',
        text: `NIfTI spatial units were unset; header voxel spacing (${inp.voxelSpacingMm.map((v) => v.toFixed(3)).join(' × ')}) was interpreted in mm.`,
      }),
    );
  }
  if (net.resolutionLimitedLengthFraction > 0.25) {
    container.append(
      el('p', {
        className: 'nd-message warning',
        text: `${(net.resolutionLimitedLengthFraction * 100).toFixed(0)}% of vessel length has diameter below 2 × max spacing (${net.resolutionLimitMm.toFixed(2)} mm) and is flagged resolution-limited.`,
      }),
    );
  }

  // 2. Network summary table
  container.append(el('h3', { className: 'nd-report-heading', text: 'Network summary' }));
  const summaryPairs = [
    ['Vessel volume', `${fmt(net.vesselVolumeMm3, 2, ' mm³')} (${net.vesselVoxelCount.toLocaleString()} voxels)`],
    ['Total centerline length (smoothed)', `${fmt(net.totalLengthMm, 2, ' mm')} (raw ${fmt(net.totalRawLengthMm, 2, ' mm')})`],
    ['Segments', `${net.segmentCount} (pruned ${net.prunedSpurCount} spurs, ${fmt(net.prunedSpurLengthMm, 1, ' mm')})`],
    ['Junctions', `${net.junctionCount} (${net.bifurcationCount} bifurcations, ${net.multifurcationCount} degree ≥ 4)`],
    ['Endpoints', `${net.endpointCount} (${net.interiorEndpointCount} interior, ${net.fovEndpointCount} FOV-truncated)`],
    ['Connected components & loops', `${net.connectedComponentCount} components · ${net.cycleRankBetti1} closed loops (β₁)`],
    ['Median diameter (inscribed)', `${fmt(net.medianDiameterMm, 2, ' mm')} (IQR ${fmt(net.p25DiameterMm, 2)}–${fmt(net.p75DiameterMm, 2)} mm)`],
    ['Volume-equivalent diameter (D_eq)', `${fmt(net.medianEquivDiameterMm, 2, ' mm')} (mean ${fmt(net.meanEquivDiameterMm, 2, ' mm')})`],
    ['Tortuosity (DM / SOAM)', `DM ${fmt(net.medianDmTortuosity, 3)} (mean ${fmt(net.meanDmTortuosity, 3)}) · SOAM ${fmt(net.meanSoamRadPerMm, 3, ' rad/mm')}`],
    ['Mean bifurcation angle (daughter)', fmt(net.meanBifurcationAngleDeg, 1, '°')],
    ['Voxel spacing & anisotropy', `${inp.voxelSpacingMm.map((v) => v.toFixed(3)).join(' × ')} mm (ratio ${fmt(inp.anisotropyRatio, 2)}×)`],
  ];
  container.append(
    makeTable(
      ['Metric', 'Value'],
      summaryPairs.map(([label, val]) =>
        el('tr', {}, [el('td', { text: label }), el('td', { text: val })]),
      ),
    ),
  );

  // 3. Optional Brain / ROI Vascular Density
  if (summary.roi) {
    const r = summary.roi;
    container.append(el('h3', { className: 'nd-report-heading', text: 'Brain / ROI vascular density' }));
    const roiRows = [
      ['ROI volume', `${fmt(r.roiVolumeCm3, 2, ' cm³')} (${r.roiVoxelCount.toLocaleString()} voxels)`],
      ['Vessel volume inside ROI', `${fmt(r.roiVesselVolumeMm3, 2, ' mm³')}`],
      ['Vessel volume fraction', fmt(r.vesselVolumeFraction !== null ? r.vesselVolumeFraction * 100 : null, 3, '%')],
      ['Vessel length inside ROI', fmt(r.roiTotalLengthMm, 2, ' mm')],
      ['Vessel length density', fmt(r.vesselLengthDensityMmPerCm3, 2, ' mm/cm³')],
      ['Junction density', `${fmt(r.junctionDensityPerCm3, 2, ' /cm³')} (${r.roiJunctionCount} inside ROI)`],
      ['Endpoint density', `${fmt(r.endpointDensityPerCm3, 2, ' /cm³')} (${r.roiEndpointCount} inside ROI)`],
    ];
    container.append(
      makeTable(
        ['ROI metric', 'Value'],
        roiRows.map(([label, val]) =>
          el('tr', {}, [el('td', { text: label }), el('td', { text: val })]),
        ),
      ),
    );
  }

  // 4. Diameter-stratified bins
  container.append(el('h3', { className: 'nd-report-heading', text: 'Diameter-stratified distribution' }));
  container.append(
    makeTable(
      ['Diameter bin', 'Segments', 'Length (mm)', 'Length %', 'Volume (mm³)', 'Volume %', 'Mean DM', 'QC'],
      summary.diameterBins.map((b) =>
        el('tr', b.resolutionLimited ? { dataset: { flag: 'resolution' } } : {}, [
          el('td', { text: b.label }),
          el('td', { text: String(b.segmentCount) }),
          el('td', { text: fmt(b.totalLengthMm, 2) }),
          el('td', { text: fmt(b.lengthFraction * 100, 1, '%') }),
          el('td', { text: fmt(b.volumeMm3, 2) }),
          el('td', { text: fmt(b.volumeFraction * 100, 1, '%') }),
          el('td', { text: fmt(b.meanDmTortuosity, 3) }),
          el('td', { text: b.resolutionLimited ? 'resolution-limited' : 'resolved' }),
        ]),
      ),
    ),
  );

  // 5. Top segments table (sorted by length descending, capped at 200 rows in UI; full list in CSV).
  const sortedSegs = [...segments].sort((a, b) => b.lengthMm - a.lengthMm);
  const shownSegs = sortedSegs.slice(0, 200);
  container.append(
    el('h3', {
      className: 'nd-report-heading',
      text: `Vessel segments (${shownSegs.length}${segments.length > shownSegs.length ? ` of ${segments.length}` : ''})`,
    }),
  );
  if (onJumpWorld) {
    container.append(
      el('p', {
        className: 'nd-report-notes',
        text: 'Select a segment or junction row to centre the slice viewer on its world coordinates. Full tables are in the CSV downloads.',
      }),
    );
  }
  container.append(
    makeTable(
      ['ID', 'Type', 'Length (mm)', 'Diam (mm)', 'D_eq (mm)', 'DM', 'SOAM', 'Flags'],
      shownSegs.map((s) => {
        const flags = [];
        if (s.resolutionLimited) flags.push('res-limited');
        if (s.touchesFovBoundary) flags.push('FOV-edge');
        const tr = el(
          'tr',
          {
            ...(flags.length ? { dataset: { flag: flags[0] } } : {}),
            ...(onJumpWorld
              ? {
                  tabindex: '0',
                  onClick: () => onJumpWorld(s.midpointWorldMm, `Segment #${s.id}`),
                  onKeydown: (ev) => {
                    if (ev.key === 'Enter' || ev.key === ' ') {
                      ev.preventDefault();
                      onJumpWorld(s.midpointWorldMm, `Segment #${s.id}`);
                    }
                  },
                }
              : {}),
          },
          [
            el('td', { text: String(s.id) }),
            el('td', { text: s.kind }),
            el('td', { text: fmt(s.lengthMm, 2) }),
            el('td', { text: fmt(s.medianDiameterMm, 2) }),
            el('td', { text: fmt(s.equivDiameterMm, 2) }),
            el('td', { text: fmt(s.dmTortuosity, 3) }),
            el('td', { text: fmt(s.soamRadPerMm, 3) }),
            el('td', { text: flags.join(', ') || 'ok' }),
          ],
        );
        return tr;
      }),
    ),
  );

  // 6. Junctions table
  if (junctions.length > 0) {
    const shownJuncs = junctions.slice(0, 150);
    container.append(
      el('h3', {
        className: 'nd-report-heading',
        text: `Branching junctions (${shownJuncs.length}${junctions.length > shownJuncs.length ? ` of ${junctions.length}` : ''})`,
      }),
    );
    container.append(
      makeTable(
        ['ID', 'Degree', 'Radius (mm)', 'Min angle', 'Max angle', 'Daughter angle*', 'Murray ratio*'],
        shownJuncs.map((j) =>
          el(
            'tr',
            {
              ...(j.touchesFovBoundary ? { dataset: { flag: 'FOV-edge' } } : {}),
              ...(onJumpWorld
                ? {
                    tabindex: '0',
                    onClick: () => onJumpWorld(j.worldMm, `Junction #${j.id}`),
                    onKeydown: (ev) => {
                      if (ev.key === 'Enter' || ev.key === ' ') {
                        ev.preventDefault();
                        onJumpWorld(j.worldMm, `Junction #${j.id}`);
                      }
                    },
                  }
                : {}),
            },
            [
              el('td', { text: String(j.id) }),
              el('td', { text: String(j.degree) }),
              el('td', { text: fmt(j.radiusMm, 2) }),
              el('td', { text: fmt(j.minAngleDeg, 1, '°') }),
              el('td', { text: fmt(j.maxAngleDeg, 1, '°') }),
              el('td', { text: j.parentInferredFromCaliber ? fmt(j.daughterAngleDeg, 1, '°') : '—' }),
              el('td', { text: j.parentInferredFromCaliber ? fmt(j.murrayRatioCubed, 3) : '—' }),
            ],
          ),
        ),
      ),
    );
    container.append(
      el('p', {
        className: 'nd-report-notes',
        text: '* Daughter angle and Murray ratio are reported for degree-3 bifurcations only when one branch is at least 10% wider than the others (parent inferred from calibre; binary masks do not encode blood-flow direction).',
      }),
    );
  }
}
