import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, '..', 'test', 'fixtures');
const SHARED_THEME = join(here, '..', '..', '..', 'site', 'app-theme.css');

const errors = [];

test.beforeEach(async ({ page }) => {
  errors.length = 0;
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('./');
  // Every test below drives the app itself; the start page is covered on its own.
  await page.locator('#enterAppButton').click();
});

async function loadSurface(page) {
  await page.setInputFiles('#surfaceInput', join(FIXTURES, 'lh.pial'));
  await expect(page.locator('#statusText')).toContainText('163,842 vertices', { timeout: 90_000 });
}

test('the shell mounts with the shared workspace and a link back to the catalog', async ({ page }) => {
  await expect(page.locator('#controls')).toBeVisible();
  // #gl, not "#viewer canvas": the colour legend puts a second canvas in there.
  await expect(page.locator('#gl')).toBeVisible();
  // Required of every app in the composite site. Scoped to the shell: the start
  // page carries its own copy of the link, so the page has two.
  const moreApps = page.locator('#app [title="More Neurodesk web apps"]');
  await expect(moreApps).toHaveCount(1);
  await expect(moreApps).toHaveAttribute('href', '../');
});

test('the workspace uses the Neurodesk palette and accessible custom upload controls', async ({ page }) => {
  await expect(page.locator('.workflow-panel')).toHaveCount(5);
  await expect(page.locator('.upload-visual')).toHaveCount(2);

  const design = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const header = getComputedStyle(document.querySelector('.nd-imaging-app-header'));
    const viewerHint = getComputedStyle(document.querySelector('.drop-hint'));
    const fileInput = document.getElementById('surfaceInput');
    const fileStyle = getComputedStyle(fileInput);
    return {
      primary: root.getPropertyValue('--nd-brand-primary').trim(),
      menu: root.getPropertyValue('--nd-brand-menu').trim(),
      headerBackground: header.backgroundColor,
      headerText: header.color,
      viewerHintText: viewerHint.color,
      fileInputWidth: fileInput.getBoundingClientRect().width,
      fileInputClip: fileStyle.clipPath
    };
  });

  expect(design.primary).toBe('#6aa329');
  expect(design.menu).toBe('#0c0e0a');
  expect(design.headerBackground).toBe('rgb(12, 14, 10)');
  expect(design.headerText).toBe('rgb(255, 255, 255)');
  expect(design.viewerHintText).toBe('rgb(255, 255, 255)');
  expect(design.fileInputWidth).toBeLessThanOrEqual(1);
  expect(design.fileInputClip).toBe('inset(50%)');

  // The styled label remains a native file-input activation target.
  await expect(page.locator('#surfaceInput')).toBeEnabled();
  await expect(page.locator('#overlayInput')).toBeDisabled();
});

test('the hosted dark theme keeps upload states and information links readable', async ({ page }) => {
  await page.addStyleTag({ path: SHARED_THEME });
  await page.evaluate(() => {
    document.documentElement.dataset.neurodeskApp = 'surfannotate';
    document.documentElement.dataset.neurodeskTheme = 'dark';

    const dialog = document.createElement('dialog');
    dialog.className = 'nd-app-dialog';
    dialog.innerHTML = `
      <div class="nd-app-dialog__panel">
        <h2>About SurfAnnotate</h2>
        <p>SurfAnnotate runs entirely in your browser.</p>
        <a class="nd-app-bar__action nd-app-dialog__source" href="#source">
          View source on GitHub
        </a>
      </div>
    `;
    document.body.append(dialog);
  });
  // The upload control intentionally animates theme colour changes.
  await page.waitForTimeout(500);

  const colours = await page.evaluate(() => {
    const colour = (selector) => getComputedStyle(document.querySelector(selector)).color;
    const background = (selector) => getComputedStyle(document.querySelector(selector)).backgroundColor;
    return {
      enabledUploadText: colour('#surfaceInput + .upload-visual'),
      enabledUploadBackground: background('#surfaceInput + .upload-visual'),
      disabledUploadText: colour('#overlayInput + .upload-visual'),
      disabledUploadBackground: background('#overlayInput + .upload-visual'),
      disabledUploadActionText: colour('#overlayInput + .upload-visual .upload-action'),
      disabledUploadActionBackground: background('#overlayInput + .upload-visual .upload-action'),
      viewerDropTitle: colour('.drop-hint strong'),
      startStepNumber: colour('.start-step-number'),
      startFooterLink: colour('.start-footer a'),
      citationSectionHeading: colour('.cite-section h4'),
      citationLink: colour('.cite-item a'),
      citationClose: colour('.cite-close'),
      informationLink: colour('.nd-app-dialog__source'),
      informationBackground: background('.nd-app-dialog')
    };
  });

  expect(colours).toEqual({
    enabledUploadText: 'rgb(232, 245, 208)',
    enabledUploadBackground: 'rgb(16, 20, 13)',
    disabledUploadText: 'rgb(156, 163, 175)',
    disabledUploadBackground: 'rgb(31, 46, 24)',
    disabledUploadActionText: 'rgb(156, 163, 175)',
    disabledUploadActionBackground: 'rgb(16, 20, 13)',
    viewerDropTitle: 'rgb(232, 245, 208)',
    startStepNumber: 'rgb(232, 245, 208)',
    startFooterLink: 'rgb(196, 227, 130)',
    citationSectionHeading: 'rgb(196, 227, 130)',
    citationLink: 'rgb(196, 227, 130)',
    citationClose: 'rgb(196, 227, 130)',
    informationLink: 'rgb(196, 227, 130)',
    informationBackground: 'rgb(22, 26, 14)'
  });
});

test('the empty canvas shows no phantom loading text', async ({ page }) => {
  // NiiVue paints "loading ..." over an empty canvas unless the option is cleared.
  expect(await page.evaluate(() => window.__surfannotate.nv.opts.loadingText)).toBe('');
});

test('WebGL2 is available and NiiVue attaches', async ({ page }) => {
  const info = await page.evaluate(() => {
    const gl = document.getElementById('gl').getContext('webgl2');
    return { hasContext: Boolean(gl), attached: Boolean(window.__surfannotate?.nv) };
  });
  expect(info.hasContext).toBe(true);
  expect(info.attached).toBe(true);
});

test('a FreeSurfer surface loads and is indexed', async ({ page }) => {
  await loadSurface(page);

  const geometry = await page.evaluate(() => {
    const s = window.__surfannotate;
    return {
      vertices: s.geometry.vertexCount,
      triangles: s.geometry.triangles.length / 3,
      graphVertices: s.graph.V,
      meanValence: s.graph.adjNeighbor.length / s.graph.V,
      hasIndex: Boolean(s.index),
      hasLayer: s.mesh.layers.length > 0
    };
  });

  expect(geometry.vertices).toBe(163842);
  expect(geometry.triangles).toBe(327680);
  expect(geometry.graphVertices).toBe(163842);
  expect(geometry.meanValence).toBeCloseTo(6, 1);
  expect(geometry.hasIndex).toBe(true);
  expect(geometry.hasLayer).toBe(true);
  expect(errors).toEqual([]);
});

test('clicking the rendered surface resolves to a vertex', async ({ page }) => {
  await loadSurface(page);

  // Drive NiiVue's depth picker the way the app does, at the centre of the canvas.
  const hit = await page.evaluate(() => {
    const s = window.__surfannotate;
    const canvas = document.getElementById('gl');
    const rect = canvas.getBoundingClientRect();
    const dpr = s.nv.uiData?.dpr || 1;

    s.nv.mousePos = [(rect.width / 2) * dpr, (rect.height / 2) * dpr];
    s.nv.uiData.mouseDepthPicker = true;
    s.nv.drawScene();
    s.nv.drawScene();

    const mm = s.nv.frac2mm(s.nv.scene.crosshairPos, 0, true);
    const near = s.index.nearest(mm[0], mm[1], mm[2]);
    return { mm: [mm[0], mm[1], mm[2]], vertex: near.vertex, distance: near.distance };
  });

  expect(hit.vertex).toBeGreaterThanOrEqual(0);
  expect(hit.vertex).toBeLessThan(163842);
  // A real hit lands within a fraction of a millimetre of a vertex.
  expect(hit.distance).toBeLessThan(3);
});

test('draw, close and fill a closed ROI, then export it', async ({ page }) => {
  await loadSurface(page);

  const result = await page.evaluate(async () => {
    const s = window.__surfannotate;
    const { graph, session } = s;

    // Walk a ring of vertices roughly 12 edges apart to stand in for clicks.
    const step = (from, hops) => {
      let frontier = [from];
      const seen = new Uint8Array(graph.V);
      seen[from] = 1;
      for (let h = 0; h < hops; h++) {
        const next = [];
        for (const u of frontier) {
          for (let e = graph.adjOffset[u]; e < graph.adjOffset[u + 1]; e++) {
            const w = graph.adjNeighbor[e];
            if (!seen[w]) { seen[w] = 1; next.push(w); }
          }
        }
        if (!next.length) break;
        frontier = next;
      }
      return frontier[0];
    };

    let v = 60000;
    for (let i = 0; i < 8; i++) { session.addClick(v); v = step(v, 10); }
    // Nothing is traced until the ROI is closed.
    const chainBeforeClose = session.chain.length;
    const closed = session.closePath();
    const filled = session.fill({});

    return {
      clicks: session.clicks.length,
      chainBeforeClose,
      closed: closed.ok,
      chainLength: session.chain.length,
      gaps: session.gaps.length,
      fill: filled
    };
  });

  expect(result.clicks).toBe(8);
  expect(result.chainBeforeClose).toBe(0);
  expect(result.closed).toBe(true);
  expect(result.gaps).toBe(0);
  expect(result.chainLength).toBeGreaterThan(20);
  expect(result.fill.ok).toBe(true);
  expect(result.fill.count).toBeGreaterThan(0);

  // The boundary chain must stay walkable along mesh edges, or the fill leaks.
  const contiguous = await page.evaluate(() => {
    const { graph, session } = window.__surfannotate;
    for (let i = 0; i < session.chain.length - 1; i++) {
      const a = session.chain[i], b = session.chain[i + 1];
      let ok = false;
      for (let e = graph.adjOffset[a]; e < graph.adjOffset[a + 1]; e++) {
        if (graph.adjNeighbor[e] === b) { ok = true; break; }
      }
      if (!ok) return false;
    }
    return true;
  });
  expect(contiguous).toBe(true);

  // Exported .label must carry the documented header and one line per vertex.
  const label = await page.evaluate(() => {
    const { session, geometry } = window.__surfannotate;
    return window.__surfannotateIo.writeFreeSurferLabel(
      session.regionIndices(), geometry.positions, { name: 'e2e', subject: 'lh' }
    );
  });

  const lines = label.trimEnd().split('\n');
  expect(lines[0]).toContain('#!ascii label e2e');
  expect(Number(lines[1])).toBe(lines.length - 2);
  expect(Number(lines[2].split(/\s+/)[0])).toBeGreaterThanOrEqual(0);

  // And the GIfTI export must be well-formed XML with the label table first.
  const gifti = await page.evaluate(async () => {
    const { session, geometry } = window.__surfannotate;
    const mask = session.filled || new Uint8Array(geometry.vertexCount);
    return window.__surfannotateIo.writeGiftiLabel(
      window.__surfannotateIo.maskToLabelArray(mask, 2),
      [{ key: 0, name: '???', rgba: [0, 0, 0, 0] },
        { key: 2, name: 'roi', rgba: [0.9, 0.2, 0.2, 1] }]
    );
  });
  expect(gifti).toContain('Intent="NIFTI_INTENT_LABEL"');
  expect(gifti.indexOf('<LabelTable>')).toBeLessThan(gifti.indexOf('<DataArray'));
});

test('a gap in the boundary is refused rather than flooding the surface', async ({ page }) => {
  await loadSurface(page);

  const outcome = await page.evaluate(() => {
    const { graph, session, geometry } = window.__surfannotate;
    session.clearRoi();

    // Build a closed ring, then punch a hole in it.
    let v = 40000;
    const step = (from) => graph.adjNeighbor[graph.adjOffset[from]];
    for (let i = 0; i < 6; i++) { session.addClick(v); for (let k = 0; k < 9; k++) v = step(v); }
    session.closePath();

    const barrier = session.boundaryMask();
    barrier[session.chain[3]] = 0; // the gap

    // Seeded fill from a vertex far from the ring must report an escape.
    const seeded = session.fill({ seed: -1 });
    return { chain: session.chain.length, error: seeded.error, ok: seeded.ok };
  });

  expect(outcome.chain).toBeGreaterThan(0);
  // Either it filled a legitimate small region, or it refused. It must never
  // silently return most of the hemisphere.
  if (outcome.ok) {
    const count = await page.evaluate(() => {
      let n = 0;
      const f = window.__surfannotate.session.filled;
      for (let i = 0; i < f.length; i++) if (f[i]) n++;
      return n;
    });
    expect(count).toBeLessThan(163842 * 0.4);
  } else {
    expect(['AMBIGUOUS_REGION', 'FILL_ESCAPED', 'EMPTY_REGION']).toContain(outcome.error);
  }
});

test('landmark selection toggles and exports', async ({ page }) => {
  await loadSurface(page);

  const result = await page.evaluate(() => {
    const { session, geometry } = window.__surfannotate;
    session.setMode('points');
    session.togglePoint(1000, 'V1');
    session.togglePoint(2000, 'MT');
    session.togglePoint(1000); // toggling the same vertex removes it

    const json = window.__surfannotateIo.writePointsJson(session.points, geometry.positions, {
      numVertices: geometry.vertexCount,
      numTriangles: geometry.triangles.length / 3
    });
    return { count: session.points.length, json: JSON.parse(json) };
  });

  expect(result.count).toBe(1);
  expect(result.json.points[0].vertex).toBe(2000);
  expect(result.json.points[0].name).toBe('MT');
  expect(result.json.mesh.numVertices).toBe(163842);
});

test('dragging to rotate does not place a landmark', async ({ page }) => {
  await loadSurface(page);
  await page.evaluate(() => window.__surfannotateUi.setMode('points'));

  const box = await page.locator('#gl').boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // A press that travels is an orbit, not a click.
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(cx + i * 8, cy + i * 3);
  await page.mouse.up();
  expect(await page.evaluate(() => window.__surfannotate.session.points.length)).toBe(0);

  // A press that stays put is a click.
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.up();
  await expect
    .poll(() => page.evaluate(() => window.__surfannotate.session.points.length))
    .toBe(1);
});

test('a curvature overlay loads with a usable display window', async ({ page }) => {
  await loadSurface(page);
  await page.setInputFiles('#overlayInput', join(FIXTURES, 'lh.curv'));
  await expect(page.locator('#statusText')).toContainText('Overlay lh.curv loaded', {
    timeout: 60_000
  });

  const layer = await page.evaluate(() => {
    const overlay = window.__surfannotate.overlayLayer;
    return {
      values: overlay.values.length,
      calMin: overlay.cal_min,
      calMax: overlay.cal_max,
      opacity: overlay.opacity
    };
  });

  expect(layer.values).toBe(163842);
  expect(layer.opacity).toBeGreaterThan(0);
  // A full-range window maps nearly every vertex to the same mid-grey, which
  // reads as "the overlay did not load". The robust window must be narrower.
  expect(layer.calMax - layer.calMin).toBeLessThan(0.9);
  expect(layer.calMax).toBeGreaterThan(layer.calMin);
  expect(errors).toEqual([]);
});

test('border markers are drawn on the overlay, survive a fill, and are culled when facing away', async ({ page }) => {
  await loadSurface(page);

  // Painted pixels on the marker canvas, not label values on the mesh: the
  // markers are no longer on the surface at all.
  const countMarkers = () => page.evaluate(() => {
    window.__surfannotateUi.renderMarkers();
    const canvas = document.getElementById('markerOverlay');
    const { data } = canvas.getContext('2d')
      .getImageData(0, 0, canvas.width, canvas.height);
    let painted = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) painted++;
    return painted;
  });

  // A real press in the middle of the brain, not a synthesised addClick. This
  // is the assertion that matters: the depth picker returns the FRONT-MOST
  // surface point, so the vertex it hands back necessarily faces the camera and
  // its marker must be drawn. An earlier version of this test hunted through
  // azimuths for one that painted something, which an inverted facing test
  // satisfies just as well by finding the opposite view — it passed against a
  // build where clicking drew nothing at all.
  const canvas = await page.locator('#gl').boundingBox();
  await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  await expect(page.locator('#statusText')).toContainText('1 point(s) on the border.');

  const clicked = await countMarkers();
  expect(clicked).toBeGreaterThan(0);

  // Where the pointer was, give or take the marker's own radius — a marker
  // painted somewhere else entirely would still pass a plain "is anything
  // painted" count.
  const offset = await page.evaluate(() => {
    const overlay = document.getElementById('markerOverlay');
    const { data } = overlay.getContext('2d')
      .getImageData(0, 0, overlay.width, overlay.height);
    let sumX = 0, sumY = 0, n = 0;
    for (let i = 3; i < data.length; i += 4) {
      if (!data[i]) continue;
      const pixel = (i - 3) / 4;
      sumX += pixel % overlay.width;
      sumY += Math.floor(pixel / overlay.width);
      n++;
    }
    return { x: sumX / n - overlay.width / 2, y: sumY / n - overlay.height / 2 };
  });
  expect(Math.hypot(offset.x, offset.y)).toBeLessThan(20);

  // Now a border, to check the marker set survives being filled. The old
  // vertex-label markers were painted with their 1-ring, which made them wider
  // than the ROI and forced them to be hidden once a region existed; a
  // screen-space marker is a fixed few pixels and cannot overstate anything.
  await page.evaluate(() => {
    const { graph, session } = window.__surfannotate;
    const step = (from) => {
      let frontier = [from];
      const seen = new Uint8Array(graph.V);
      seen[from] = 1;
      for (let h = 0; h < 12; h++) {
        const next = [];
        for (const u of frontier)
          for (let e = graph.adjOffset[u]; e < graph.adjOffset[u + 1]; e++) {
            const w = graph.adjNeighbor[e];
            if (!seen[w]) { seen[w] = 1; next.push(w); }
          }
        if (!next.length) break;
        frontier = next;
      }
      return frontier[0];
    };
    let v = session.clicks[0];
    for (let i = 0; i < 7; i++) { v = step(v); session.addClick(v); }
    session.closePath();
    window.__surfannotateUi.repaint();
  });
  const drawn = await countMarkers();
  expect(drawn).toBeGreaterThan(clicked);

  await page.evaluate(() => window.__surfannotateUi.runFill(-1));
  expect(await countMarkers()).toBe(drawn);

  // Culling is asserted on ONE point, not on the border: those clicks are twelve
  // hops apart and wander far enough round the hemisphere that some of them
  // genuinely still face any given camera. A single vertex is exact — at
  // elevation 0, half a turn of azimuth negates the facing test — and the point
  // used is the clicked one, which is known to be on the near surface.
  await page.evaluate(() => {
    const first = window.__surfannotate.session.clicks[0];
    window.__surfannotate.session.clearRoi();
    window.__surfannotate.session.addClick(first);
    window.__surfannotateUi.repaint();
  });
  expect(await countMarkers()).toBeGreaterThan(0);

  await page.evaluate(() => {
    const nv = window.__surfannotate.nv;
    nv.setRenderAzimuthElevation(nv.scene.renderAzimuth + 180, 0);
  });
  expect(await countMarkers()).toBe(0);
});

test('a finished ROI offers itself as an edge to the next one', async ({ page }) => {
  await loadSurface(page);

  // A closed hemisphere: there is no surface edge here, so before any ROI is
  // saved the edge row has nothing to offer and stays hidden.
  await expect(page.locator('#edgeRow')).toBeHidden();

  const saveRoiAround = (seed) => page.evaluate((from) => {
    const { graph, session } = window.__surfannotate;
    const step = (start) => {
      let frontier = [start];
      const seen = new Uint8Array(graph.V);
      seen[start] = 1;
      for (let h = 0; h < 14; h++) {
        const next = [];
        for (const u of frontier)
          for (let e = graph.adjOffset[u]; e < graph.adjOffset[u + 1]; e++) {
            const w = graph.adjNeighbor[e];
            if (!seen[w]) { seen[w] = 1; next.push(w); }
          }
        if (!next.length) break;
        frontier = next;
      }
      return frontier[0];
    };
    let v = from;
    for (let i = 0; i < 8; i++) { session.addClick(v); v = step(v); }
    session.closePath();
    window.__surfannotateUi.runFill(-1);
    document.getElementById('saveRoi').click();
  }, seed);

  await saveRoiAround(60000);
  expect(await page.evaluate(() => window.__surfannotateUi.savedRois().length)).toBe(1);

  // Its rim is now an edge, so the row appears — and says so. Naming this
  // "surface edge" is what hid the whole abutment workflow: on a hemisphere
  // there is no visible edge, so the button read as inapplicable.
  await expect(page.locator('#edgeRow')).toBeVisible();
  await expect(page.locator('#closeOnEdge')).toHaveText('Close on ROI edge');
  await expect(page.locator('#edgeHint')).toContainText('A finished ROI acts as an edge');

  // And clicking inside it is refused with the remedy, not just the diagnosis.
  await page.evaluate(() => {
    const { rois } = window.__surfannotate;
    const inside = rois[0].mask.indexOf(1);
    window.__surfannotateUi.handleVertexClick(inside);
  });
  await expect(page.locator('#statusText')).toContainText('Close on ROI edge');
});

test('gist_rainbow is registered and the colour range is adjustable', async ({ page }) => {
  await loadSurface(page);
  expect(await page.evaluate(() => window.__surfannotate.nv.colormaps().includes('gist_rainbow')))
    .toBe(true);

  await page.setInputFiles('#overlayInput', join(FIXTURES, 'lh.curv'));
  await expect(page.locator('#statusText')).toContainText('Overlay lh.curv loaded', {
    timeout: 60_000
  });

  const auto = await page.inputValue('#overlayMin');
  await page.selectOption('#overlayColormap', 'gist_rainbow');
  await page.fill('#overlayMin', '0.4');
  await page.press('#overlayMin', 'Enter');
  await page.fill('#overlayMax', '0.6');
  await page.press('#overlayMax', 'Enter');

  expect(await page.evaluate(() => {
    const layer = window.__surfannotate.overlayLayer;
    return { colormap: layer.colormap, min: layer.cal_min, max: layer.cal_max };
  })).toEqual({ colormap: 'gist_rainbow', min: 0.4, max: 0.6 });

  await page.click('#overlayRangeReset');
  expect(await page.inputValue('#overlayMin')).toBe(auto);
});

test('the retinotopy colour maps set the window their scale needs', async ({ page }) => {
  await loadSurface(page);
  expect(await page.evaluate(() => {
    const maps = window.__surfannotate.nv.colormaps();
    return ['eccentricity', 'polar_angle'].every((key) => maps.includes(key));
  })).toBe(true);

  await page.setInputFiles('#overlayInput', join(FIXTURES, 'lh.curv'));
  await expect(page.locator('#statusText')).toContainText('Overlay lh.curv loaded', {
    timeout: 60_000
  });
  const auto = {
    min: await page.inputValue('#overlayMin'),
    max: await page.inputValue('#overlayMax')
  };

  // NiiVue's .curv reader min-max normalises into 0..1, so this reads as radians.
  await page.selectOption('#overlayColormap', 'polar_angle');
  await expect(page.locator('#statusText')).toContainText('one full cycle');
  expect(await page.evaluate(() => {
    const layer = window.__surfannotate.overlayLayer;
    return { colormap: layer.colormap, min: layer.cal_min, max: layer.cal_max };
  })).toEqual({ colormap: 'polar_angle', min: 0, max: 2 * Math.PI });

  // Anchored at zero, keeping the robust maximum. Read through the boxes, which
  // round the stored value and the recorded one identically.
  await page.selectOption('#overlayColormap', 'eccentricity');
  expect(await page.inputValue('#overlayMin')).toBe('0');
  expect(await page.inputValue('#overlayMax')).toBe(auto.max);
  expect(await page.evaluate(() => window.__surfannotate.overlayLayer.cal_min)).toBe(0);

  // Auto is the way back: the percentile range is never overwritten.
  await page.click('#overlayRangeReset');
  expect(await page.inputValue('#overlayMin')).toBe(auto.min);
  expect(await page.inputValue('#overlayMax')).toBe(auto.max);
});

test('the colour scale on the view follows the map, the range and the overlay', async ({ page }) => {
  const legend = page.locator('#colorLegend');
  const ticks = page.locator('#colorLegend .color-legend-tick');

  await loadSurface(page);
  await expect(legend).toBeHidden();

  await page.setInputFiles('#overlayInput', join(FIXTURES, 'lh.curv'));
  await expect(page.locator('#statusText')).toContainText('Overlay lh.curv loaded', {
    timeout: 60_000
  });

  // An ordinary map gets a bar, ticked with the window the boxes report.
  await expect(legend).toBeVisible();
  await expect(legend).toHaveAttribute('data-kind', 'bar');
  await expect(ticks).toHaveCount(3);
  await expect(ticks.first()).toHaveText(await page.inputValue('#overlayMin'));
  await expect(ticks.last()).toHaveText(await page.inputValue('#overlayMax'));
  await expect(page.locator('#colorLegendCaption')).toHaveText('lh.curv');

  // The retinotopy maps get their wheel. The four quarter turns are labelled in
  // the unit the window is in, counter-clockwise from the right.
  await page.selectOption('#overlayColormap', 'polar_angle');
  await expect(legend).toHaveAttribute('data-kind', 'polar_angle');
  await expect(ticks).toHaveText(['0', 'π/2', 'π', '3π/2']);

  await page.selectOption('#overlayColormap', 'eccentricity');
  await expect(legend).toHaveAttribute('data-kind', 'eccentricity');
  await expect(ticks).toHaveCount(3);
  await expect(page.locator('#colorLegend .color-legend-ring')).toHaveCount(2);

  // A typed range re-ticks it; the wheel is not a picture of the data's own range.
  await page.fill('#overlayMax', '9');
  await page.press('#overlayMax', 'Enter');
  await expect(ticks.last()).toHaveText('9');
  await page.click('#overlayRangeReset');
  await expect(ticks.last()).not.toHaveText('9');

  // Nothing to describe once the overlay is hidden.
  const shown = page.locator('#overlayList input[aria-label="Show lh.curv"]');
  await shown.uncheck();
  await expect(legend).toBeHidden();
  await shown.check();
  await expect(legend).toBeVisible();

  // Dismissing leaves the way back visible in the panel rather than stranding
  // the user with a control they cannot find again.
  await page.click('#colorLegendClose');
  await expect(legend).toBeHidden();
  await expect(page.locator('#showLegend')).not.toBeChecked();
  await page.check('#showLegend');
  await expect(legend).toBeVisible();
});

/** A FreeSurfer "new format" curv file over `count` vertices. */
function curvFile(name, count, valueAt) {
  const buffer = Buffer.alloc(15 + count * 4);
  buffer[0] = 255; buffer[1] = 255; buffer[2] = 255;
  buffer.writeUInt32BE(count, 3);
  buffer.writeUInt32BE(count * 2, 7);
  buffer.writeUInt32BE(1, 11);
  for (let v = 0; v < count; v++) buffer.writeFloatBE(valueAt(v), 15 + v * 4);
  return { name, mimeType: 'application/octet-stream', buffer };
}

test('a binary mask limits every overlay but the curvature', async ({ page }) => {
  await loadSurface(page);
  const count = await page.evaluate(() => window.__surfannotate.geometry.vertexCount);

  // Curvature first, then data — the order that already works. The reverse is
  // covered by the restacking assertion further down.
  await page.setInputFiles('#overlayInput', join(FIXTURES, 'lh.curv'));
  await expect(page.locator('#statusText')).toContainText('Overlay lh.curv loaded', {
    timeout: 60_000
  });
  await page.setInputFiles('#overlayInput',
    curvFile('lh.thickness', count, (v) => 1 + (v % 100) / 100));
  await expect(page.locator('#statusText')).toContainText('Overlay lh.thickness loaded', {
    timeout: 60_000
  });

  // A mask keeping only the first 1000 vertices, written in the format NiiVue
  // would invert. That is the point of the assertion below: read through
  // readCURV this file would keep the other 162,842 vertices instead.
  await page.setInputFiles('#maskInput',
    curvFile('lh.firstThousand.mask', count, (v) => (v < 1000 ? 1 : 0)));
  await expect(page.locator('#statusText')).toContainText('limited to 1,000', {
    timeout: 60_000
  });

  const values = () => page.evaluate(() => {
    const overlays = window.__surfannotateUi.activeSurface().overlays;
    const read = (name) => {
      const layer = overlays.find((o) => o.name === name).layer;
      return {
        inside: layer.values[0],
        outside: layer.values[layer.values.length - 1]
      };
    };
    return {
      curv: read('lh.curv'),
      data: read('lh.thickness'),
      // Bottom-to-top: the exempt overlay has to sit under the masked one, or
      // it would cover the holes the mask opens. Matched by identity — NiiVue's
      // readLayer does not name the layers it returns.
      order: window.__surfannotate.mesh.layers.map(
        (layer) => overlays.find((o) => o.layer === layer)?.name || layer.name
      )
    };
  });

  const masked = await values();
  expect(Number.isFinite(masked.data.inside)).toBe(true);
  expect(masked.data.outside).toBe(-Infinity);
  // Curvature is what the mask is meant to reveal, so it is never cut.
  expect(Number.isFinite(masked.curv.inside)).toBe(true);
  expect(Number.isFinite(masked.curv.outside)).toBe(true);
  expect(masked.order).toEqual(['lh.curv', 'lh.thickness', 'surfannotate-roi']);

  // The exemption is a default, not a rule.
  await page.locator('#overlayList .layer-name', { hasText: 'lh.curv' }).click();
  await expect(page.locator('#overlayIgnoreMask')).toBeChecked();
  await page.uncheck('#overlayIgnoreMask');
  expect((await values()).curv.outside).toBe(-Infinity);
  await page.check('#overlayIgnoreMask');
  expect(Number.isFinite((await values()).curv.outside)).toBe(true);

  // Clearing puts every overlay back exactly as it was.
  await page.click('#maskClear');
  await expect(page.locator('#statusText')).toContainText('Mask cleared');
  const cleared = await values();
  expect(Number.isFinite(cleared.data.outside)).toBe(true);
  expect(cleared.data.inside).toBe(masked.data.inside);
});

test('a surface dropped on the viewer loads', async ({ page }) => {
  const bytes = readFileSync(join(FIXTURES, 'lh.pial')).toString('base64');

  // NiiVue installs its own canvas drop handler and routes files to its volume
  // loader; if it is ever re-enabled, this drop is swallowed and the surface
  // never appears.
  await page.evaluate(async (base64) => {
    const binary = atob(base64);
    const buffer = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) buffer[i] = binary.charCodeAt(i);

    const transfer = new DataTransfer();
    transfer.items.add(new File([buffer], 'lh.pial', { type: 'application/octet-stream' }));

    // Dispatch on the CANVAS, not the viewer — that is where a real drop lands,
    // and where NiiVue's competing listener is registered. Targeting the viewer
    // directly would bypass the very collision this test exists to catch.
    // Real pointer coordinates matter: NiiVue's dropListener early-returns on
    // eventInBounds() before it reaches stopPropagation(), so an event at (0,0)
    // sails through and the test would pass even with the bug present.
    const canvas = document.getElementById('gl');
    const rect = canvas.getBoundingClientRect();
    const clientX = Math.round(rect.left + rect.width / 2);
    const clientY = Math.round(rect.top + rect.height / 2);

    for (const type of ['dragenter', 'dragover', 'drop']) {
      canvas.dispatchEvent(new DragEvent(type, {
        dataTransfer: transfer, bubbles: true, cancelable: true, clientX, clientY
      }));
    }
  }, bytes);

  await expect(page.locator('#statusText')).toContainText('163,842 vertices', {
    timeout: 90_000
  });
  expect(await page.evaluate(() => window.__surfannotate.geometry.vertexCount)).toBe(163842);
  expect(await page.locator('#dropHint').isVisible()).toBe(false);
  expect(errors).toEqual([]);
});

test('a dropped file with "mask" in its name is loaded as the mask, not an overlay', async ({ page }) => {
  await loadSurface(page);
  const count = await page.evaluate(() => window.__surfannotate.geometry.vertexCount);

  await page.setInputFiles('#overlayInput',
    curvFile('lh.thickness', count, (v) => 1 + (v % 100) / 100));
  await expect(page.locator('#statusText')).toContainText('Overlay lh.thickness loaded', {
    timeout: 60_000
  });
  const before = await page.evaluate(() =>
    window.__surfannotateUi.activeSurface().overlays.length);

  // The same curv-format mask the picker test uses, but dropped. Nothing in the
  // bytes says "mask" — it is the same format as any overlay — so the name is
  // the only thing that can route this.
  const mask = curvFile('lh.firstThousand.mask', count, (v) => (v < 1000 ? 1 : 0));
  await page.evaluate(async ({ name, base64 }) => {
    const binary = atob(base64);
    const buffer = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) buffer[i] = binary.charCodeAt(i);

    const transfer = new DataTransfer();
    transfer.items.add(new File([buffer], name, { type: 'application/octet-stream' }));
    const canvas = document.getElementById('gl');
    const rect = canvas.getBoundingClientRect();
    const clientX = Math.round(rect.left + rect.width / 2);
    const clientY = Math.round(rect.top + rect.height / 2);
    for (const type of ['dragenter', 'dragover', 'drop']) {
      canvas.dispatchEvent(new DragEvent(type, {
        dataTransfer: transfer, bubbles: true, cancelable: true, clientX, clientY
      }));
    }
  }, { name: mask.name, base64: mask.buffer.toString('base64') });

  await expect(page.locator('#statusText')).toContainText('limited to 1,000', {
    timeout: 60_000
  });
  // The half that catches a mask arriving as an overlay: it would report a
  // loaded overlay, leave the clear button disabled, and lengthen the list.
  await expect(page.locator('#maskClear')).toBeEnabled();
  expect(await page.evaluate(() =>
    window.__surfannotateUi.activeSurface().overlays.length)).toBe(before);
  expect(errors).toEqual([]);
});

test('the ROI name reaches the file name and the file contents', async ({ page }) => {
  await loadSurface(page);
  await page.fill('#roiName', 'V1 / left*hemi');
  await page.dispatchEvent('#roiName', 'input');

  await page.evaluate(() => {
    const { graph, session } = window.__surfannotate;
    const step = (from) => {
      let frontier = [from];
      const seen = new Uint8Array(graph.V);
      seen[from] = 1;
      for (let h = 0; h < 12; h++) {
        const next = [];
        for (const u of frontier)
          for (let e = graph.adjOffset[u]; e < graph.adjOffset[u + 1]; e++) {
            const w = graph.adjNeighbor[e];
            if (!seen[w]) { seen[w] = 1; next.push(w); }
          }
        if (!next.length) break;
        frontier = next;
      }
      return frontier[0];
    };
    let v = 60000;
    for (let i = 0; i < 8; i++) { session.addClick(v); v = step(v); }
    session.closePath();
    window.__surfannotateUi.runFill(-1);
  });

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#exportLabel')
  ]);
  // Characters illegal in file names are replaced, but the name the user typed
  // is preserved verbatim inside the file.
  expect(download.suggestedFilename()).toBe('lh.V1-left-hemi.label');
  // Named for the hemisphere, not for lh.pial specifically — the ROI applies to
  // any surface sharing that vertex indexing.
  expect(download.suggestedFilename()).not.toContain('pial');

  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const header = Buffer.concat(chunks).toString('utf8').split('\n')[0];
  expect(header).toBe('#!ascii label V1 / left*hemi , from subject lh vox2ras=TkReg');
});

test('the .shape.gii export is gone', async ({ page }) => {
  await expect(page.locator('#exportShape')).toHaveCount(0);
  await expect(page.locator('#exportLabel')).toHaveCount(1);
  await expect(page.locator('#exportGifti')).toHaveCount(1);
  await expect(page.locator('#exportPoints')).toHaveCount(1);
});

test('the surface renders visibly', async ({ page }) => {
  await loadSurface(page);
  await page.waitForTimeout(1500);

  const shot = await page.locator('#gl').screenshot();
  expect(shot.length).toBeGreaterThan(5000);
  await test.info().attach('surface', { body: shot, contentType: 'image/png' });
});

// -- closing an ROI against the edge of a cut surface -----------------------

async function loadFlatPatch(page) {
  await page.setInputFiles('#surfaceInput', join(FIXTURES, 'lh.flat.surf.gii'));
  await expect(page.locator('#statusText')).toContainText('1,681 vertices', { timeout: 90_000 });
}

test('the edge-closure control appears only for a cut surface', async ({ page }) => {
  // A pial surface is closed after topology fixing, so there is no edge to
  // close against and the control must stay out of the way.
  await loadSurface(page);
  await expect(page.locator('#edgeRow')).toBeHidden();
  await expect(page.locator('#edgeHint')).toBeHidden();

  await loadFlatPatch(page);
  await expect(page.locator('#statusText')).toContainText('This surface is cut');
  await expect(page.locator('#edgeRow')).toBeVisible();
  await expect(page.locator('#edgeHint')).toContainText('Two points are enough');
  // Two points are enough here, where a loop needs three.
  await expect(page.locator('#closeOnEdge')).toBeDisabled();
  await page.evaluate(() => window.__surfannotate.session.addClick(0));
  await page.evaluate(() => window.__surfannotateUi.repaint());
  await expect(page.locator('#closeOnEdge')).toBeDisabled();
  await page.evaluate(() => window.__surfannotate.session.addClick(40));
  await page.evaluate(() => window.__surfannotateUi.repaint());
  await expect(page.locator('#closeOnEdge')).toBeEnabled();
});

test('two clicks on a flat patch close against the edge and fill one side', async ({ page }) => {
  await loadFlatPatch(page);

  const result = await page.evaluate(() => {
    const { session, geometry } = window.__surfannotate;
    const n = Math.round(Math.sqrt(geometry.vertexCount)); // 41x41 grid
    const at = (i, j) => j * n + i;
    // A line across the patch two rows up from the bottom edge. Each end is one
    // step from the side edge and two from the bottom, so both anchor sideways
    // and the border ends up spanning the full row.
    session.addClick(at(1, 2));
    session.addClick(at(n - 2, 2));
    const closed = session.closeOnEdge();
    const filled = session.fill();
    return { n, closed, filled, chain: Array.from(session.chain) };
  });

  expect(result.closed.ok).toBe(true);
  expect(result.closed.regions).toBe(2);
  // The strip below the line: 3 rows of 41, less the line itself.
  expect(result.filled.ok).toBe(true);
  expect(result.filled.count).toBe(2 * result.n);

  const onEdge = await page.evaluate((chain) => {
    const { geometry } = window.__surfannotate;
    const n = Math.round(Math.sqrt(geometry.vertexCount));
    const rim = (v) => v % n === 0 || v % n === n - 1 || v < n || v >= n * (n - 1);
    return { first: rim(chain[0]), last: rim(chain[chain.length - 1]) };
  }, result.chain);
  expect(onEdge.first).toBe(true);
  expect(onEdge.last).toBe(true);
});

test('the other side of an edge closure is one click away in the UI', async ({ page }) => {
  await loadFlatPatch(page);
  await expect(page.locator('#flipRegion')).toBeHidden();

  await page.evaluate(() => {
    const { session, geometry } = window.__surfannotate;
    const n = Math.round(Math.sqrt(geometry.vertexCount));
    session.addClick(2 * n + 1);
    session.addClick(2 * n + (n - 2));
    // addClick alone does not touch the DOM; the buttons follow a repaint.
    window.__surfannotateUi.repaint();
  });
  await page.locator('#closeOnEdge').click();
  await expect(page.locator('#statusText')).toContainText('closed against the surface edge');

  await page.locator('#fillRegion').click();
  await expect(page.locator('#statusText')).toContainText('Filled 82 vertices');
  await expect(page.locator('#flipRegion')).toBeVisible();

  await page.locator('#flipRegion').click();
  await expect(page.locator('#statusText')).toContainText('Region 2 of 2');
  const swapped = await page.evaluate(() => window.__surfannotate.session.filled
    .reduce((n, v) => n + v, 0));
  expect(swapped).toBe(1681 - 82 - 41);
});

test('an edge closure needs no seed click, unlike a loop on the same patch', async ({ page }) => {
  await loadFlatPatch(page);

  // A loop on a cut surface still asks the user to point at the region, because
  // a loop there is not guaranteed to separate anything.
  await page.evaluate(() => {
    const { session, geometry } = window.__surfannotate;
    const n = Math.round(Math.sqrt(geometry.vertexCount));
    const at = (i, j) => j * n + i;
    for (const v of [at(10, 10), at(30, 10), at(30, 30), at(10, 30)]) session.addClick(v);
    window.__surfannotateUi.repaint();
  });
  await page.locator('#closePath').click();
  await page.locator('#fillRegion').click();
  await expect(page.locator('#statusText')).toContainText('click inside the region you want');

  // The same patch, closed on the edge instead: filled straight away.
  await page.locator('#clearRoi').click();
  await page.evaluate(() => {
    const { session, geometry } = window.__surfannotate;
    const n = Math.round(Math.sqrt(geometry.vertexCount));
    session.addClick(2 * n + 1);
    session.addClick(2 * n + (n - 2));
    // addClick alone does not touch the DOM; the buttons follow a repaint.
    window.__surfannotateUi.repaint();
  });
  await page.locator('#closeOnEdge').click();
  await page.locator('#fillRegion').click();
  await expect(page.locator('#statusText')).toContainText('Filled 82 vertices');
});

test('the control panel stays one column and scrolls, never wrapping off-screen', async ({ page }) => {
  // #controls sets flex-direction: column while the shared .nd-imaging-controls
  // class on the same element sets flex-wrap: wrap. Together those wrap anything
  // taller than the panel into a second column to the RIGHT of a 320px-wide
  // panel: invisible, unreachable, and silent, because wrapping absorbs the
  // overflow so overflow-y has nothing left to scroll. It swallowed the entire
  // tool section — every annotation button at once.
  await loadFlatPatch(page);

  const layout = await page.evaluate(() => {
    const panel = document.getElementById('controls');
    const rect = panel.getBoundingClientRect();
    const sections = [...panel.children].map((section) => {
      const r = section.getBoundingClientRect();
      return { left: Math.round(r.left), width: Math.round(r.width), heading: section.textContent.trim().slice(0, 12) };
    });
    return {
      wrap: getComputedStyle(panel).flexWrap,
      panelRight: Math.round(rect.right),
      scrolls: panel.scrollHeight > panel.clientHeight,
      sections
    };
  });

  expect(layout.wrap).toBe('nowrap');
  // Every section starts at the same x and fits inside the panel: one column.
  const lefts = new Set(layout.sections.map((s) => s.left));
  expect(lefts.size, `sections at differing x = wrapped columns: ${JSON.stringify(layout.sections)}`).toBe(1);
  for (const section of layout.sections) {
    expect(section.left + section.width).toBeLessThanOrEqual(layout.panelRight + 1);
  }

  // And the buttons are genuinely reachable rather than merely present in the DOM.
  for (const id of ['closePath', 'closeOnEdge', 'fillRegion', 'clearRoi', 'exportLabel']) {
    await page.locator(`#${id}`).scrollIntoViewIfNeeded();
    await expect(page.locator(`#${id}`)).toBeInViewport();
  }
});

test('typing in text fields is not stolen by the undo shortcut', async ({ page }) => {
  // Backspace/Delete undo the last border point, on a document-level listener
  // that calls preventDefault. Unguarded it also eats every keystroke aimed at
  // a text box, so the ROI name could only be changed by select-all-and-retype.
  await loadSurface(page);

  const name = page.locator('#roiName');
  await name.fill('V1x');
  await name.press('Backspace');
  await expect(name).toHaveValue('V1', 'Backspace must delete a character');
  await name.press('Backspace');
  await expect(name).toHaveValue('V');

  // Number fields have the same problem; they enable once an overlay is loaded.
  await page.setInputFiles('#overlayInput', join(FIXTURES, 'lh.curv'));
  await expect(page.locator('#statusText')).toContainText('Overlay lh.curv loaded', {
    timeout: 60_000
  });
  const max = page.locator('#overlayMax');
  await max.fill('12');
  await max.press('Backspace');
  await expect(max).toHaveValue('1');

  // ...and the shortcut still works when focus is not in a text field.
  await page.evaluate(() => {
    const { session } = window.__surfannotate;
    session.addClick(1000); session.addClick(2000); session.addClick(3000);
    window.__surfannotateUi.repaint();
  });
  await page.locator('#roiOpacity').focus();
  await page.keyboard.press('Backspace');
  expect(await page.evaluate(() => window.__surfannotate.session.clicks.length)).toBe(2);
});

// -- several surfaces and overlays at once ---------------------------------

const surfaceRows = (page) => page.locator('#surfaceList li');
const overlayRows = (page) => page.locator('#overlayList li');

test('a dropped surface shows up in the surface list', async ({ page }) => {
  // A native file input shows nothing for a drag-and-drop, so before the list
  // existed a dropped surface rendered but the panel looked empty — it seemed
  // as though the drop had not registered at all.
  const bytes = readFileSync(join(FIXTURES, 'lh.flat.surf.gii')).toString('base64');
  await page.evaluate(async (b64) => {
    const binary = atob(b64);
    const buffer = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) buffer[i] = binary.charCodeAt(i);
    const file = new File([buffer], 'lh.flat.surf.gii', { type: 'application/octet-stream' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const canvas = document.getElementById('gl');
    const box = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new DragEvent('drop', {
      bubbles: true, cancelable: true, dataTransfer: transfer,
      clientX: box.left + box.width / 2, clientY: box.top + box.height / 2
    }));
  }, bytes);

  await expect(page.locator('#statusText')).toContainText('1,681 vertices', { timeout: 60_000 });
  await expect(surfaceRows(page)).toHaveCount(1);
  await expect(surfaceRows(page).first()).toContainText('lh.flat.surf.gii');
  await expect(surfaceRows(page).first().locator('input[type=radio]')).toBeChecked();
});

test('a second surface is added rather than replacing the first', async ({ page }) => {
  await page.setInputFiles('#surfaceInput', join(FIXTURES, 'lh.flat.surf.gii'));
  await expect(surfaceRows(page)).toHaveCount(1);
  await page.setInputFiles('#surfaceInput', join(FIXTURES, 'lh.realflat.surf.gii'));
  await expect(surfaceRows(page)).toHaveCount(2);

  // Both meshes stay loaded; exactly one is visible, and it is the newest.
  const shown = await page.evaluate(() => window.__surfannotate.nv.meshes.map((m) => m.visible));
  expect(shown).toEqual([false, true]);

  // Switching the radio switches which is drawn and which the tools act on.
  await surfaceRows(page).first().locator('input[type=radio]').check();
  const after = await page.evaluate(() => ({
    visible: window.__surfannotate.nv.meshes.map((m) => m.visible),
    active: window.__surfannotate.sourceName,
    vertices: window.__surfannotate.geometry.vertexCount,
    graphMatches: window.__surfannotate.graph.V === window.__surfannotate.geometry.vertexCount
  }));
  expect(after.visible).toEqual([true, false]);
  expect(after.active).toBe('lh.flat.surf.gii');
  expect(after.vertices).toBe(1681);
  expect(after.graphMatches).toBe(true);
});

test('removing a surface falls back to another, and the last leaves a clean slate', async ({ page }) => {
  await page.setInputFiles('#surfaceInput', join(FIXTURES, 'lh.flat.surf.gii'));
  await page.setInputFiles('#surfaceInput', join(FIXTURES, 'lh.realflat.surf.gii'));
  await expect(surfaceRows(page)).toHaveCount(2);

  await surfaceRows(page).nth(1).locator('.layer-remove').click();
  await expect(surfaceRows(page)).toHaveCount(1);
  expect(await page.evaluate(() => window.__surfannotate.sourceName)).toBe('lh.flat.surf.gii');
  expect(await page.evaluate(() => window.__surfannotate.nv.meshes.length)).toBe(1);

  await surfaceRows(page).first().locator('.layer-remove').click();
  await expect(surfaceRows(page)).toHaveCount(0);
  expect(await page.evaluate(() => window.__surfannotate.session)).toBe(null);
  await expect(page.locator('#dropHint')).toBeVisible();
});

test('border points survive a switch between surfaces sharing a vertex indexing', async ({ page }) => {
  // The same file twice stands in for lh.white and lh.inflated: identical
  // vertex count and triangles, so an ROI drawn on one is valid on the other.
  await page.setInputFiles('#surfaceInput', join(FIXTURES, 'lh.flat.surf.gii'));
  await page.setInputFiles('#surfaceInput', join(FIXTURES, 'lh.flat.surf.gii'));
  await expect(surfaceRows(page)).toHaveCount(2);

  await page.evaluate(() => {
    const { session } = window.__surfannotate;
    session.addClick(2 * 41 + 1);
    session.addClick(2 * 41 + 39);
    session.closeOnEdge();
    session.fill();
    window.__surfannotateUi.repaint();
  });
  const before = await page.evaluate(() => ({
    clicks: [...window.__surfannotate.session.clicks],
    filled: window.__surfannotate.session.filled.reduce((n, v) => n + v, 0)
  }));
  expect(before.filled).toBe(82);

  await surfaceRows(page).first().locator('input[type=radio]').check();
  const after = await page.evaluate(() => ({
    clicks: [...window.__surfannotate.session.clicks],
    // Paths and fills are geometry-dependent, so they are discarded and redone.
    closed: window.__surfannotate.session.closed,
    filled: window.__surfannotate.session.filled
  }));
  expect(after.clicks).toEqual(before.clicks);
  expect(after.closed).toBe(false);
  expect(after.filled).toBe(null);

  // And re-closing on the new surface reproduces the same region.
  const redone = await page.evaluate(() => {
    const { session } = window.__surfannotate;
    session.closeOnEdge();
    return session.fill().count;
  });
  expect(redone).toBe(82);
});

test('surfaces with different topology keep separate ROIs', async ({ page }) => {
  await page.setInputFiles('#surfaceInput', join(FIXTURES, 'lh.flat.surf.gii'));
  await expect(surfaceRows(page)).toHaveCount(1);
  await page.evaluate(() => {
    window.__surfannotate.session.addClick(100);
    window.__surfannotate.session.addClick(200);
  });
  await page.setInputFiles('#surfaceInput', join(FIXTURES, 'lh.realflat.surf.gii'));
  await expect(surfaceRows(page)).toHaveCount(2);
  expect(await page.evaluate(() => window.__surfannotate.session.clicks.length))
    .toBe(0, 'an unrelated mesh starts empty');

  await surfaceRows(page).first().locator('input[type=radio]').check();
  expect(await page.evaluate(() => [...window.__surfannotate.session.clicks]))
    .toEqual([100, 200], 'and switching back restores the first ROI');
});

test('several overlays coexist, each with its own visibility and colour map', async ({ page }) => {
  await loadSurface(page);
  await page.setInputFiles('#overlayInput', join(FIXTURES, 'lh.curv'));
  await expect(page.locator('#statusText')).toContainText('Overlay lh.curv loaded', {
    timeout: 60_000
  });
  await expect(overlayRows(page)).toHaveCount(1);

  await page.setInputFiles('#overlayInput', join(FIXTURES, 'lh.curv'));
  await expect(overlayRows(page)).toHaveCount(2);
  expect(await page.evaluate(() => window.__surfannotate.mesh.layers.length))
    .toBe(3, 'two overlays plus the ROI layer');

  // The ROI layer must stay last, or an overlay paints over the boundary.
  expect(await page.evaluate(() => {
    const layers = window.__surfannotate.mesh.layers;
    return layers[layers.length - 1].name;
  })).toBe('surfannotate-roi');

  // Unticking hides one overlay without touching the other's opacity.
  await overlayRows(page).first().locator('input[type=checkbox]').uncheck();
  const opacities = await page.evaluate(() =>
    window.__surfannotateUi.activeSurface().overlays.map((o) => ({
      visible: o.visible, stored: o.opacity, applied: o.layer.opacity
    })));
  expect(opacities[0]).toMatchObject({ visible: false, applied: 0 });
  expect(opacities[0].stored).toBeGreaterThan(0);
  expect(opacities[1].visible).toBe(true);

  // Selecting an overlay points the colour-map controls at it.
  await overlayRows(page).first().locator('.layer-name').click();
  await expect(page.locator('#overlaySelectedHint')).toContainText('lh.curv');
  await page.selectOption('#overlayColormap', 'gist_rainbow');
  const maps = await page.evaluate(() =>
    window.__surfannotateUi.activeSurface().overlays.map((o) => o.layer.colormap));
  expect(maps[0]).toBe('gist_rainbow');
  expect(maps[1]).not.toBe('gist_rainbow');

  await overlayRows(page).first().locator('.layer-remove').click();
  await expect(overlayRows(page)).toHaveCount(1);
  expect(await page.evaluate(() => window.__surfannotate.mesh.layers.length)).toBe(2);
});

test('overlays belong to their own surface', async ({ page }) => {
  await page.setInputFiles('#surfaceInput', join(FIXTURES, 'lh.flat.surf.gii'));
  await page.setInputFiles('#surfaceInput', join(FIXTURES, 'lh.realflat.surf.gii'));
  await expect(surfaceRows(page)).toHaveCount(2);
  await expect(overlayRows(page)).toHaveCount(0);

  // Switching surfaces shows that surface's overlays, not the previous one's.
  await surfaceRows(page).first().locator('input[type=radio]').check();
  await expect(overlayRows(page)).toHaveCount(0);
  expect(await page.evaluate(() => window.__surfannotate.overlayLayer)).toBe(null);
});

test('a dropped overlay is recognised as an overlay, not a second surface', async ({ page }) => {
  await loadSurface(page);
  const bytes = readFileSync(join(FIXTURES, 'lh.curv')).toString('base64');
  await page.evaluate(async (b64) => {
    const binary = atob(b64);
    const buffer = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) buffer[i] = binary.charCodeAt(i);
    const file = new File([buffer], 'lh.curv', { type: 'application/octet-stream' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const canvas = document.getElementById('gl');
    const box = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new DragEvent('drop', {
      bubbles: true, cancelable: true, dataTransfer: transfer,
      clientX: box.left + box.width / 2, clientY: box.top + box.height / 2
    }));
  }, bytes);

  await expect(page.locator('#statusText')).toContainText('Overlay lh.curv loaded', {
    timeout: 60_000
  });
  await expect(surfaceRows(page)).toHaveCount(1, 'the curv file did not become a surface');
  await expect(overlayRows(page)).toHaveCount(1);
});

// -- ROIs as a parcellation ------------------------------------------------

const roiRows = (page) => page.locator('#roiList li');

async function loadFlat(page) {
  await page.setInputFiles('#surfaceInput', join(FIXTURES, 'lh.flat.surf.gii'));
  await expect(page.locator('#statusText')).toContainText('1,681 vertices', { timeout: 60_000 });
}

/** Define an ROI by a line across the flat patch at row `j`, and save it. */
async function saveStrip(page, row, name) {
  await page.evaluate((j) => {
    const { session } = window.__surfannotate;
    const n = 41;
    session.addClick(j * n + 1);
    session.addClick(j * n + (n - 2));
    session.closeOnEdge();
    session.fill();
    window.__surfannotateUi.repaint();
  }, row);
  await page.fill('#roiName', name);
  await page.locator('#saveRoi').click();
}

const areaSizes = (page) => page.evaluate(() => window.__surfannotateUi.savedRois()
  .map((a) => ({ name: a.name, n: a.mask ? a.mask.reduce((t, v) => t + v, 0) : null })));

test('a filled region is saved as an ROI and clears the canvas', async ({ page }) => {
  await loadFlat(page);
  await expect(page.locator('#saveRoi')).toBeDisabled();

  await saveStrip(page, 2, 'V1');
  await expect(roiRows(page)).toHaveCount(1);
  await expect(roiRows(page).first()).toContainText('V1');
  await expect(page.locator('#statusText')).toContainText('Saved V1 — 82 vertices');

  const after = await page.evaluate(() => ({
    clicks: window.__surfannotate.session.clicks.length,
    filled: window.__surfannotate.session.filled
  }));
  expect(after.clicks).toBe(0, 'the working session is cleared for the next ROI');
  expect(after.filled).toBe(null);
});

test('a saved ROI is cut out of the surface for the next one', async ({ page }) => {
  await loadFlat(page);
  expect(await page.evaluate(() => window.__surfannotate.excluded)).toBe(null);
  await saveStrip(page, 2, 'V1');

  // No tick needed: every ROI above the one being drawn owns its vertices.
  const after = await page.evaluate(() => {
    const s = window.__surfannotate;
    const n = 41;
    const inside = 1 * n + 20;
    return {
      excludedCount: [...s.excluded].reduce((a, v) => a + v, 0),
      insideIsolated: s.graph.adjOffset[inside + 1] === s.graph.adjOffset[inside],
      rimIsEdge: s.session.openEdge[2 * n + 20] === 1,
      middleIsEdge: s.session.openEdge[20 * n + 20] === 1
    };
  });
  expect(after.excludedCount).toBe(82);
  expect(after.insideIsolated).toBe(true);
  expect(after.rimIsEdge).toBe(true, 'V1\'s rim now works as an edge');
  expect(after.middleIsEdge).toBe(false);
});

test('the next ROI is closed against the one before it', async ({ page }) => {
  await loadFlat(page);
  await saveStrip(page, 2, 'V1');

  // V2 needs two clicks only: its lower border is V1's rim.
  const v2 = await page.evaluate(() => {
    const { session } = window.__surfannotate;
    const n = 41;
    session.addClick(6 * n + 1);
    session.addClick(6 * n + (n - 2));
    const closed = session.closeOnEdge();
    const count = session.fill().count;
    window.__surfannotateUi.repaint();
    return { ok: closed.ok, error: closed.error, count };
  });
  expect(v2.ok).toBe(true, v2.error || '');
  expect(v2.count).toBe(4 * 41, 'rows 2-5, between V1 and the new border');

  await page.fill('#roiName', 'V2');
  await page.locator('#saveRoi').click();
  expect(await areaSizes(page)).toEqual([
    { name: 'V1', n: 82 }, { name: 'V2', n: 164 }
  ]);
});

test('editing an ROI moves the shared boundary, and the neighbour follows', async ({ page }) => {
  // The point of the parcellation: V2 was never redefined, but pulling V1's
  // border back hands it the vertices V1 gave up, with nothing left over.
  await loadFlat(page);
  await saveStrip(page, 4, 'V1');
  await saveStrip(page, 9, 'V2');
  expect(await areaSizes(page)).toEqual([
    { name: 'V1', n: 4 * 41 }, { name: 'V2', n: 5 * 41 }
  ]);

  await roiRows(page).first().locator('.layer-edit').click();
  await expect(page.locator('#statusText')).toContainText('border points restored');

  // Move V1's border from row 4 down to row 2 and save it again.
  await page.evaluate(() => {
    const { session } = window.__surfannotate;
    const n = 41;
    session.clearRoi();
    session.addClick(2 * n + 1);
    session.addClick(2 * n + (n - 2));
    session.closeOnEdge();
    session.fill();
  });
  await page.locator('#saveRoi').click();

  expect(await areaSizes(page)).toEqual([
    { name: 'V1', n: 2 * 41 },
    { name: 'V2', n: 7 * 41 }
  ]);

  // Disjoint, and no unclaimed strip where the boundary used to be.
  const overlap = await page.evaluate(() => {
    const [v1, v2] = window.__surfannotateUi.savedRois();
    let both = 0;
    let neither = 0;
    for (let v = 0; v < 9 * 41; v++) {
      if (v1.mask[v] && v2.mask[v]) both++;
      if (!v1.mask[v] && !v2.mask[v]) neither++;
    }
    return { both, neither };
  });
  expect(overlap).toEqual({ both: 0, neither: 0 });
});

test('an ROI keeps its place in the list while it is being edited', async ({ page }) => {
  // Reopening V1 while V2 exists used to fail: V1's border points sit inside
  // V2. Position is what fixes it — V1 is edited where it was, so only the
  // ROIs above it constrain, and V2 is below.
  await loadFlat(page);
  await saveStrip(page, 2, 'V1');
  await saveStrip(page, 6, 'V2');

  const claimed = await page.evaluate(() => {
    const [v1, v2] = window.__surfannotateUi.savedRois();
    return v1.clicks.filter((v) => v2.mask[v]).length;
  });
  expect(claimed).toBe(2, 'V1\'s border points are inside V2');

  await roiRows(page).first().locator('.layer-edit').click();
  const after = await page.evaluate(() => {
    const s = window.__surfannotate;
    return {
      editIndex: s.editIndex,
      excluded: s.excluded,
      closed: s.session.closed,
      gaps: s.session.gaps.length,
      filled: s.session.filled ? s.session.filled.reduce((n, v) => n + v, 0) : null
    };
  });
  expect(after.editIndex).toBe(0);
  expect(after.excluded).toBe(null, 'nothing is above V1, so nothing constrains it');
  expect(after.closed).toBe(true);
  expect(after.gaps).toBe(0);
  expect(after.filled).toBe(82, 'the region comes back as it was');
});

test('reordering ROIs changes who owns the overlap', async ({ page }) => {
  await loadFlat(page);
  await saveStrip(page, 2, 'V1');
  await saveStrip(page, 6, 'V2');

  // Push V1 right over V2's border. V2 is below it in the list, so it loses.
  await roiRows(page).first().locator('.layer-edit').click();
  await page.evaluate(() => {
    const { session } = window.__surfannotate;
    const n = 41;
    session.clearRoi();
    session.addClick(8 * n + 1);
    session.addClick(8 * n + (n - 2));
    session.closeOnEdge();
    session.fill();
    window.__surfannotateUi.repaint();
  });
  await page.locator('#saveRoi').click();

  let sizes = await areaSizes(page);
  expect(sizes[0]).toEqual({ name: 'V1', n: 8 * 41 });
  expect(sizes[1].n).toBe(null, 'V2 is squeezed out entirely');
  await expect(roiRows(page).nth(1)).toHaveClass(/unresolved/);

  // Promote V2 and it takes those vertices straight back.
  await roiRows(page).nth(1).locator('[aria-label^="Move V2 up"]').click();
  sizes = await areaSizes(page);
  expect(sizes[0]).toEqual({ name: 'V2', n: 6 * 41 });
  expect(sizes[1]).toEqual({ name: 'V1', n: 2 * 41 });
});

test('removing an ROI gives its vertices back to the surface', async ({ page }) => {
  await loadFlat(page);
  await saveStrip(page, 2, 'V1');
  expect(await page.evaluate(() => window.__surfannotate.excluded !== null)).toBe(true);

  await roiRows(page).first().locator('.layer-remove').click();
  await expect(roiRows(page)).toHaveCount(0);
  expect(await page.evaluate(() => window.__surfannotate.excluded)).toBe(null);
});

test('a selected ROI is what the export buttons write', async ({ page }) => {
  await loadFlat(page);
  await saveStrip(page, 2, 'V1');
  await roiRows(page).first().locator('.layer-name').click();

  await expect(page.locator('#exportLabel')).toBeEnabled();
  const download = page.waitForEvent('download');
  await page.locator('#exportLabel').click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('lh.V1.label');

  const stream = await file.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const lines = Buffer.concat(chunks).toString('utf8').trimEnd().split('\n');
  expect(Number(lines[1])).toBe(82, 'the saved region, not an empty one');
});

test('ROIs follow the topology, like the ROI being drawn', async ({ page }) => {
  await loadFlat(page);
  await saveStrip(page, 2, 'V1');
  await expect(roiRows(page)).toHaveCount(1);

  await page.setInputFiles('#surfaceInput', join(FIXTURES, 'lh.realflat.surf.gii'));
  await expect(surfaceRows(page)).toHaveCount(2);
  await expect(roiRows(page)).toHaveCount(0, 'an unrelated mesh shows none');

  await surfaceRows(page).first().locator('input[type=radio]').check();
  await expect(roiRows(page)).toHaveCount(1, 'and they come back on the original');
});

test('a loop ROI is reopened onto the side it was filled on', async ({ page }) => {
  await loadFlat(page);
  await page.evaluate(() => {
    const { session } = window.__surfannotate;
    const n = 41, at = (i, j) => j * n + i;
    for (const v of [at(10, 10), at(30, 10), at(30, 30), at(10, 30)]) session.addClick(v);
    session.closePath();
    session.fill({ seed: at(20, 20) });
    window.__surfannotateUi.repaint();
  });
  const before = await page.evaluate(() =>
    window.__surfannotate.session.filled.reduce((n, v) => n + v, 0));
  await page.fill('#roiName', 'square');
  await page.locator('#saveRoi').click();

  await roiRows(page).first().locator('.layer-edit').click();
  const after = await page.evaluate(() => ({
    closure: window.__surfannotate.session.closure,
    filled: window.__surfannotate.session.filled
      ? window.__surfannotate.session.filled.reduce((n, v) => n + v, 0) : 0
  }));
  expect(after.closure).toBe('loop');
  expect(after.filled).toBe(before, 'the same side, not the complement');
});

test('an ROI keeps its colour when it is edited', async ({ page }) => {
  // The palette index came from the list length, so re-saving an edited ROI
  // recoloured it — and could give it the same colour as its neighbour.
  await loadFlat(page);
  await saveStrip(page, 5, 'V1');
  await saveStrip(page, 11, 'V2');
  await saveStrip(page, 17, 'V3');
  const before = await page.evaluate(() =>
    window.__surfannotateUi.savedRois().map((a) => a.colorIndex));
  expect(before).toEqual([0, 1, 2]);

  await roiRows(page).first().locator('.layer-edit').click();
  await page.evaluate(() => {
    const { session } = window.__surfannotate;
    const n = 41;
    session.clearRoi();
    session.addClick(2 * n + 1);
    session.addClick(2 * n + (n - 2));
    session.closeOnEdge();
    session.fill();
    window.__surfannotateUi.repaint();
  });
  await page.locator('#saveRoi').click();

  const after = await page.evaluate(() =>
    window.__surfannotateUi.savedRois().map((a) => a.colorIndex));
  expect(after).toEqual([0, 1, 2]);
  expect(new Set(after).size).toBe(3, 'and no two ROIs share a colour');
});

test('the ROI name is entered where the ROI is made', async ({ page }) => {
  await loadFlat(page);
  // The field used to live in the Export panel, below the Save button that uses it.
  const areasPanel = page.locator('section.panel', { hasText: 'ROIs' }).first();
  await expect(areasPanel.locator('#roiName')).toHaveCount(1);
  await expect(areasPanel.locator('#saveRoi')).toHaveCount(1);

  await page.fill('#roiName', 'hV4');
  await saveStrip(page, 3, 'hV4');
  await expect(roiRows(page).first()).toContainText('hV4');
  await expect(page.locator('#exportNameHint')).toContainText('lh.hV4');
});

test('an exported .label can be dropped back in as an overlay', async ({ page }) => {
  // NiiVue has no reader for a FreeSurfer .label: the extension falls through
  // to its curvature parser, which cannot read ASCII, so the drop did nothing.
  await loadFlat(page);
  await saveStrip(page, 2, 'V1');
  await roiRows(page).first().locator('.layer-name').click();

  const download = page.waitForEvent('download');
  await page.locator('#exportLabel').click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('lh.V1.label');
  const stream = await file.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');

  await page.evaluate(async (payload) => {
    const dropped = new File([payload], 'lh.V1.label', { type: 'text/plain' });
    const transfer = new DataTransfer();
    transfer.items.add(dropped);
    const canvas = document.getElementById('gl');
    const box = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new DragEvent('drop', {
      bubbles: true, cancelable: true, dataTransfer: transfer,
      clientX: box.left + box.width / 2, clientY: box.top + box.height / 2
    }));
  }, text);

  await expect(page.locator('#statusText')).toContainText('Overlay lh.V1.label loaded', {
    timeout: 60_000
  });
  await expect(overlayRows(page)).toHaveCount(1);
  await expect(surfaceRows(page)).toHaveCount(1, 'not mistaken for a second surface');

  const layer = await page.evaluate(() => {
    const overlay = window.__surfannotateUi.activeOverlay();
    const values = overlay.layer.values;
    let marked = 0;
    for (let v = 0; v < values.length; v++) if (values[v] > 0) marked++;
    return {
      length: values.length,
      marked,
      calMin: overlay.layer.cal_min,
      calMax: overlay.layer.cal_max,
      transparentBelow: overlay.layer.isTransparentBelowCalMin
    };
  });
  expect(layer.length).toBe(1681, 'expanded to one value per vertex');
  expect(layer.marked).toBe(82, 'the same 82 vertices that were exported');
  // The window must sit above zero, or a mask renders as a flat surface.
  expect(layer.calMin).toBeGreaterThan(0);
  expect(layer.calMax).toBe(1);
  expect(layer.transparentBelow).toBe(true);

  // And it behaves like any other overlay from here on.
  await page.selectOption('#overlayColormap', 'hot');
  expect(await page.evaluate(() =>
    window.__surfannotateUi.activeOverlay().layer.colormap)).toBe('hot');
  await overlayRows(page).first().locator('input[type=checkbox]').uncheck();
  expect(await page.evaluate(() =>
    window.__surfannotateUi.activeOverlay().layer.opacity)).toBe(0);
});

test('a .label from a different surface is refused with a reason', async ({ page }) => {
  await loadFlat(page);
  const wrong = '#!ascii label V1 , from subject lh vox2ras=TkReg\n1\n' +
    '90000  1.0 2.0 3.0 0.0\n';
  await page.evaluate(async (payload) => {
    const dropped = new File([payload], 'other.label', { type: 'text/plain' });
    const transfer = new DataTransfer();
    transfer.items.add(dropped);
    const canvas = document.getElementById('gl');
    const box = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new DragEvent('drop', {
      bubbles: true, cancelable: true, dataTransfer: transfer,
      clientX: box.left + box.width / 2, clientY: box.top + box.height / 2
    }));
  }, wrong);

  await expect(page.locator('#statusText')).toContainText('different mesh', { timeout: 30_000 });
  await expect(overlayRows(page)).toHaveCount(0);
});

// -- the start page ---------------------------------------------------------

test.describe('start page', () => {
  // These need the page as it first loads, before the shared beforeEach enters.
  test.use({});

  test('explains the app and only then hands over to it', async ({ page }) => {
    await page.reload();
    const start = page.locator('#startPage');
    await expect(start).toBeVisible();
    await expect(start.getByRole('heading', { level: 2 })).toContainText('cortical surface');
    await expect(start.locator('.start-step')).toHaveCount(3);
    // Required of every app in the composite site, on this page too.
    await expect(start.locator('a[href="../"]')).toHaveCount(1);

    await page.locator('#enterAppButton').click();
    await expect(start).toBeHidden();
    await expect(page.locator('#controls')).toBeVisible();
    await expect(page.locator('#gl')).toBeVisible();

    // The app was behind it all along, so the canvas is already sized.
    const canvas = await page.evaluate(() => {
      const box = document.getElementById('gl').getBoundingClientRect();
      return { width: Math.round(box.width), height: Math.round(box.height) };
    });
    expect(canvas.width).toBeGreaterThan(200);
    expect(canvas.height).toBeGreaterThan(200);
  });

  test('the one-glyph badge is gone', async ({ page }) => {
    await page.reload();
    await page.locator('#enterAppButton').click();
    // The shared shell always renders it; the app hides it to match the others.
    const mark = page.locator('.nd-imaging-mark');
    await expect(mark).toHaveCount(1, 'still in the DOM — hidden, not removed');
    await expect(mark).toBeHidden();
    // The name itself stays.
    await expect(page.locator('.nd-imaging-brand-copy')).toContainText('SurfAnnotate');
  });
});

test('every declared icon is actually served', async ({ page }) => {
  const links = await page.$$eval('link[rel="icon"], link[rel="apple-touch-icon"]',
    (nodes) => nodes.map((node) => ({
      rel: node.getAttribute('rel'),
      sizes: node.getAttribute('sizes'),
      href: node.getAttribute('href')
    })));
  expect(links.length).toBeGreaterThanOrEqual(3);
  expect(links.some((link) => link.rel === 'apple-touch-icon')).toBe(true);

  for (const link of links) {
    // Vite substitutes %BASE_URL% in index.html. If that ever stops happening
    // the href goes out as a literal and the icon 404s with no other symptom.
    expect(link.href, JSON.stringify(link)).not.toContain('%');
    const response = await page.request.get(new URL(link.href, page.url()).toString());
    expect(response.status(), `${link.href} must be served`).toBe(200);
    expect(response.headers()['content-type']).toContain('png');

    // Square, and the size the tag claims — a non-square icon is stretched by
    // the browser rather than padded.
    const declared = Number(link.sizes.split('x')[0]);
    const measured = await page.evaluate(async (href) => {
      const img = new Image();
      img.src = href;
      await img.decode();
      return { width: img.naturalWidth, height: img.naturalHeight };
    }, new URL(link.href, page.url()).toString());
    expect(measured.width, `${link.href} width`).toBe(declared);
    expect(measured.height, `${link.href} height`).toBe(declared);
  }
});

test('the Cite button opens the citations, from the app and from the start page', async ({ page }) => {
  const dialog = page.locator('#citationsDialog');
  await expect(dialog).toBeHidden();

  // The shell builds its navigation with only the catalog link, so the app's
  // Cite button is appended after mounting; check it actually landed there.
  const inHeader = page.locator('.nd-imaging-navigation [data-cite-open]');
  await expect(inHeader).toHaveCount(1);
  await inHeader.click();
  await expect(dialog).toBeVisible();

  await expect(dialog).toContainText('NiiVue Contributors. NiiVue: a WebGL2 medical image viewer.');
  const link = dialog.locator('a[href="https://github.com/niivue/niivue"]');
  await expect(link).toHaveCount(1);
  await expect(link).toHaveAttribute('rel', /noopener/);

  await page.locator('#closeCitations').click();
  await expect(dialog).toBeHidden();

  // And again from the start page, which is a separate header.
  await page.reload();
  await expect(page.locator('#startPage')).toBeVisible();
  await page.locator('#startPage [data-cite-open]').click();
  // showModal() puts the dialog in the top layer, so it is above the start page.
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.locator('#startPage')).toBeVisible('escape closed the dialog, not the page');
});

// -- regressions found by adversarial testing ------------------------------

test('saving an ROI does not silently retarget the export', async ({ page }) => {
  // Saving used to select the ROI, and the export buttons prefer the selection
  // while the filename comes from the name box — so the next export wrote the
  // saved ROI's vertices under the new ROI's name.
  await loadFlat(page);
  await saveStrip(page, 2, 'V1');

  await page.evaluate(() => {
    const { session } = window.__surfannotate;
    const n = 41;
    session.addClick(9 * n + 1);
    session.addClick(9 * n + (n - 2));
    session.closeOnEdge();
    session.fill();
    window.__surfannotateUi.repaint();
  });
  await page.fill('#roiName', 'V2');

  const onScreen = await page.evaluate(() =>
    window.__surfannotate.session.filled.reduce((n, v) => n + v, 0));
  expect(onScreen).not.toBe(82);

  const download = page.waitForEvent('download');
  await page.locator('#exportLabel').click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('lh.V2.label');
  const stream = await file.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const lines = Buffer.concat(chunks).toString('utf8').trimEnd().split('\n');
  expect(Number(lines[1])).toBe(onScreen, 'the region on screen, not the saved one');
});

test('a reopened ROI survives every way of walking away from the edit', async ({ page }) => {
  // Reopening lifts the ROI off the list into the session. Nothing used to put
  // it back, so switching surface, clearing, or reopening another lost it.
  await loadFlat(page);
  await saveStrip(page, 2, 'V1');
  await saveStrip(page, 9, 'V2');

  // Reopen V1, then reopen V2 instead.
  await roiRows(page).first().locator('.layer-edit').click();
  await roiRows(page).first().locator('.layer-edit').click();
  let names = await page.evaluate(() => window.__surfannotateUi.savedRois().map((a) => a.name));
  expect(names).toEqual(['V1'], 'V1 came back when V2 was opened');

  // Reopen V1 — which puts V2 back — then Clear, which puts V1 back too.
  await page.locator('#roiList li').first().locator('.layer-edit').click();
  await page.locator('#clearRoi').click();
  names = await page.evaluate(() => window.__surfannotateUi.savedRois().map((a) => a.name));
  expect(names).toEqual(['V1', 'V2'], 'Clear put it back, in its own place');
  await expect(page.locator('#statusText')).toContainText('went back on the list');

  // Reopen, then switch to another surface and back.
  await roiRows(page).first().locator('.layer-edit').click();
  await page.setInputFiles('#surfaceInput', join(FIXTURES, 'lh.realflat.surf.gii'));
  await expect(surfaceRows(page)).toHaveCount(2);
  await surfaceRows(page).first().locator('input[type=radio]').check();
  names = await page.evaluate(() => window.__surfannotateUi.savedRois().map((a) => a.name));
  expect(names).toEqual(['V1', 'V2'], 'switching surfaces put it back');
});

test('removing the last surface disarms the controls instead of crashing', async ({ page }) => {
  // repaint() returns early without a session, so the teardown path has to reset
  // the controls itself — otherwise every button keeps its enabled state and
  // then dereferences null.
  await loadFlat(page);
  await page.evaluate(() => {
    const { session } = window.__surfannotate;
    const n = 41;
    session.addClick(2 * n + 1);
    session.addClick(2 * n + (n - 2));
    session.closeOnEdge();
    session.fill();
    window.__surfannotateUi.repaint();
  });

  await surfaceRows(page).first().locator('.layer-remove').click();
  await expect(surfaceRows(page)).toHaveCount(0);

  for (const id of ['undoPoint', 'closePath', 'closeOnEdge', 'fillRegion', 'clearRoi',
    'saveRoi', 'exportLabel', 'exportGifti', 'exportPoints']) {
    await expect(page.locator(`#${id}`), `#${id} must be disabled`).toBeDisabled();
  }
  await expect(page.locator('#flipRegion')).toBeHidden();
  await expect(page.locator('#roiList li')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('switching tool cancels a pending "click inside the region"', async ({ page }) => {
  await loadFlat(page);
  await page.evaluate(() => {
    const { session } = window.__surfannotate;
    const n = 41, at = (i, j) => j * n + i;
    for (const v of [at(10, 10), at(30, 10), at(30, 30), at(10, 30)]) session.addClick(v);
    session.closePath();
    window.__surfannotateUi.repaint();
  });
  await page.locator('#fillRegion').click();
  await expect(page.locator('#statusText')).toContainText('click inside the region you want');
  expect(await page.evaluate(() => window.__surfannotate.awaitingSeed)).toBe(true);

  await page.locator('#modePoints').click();
  expect(await page.evaluate(() => window.__surfannotate.awaitingSeed))
    .toBe(false, 'the pending seed would eat the first landmark click');
});

test('an exported .label carries tkreg coordinates, as its header claims', async ({ page }) => {
  // NiiVue adds the volume centre on load (tkreg RAS -> scanner RAS), even when
  // the footer says the volume geometry is invalid. The header declares TkReg
  // and FreeSurfer's labelGetSurfaceRasCoords takes it verbatim, so writing the
  // shifted values makes mri_label2vol and mri_label2label --regmethod coords
  // silently wrong while everything keyed on the vertex index looks fine.
  await loadSurface(page);

  const inMemory = await page.evaluate(() => {
    const s = window.__surfannotate;
    return {
      xyz: [s.geometry.positions[0], s.geometry.positions[1], s.geometry.positions[2]],
      translation: window.__surfannotateUi.activeSurface().translation
    };
  });
  // lh.pial's footer reads `cras = -1.9991 0.0000 -1.9991`.
  expect(inMemory.translation[0]).toBeCloseTo(-1.9991, 3);
  expect(inMemory.translation[1]).toBeCloseTo(0, 6);
  expect(inMemory.translation[2]).toBeCloseTo(-1.9991, 3);

  const label = await page.evaluate((offset) => window.__surfannotateIo.writeFreeSurferLabel(
    Int32Array.from([0]), window.__surfannotate.geometry.positions,
    { name: 'V1', subject: 'bert', offset }
  ), inMemory.translation);

  const row = label.trimEnd().split('\n')[2].trim().split(/\s+/).map(Number);
  expect(row[0]).toBe(0);
  // Back to the values stored in lh.pial itself.
  expect(row[1]).toBeCloseTo(inMemory.xyz[0] - inMemory.translation[0], 3);
  expect(row[1]).toBeCloseTo(-38.834, 2);
  expect(row[3]).toBeCloseTo(66.908, 2);
  expect(label.split('\n')[0]).toContain('vox2ras=TkReg');
});

test('the export panel says where the coordinates come from, and warns when they are not anatomical', async ({ page }) => {
  // A label's vertex indices are right whatever surface it was drawn on, and
  // that is all freeview reads. The x/y/z only mean something on a surface that
  // sits in the subject's anatomy, and nothing in the file says which.
  await loadSurface(page);
  const hint = page.locator('#exportHint');
  await expect(hint).toContainText('Coordinates come from lh.pial');
  await expect(hint).toContainText('tkreg');
  await expect(hint).not.toHaveClass(/warn/);

  // A flat patch is detected from its geometry, not its name.
  await page.setInputFiles('#surfaceInput', join(FIXTURES, 'lh.flat.surf.gii'));
  await expect(surfaceRows(page)).toHaveCount(2);
  await expect(hint).toHaveClass(/warn/);
  await expect(hint).toContainText('not anatomical');
  // A patch is a cut of a surface, renumbered — so it must NOT send the user to
  // lh.pial, which would hide their ROIs rather than fix anything.
  await expect(hint).toContainText('different number of vertices');
  await expect(hint).toContainText('belong to this patch alone');
  await expect(hint).not.toContainText('Switch to');

  // Switching back to the anatomical surface clears the warning.
  await surfaceRows(page).first().locator('input[type=radio]').check();
  await expect(hint).not.toHaveClass(/warn/);
  await expect(hint).toContainText('lh.pial');
});

test('the warning names a loaded anatomical surface of the same topology', async ({ page }) => {
  // Same vertex indexing means the same ROI, so the fix is one click, not a
  // reload — and the hint should say which surface to click.
  await loadSurface(page);
  await page.setInputFiles('#surfaceInput', join(FIXTURES, 'lh.pial'));
  await expect(surfaceRows(page)).toHaveCount(2);

  // Rename the second copy so it reads as inflated rather than anatomical.
  await page.evaluate(() => {
    const s = window.__surfannotate;
    const entry = s.surfaces[1];
    entry.name = 'lh.inflated';
    entry.anatomical = false;
    window.__surfannotateUi.activateSurface(entry.id);
  });
  const hint = page.locator('#exportHint');
  await expect(hint).toHaveClass(/warn/);
  await expect(hint).toContainText('Switch to lh.pial before exporting');
  await expect(hint).toContainText('the ROIs come with you');
});

test('switching to a different vertex indexing says the ROIs are hidden, not lost', async ({ page }) => {
  // ROIs belong to a vertex indexing. A flat patch is a cut of a surface with
  // its own numbering, so switching to a whole hemisphere shows none of them —
  // which looks exactly like the work has been thrown away.
  await loadFlat(page);
  await saveStrip(page, 2, 'V1');
  await saveStrip(page, 9, 'V2');
  await expect(roiRows(page)).toHaveCount(2);

  await page.setInputFiles('#surfaceInput', join(FIXTURES, 'lh.realflat.surf.gii'));
  await expect(surfaceRows(page)).toHaveCount(2);
  // Loading made it active already, so go back and forth to get a real switch —
  // the announcement only fires when the user picks a surface.
  await surfaceRows(page).first().locator('input[type=radio]').check();
  await surfaceRows(page).nth(1).locator('input[type=radio]').check();

  await expect(roiRows(page)).toHaveCount(0);
  await expect(page.locator('#statusText')).toContainText('2 ROI(s) on other surfaces');
  await expect(page.locator('#statusText')).toContainText('reappear when you switch back');

  // And they do.
  await surfaceRows(page).first().locator('input[type=radio]').check();
  await expect(roiRows(page)).toHaveCount(2);
  expect(await page.evaluate(() =>
    window.__surfannotateUi.savedRois().map((a) => a.name))).toEqual(['V1', 'V2']);
});
