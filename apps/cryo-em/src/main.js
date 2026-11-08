// Cryo-EM webapp entry. RELION runs on the user's own neurodesk-compute server
// (ADR-0004); this page builds each step from @neurodesk/cryo-em, follows the
// job and shows what it wrote. The interface is the shared workspace vocabulary.
import '@neurodesk/webapp-components/styles/imaging-workspace.css';
import './cryoem.css';
import NiiVue, { MULTIPLANAR_TYPE, SHOW_RENDER, SLICE_TYPE } from '@niivue/niivue';
import { mountImagingWorkspace } from '@neurodesk/webapp-components/core/mount-imaging-workspace';
import {
  bindInfoTooltips,
  createComputeConnection,
  createConsole,
  createExampleSelector,
  createInfoDialog,
  createResultList,
  createViewerToolbar,
  ProgressManager,
  renderInfoIcon,
} from '@neurodesk/webapp-components/ui';
import { createNiftiFromData, createNiftiHeaderFromVolume, downloadFile } from '@neurodesk/webapp-components/file-io';
import { ComputeError } from '@neurodesk/webapp-components/compute';
import { registerAppAutomation } from '@neurodesk/webapp-components/automation';
import { validateRelionSpec } from '@neurodesk/cryo-em';
import { APP } from './config.js';
import { ENUM_TEXT, STEPS, classSelectionInputs, defaultInput, finalIterationFirst, inputChoices, jobType, parseOption, stepForm, stepLabel, typeLabel } from './steps.js';
import { displayRange, imagePixels, mrcImage, readMrc } from './mrc.js';
import { parseChecksums, postprocessFsc } from './star.js';
import { fscChartSvg } from './fsc-chart.js';
import { EXAMPLE_ROOT, EXAMPLE_SETTINGS, exampleMovies } from './example.js';
import examples from '../examples.json';

const $ = id => document.getElementById(id);
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const ACTIVE = new Set(['queued', 'running', 'cancelling']);
const PICKERS = { gain: 'gainPicker', mask: 'maskPicker' };

// 1. Shell: shared app bar, sidebar, viewer and status regions.
const workspace = mountImagingWorkspace({
  controls: '#controls',
  viewer: '#viewer',
  status: '#status',
  title: APP.title,
  subtitle: 'RELION on your own cluster',
  controlsContract: { about: '#aboutBtn', privacy: '#privacyBtn' },
});

// 2. Viewer chrome: the image, class and FSC views above, the job log below.
const toolbar = createViewerToolbar({
  views: [
    { id: 'image', label: 'Image', active: true },
    { id: 'classes', label: 'Classes' },
    { id: 'fsc', label: 'FSC' },
  ],
  window: false, overlay: false, colormap: false, download: false, screenshot: false,
});
$('viewer').prepend(toolbar);
const log = createConsole({ id: 'technicalLog', title: 'Job log', resizable: true });
$('viewer').append(log);
const progress = new ProgressManager();
const info = createInfoDialog();
const confirmDialog = createInfoDialog({ id: 'confirmDialog' });
$('aboutBtn').onclick = () => info.open(`About ${APP.title}`, $('aboutContent'));
$('privacyBtn').onclick = () => info.open('Privacy', $('privacyContent'));
bindInfoTooltips(document);

// 3. State. `values[command]` holds what the user chose; defaults fill the rest.
const state = {
  client: null,
  info: null,
  project: null,
  jobs: new Map(),
  command: 'import',
  values: Object.fromEntries(STEPS.map(step => [step.command, { inputs: {}, options: {}, profile: '' }])),
  uploads: {},
  selectedJob: null,
  following: null,
  settingsOpen: false,
  views: { image: null, classes: null, fsc: null },
};

function status(message, level = 'info') {
  progress.setText(message);
  $('statusText').classList.toggle('error', level === 'error');
  log.log(message, level);
}

function remember(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // A private window keeps no per-viewer conveniences.
  }
}

function recall(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function confirmAction(title, message, action) {
  return new Promise(resolve => {
    const text = document.createElement('p');
    text.textContent = message;
    const row = document.createElement('div');
    row.className = 'nd-row';
    const proceed = document.createElement('button');
    proceed.type = 'button';
    proceed.className = 'nd-btn nd-btn-danger';
    proceed.textContent = action;
    const keep = document.createElement('button');
    keep.type = 'button';
    keep.className = 'nd-btn nd-btn-secondary';
    keep.textContent = 'Keep';
    row.append(proceed, keep);
    let answer = false;
    proceed.onclick = () => { answer = true; confirmDialog.close(); };
    keep.onclick = () => confirmDialog.close();
    confirmDialog.root.addEventListener('close', () => resolve(answer), { once: true });
    confirmDialog.open(title, [text, row]);
    keep.focus();
  });
}

// 4. Viewer: NiiVue for micrographs and maps, canvases for stacks, SVG for the FSC.
const viewer = new NiiVue({ isDragDropEnabled: false });
let attached = null;
function viewerReady() {
  attached ??= viewer.attachTo('gl1').then(() => {
    viewer.isLegendVisible = false;
    viewer.createExtensionContext().on('locationChange', event => { $('location').textContent = event.detail.string; });
  });
  return attached;
}

function setView(view) {
  toolbar.setActive(view);
  $('classView').hidden = view !== 'classes';
  $('fscView').hidden = view !== 'fsc';
  $('gl1').hidden = view !== 'image';
  $('emptyState').hidden = view !== 'image' || Boolean(state.views.image);
  $('imageLabel').textContent = state.views[view] ?? '';
}

toolbar.addEventListener('nd-view-change', ({ detail }) => {
  if (!state.views[detail.value]) {
    status({ image: 'Open a micrograph or map from a job first', classes: 'Open class averages or particles from a job first', fsc: 'Open postprocess.star from a Post-processing job first' }[detail.value]);
    setView(Object.keys(state.views).find(view => view === 'image' || state.views[view]) ?? 'image');
    return;
  }
  setView(detail.value);
});

/** An MRC image or map as a NIfTI that only feeds NiiVue; spacing is the pixel size. */
function displayFile(mrc, name) {
  const planes = mrc.stack ? 1 : mrc.nz;
  const data = mrc.stack ? mrcImage(mrc) : mrc.data;
  const spacing = [mrc.angpix, mrc.angpix, mrc.angpix];
  const header = createNiftiHeaderFromVolume({ hdr: { dims: [3, mrc.nx, mrc.ny, planes, 1, 1, 1, 1], pixDims: [1, ...spacing, 1, 1, 1, 1], affine: [[mrc.angpix, 0, 0, 0], [0, mrc.angpix, 0, 0], [0, 0, mrc.angpix, 0], [0, 0, 0, 1]] } });
  const [calMin, calMax] = displayRange(data);
  const buffer = createNiftiFromData(data, header, { dims: [mrc.nx, mrc.ny, planes], preserveScaling: true, calMin, calMax, clampCalMax: false });
  return new File([buffer], `${name}.nii`, { type: 'application/octet-stream' });
}

async function showMrc(mrc, label) {
  await viewerReady();
  const file = displayFile(mrc, label.replace(/[^\w.-]+/g, '_'));
  await viewer.loadVolumes([{ url: file, name: file.name, colormap: 'gray' }]);
  const volume = !mrc.stack && mrc.nz > 1;
  viewer.sliceType = volume ? SLICE_TYPE.MULTIPLANAR : SLICE_TYPE.AXIAL;
  if (volume) {
    viewer.multiplanarType = MULTIPLANAR_TYPE.GRID;
    viewer.showRender = SHOW_RENDER.ALWAYS;
  }
  state.views.image = `${label} · ${mrc.nx} × ${mrc.ny}${volume ? ` × ${mrc.nz}` : ''} · ${mrc.angpix.toFixed(3)} Å/px`;
  $('viewerError').hidden = true;
  setView('image');
}

function showStack(mrc, label, { job, name } = {}) {
  const selectable = job && jobType(job.directory) === 'Class2D' && name.endsWith('_classes.mrcs');
  const inputs = selectable ? classSelectionInputs(name, state.jobs.get(job.id)?.outputs ?? []) : {};
  const chosen = new Set(inputs.particles && state.values.select.inputs.particles === inputs.particles ? state.values.select.options.classes ?? [] : []);
  const count = Math.min(mrc.nz, 400);
  const canvas = document.createElement('canvas');
  canvas.width = mrc.nx;
  canvas.height = mrc.ny;
  const cells = [];
  for (let index = 0; index < count; index += 1) {
    const image = mrcImage(mrc, index);
    // An <img>, because the shared stylesheet stretches every canvas in the viewer.
    canvas.getContext('2d').putImageData(new ImageData(imagePixels(image, mrc.nx, mrc.ny), mrc.nx, mrc.ny), 0, 0);
    const picture = document.createElement('img');
    picture.src = canvas.toDataURL();
    picture.alt = '';
    const number = index + 1;
    const cell = document.createElement(selectable ? 'button' : 'div');
    cell.className = 'cryoem-class';
    const caption = document.createElement('span');
    caption.textContent = String(number);
    cell.append(picture, caption);
    if (selectable) {
      cell.type = 'button';
      cell.dataset.class = String(number);
      cell.setAttribute('aria-label', `Class ${number}`);
      cell.setAttribute('aria-pressed', String(chosen.has(number)));
      cell.onclick = () => {
        const on = cell.getAttribute('aria-pressed') !== 'true';
        cell.setAttribute('aria-pressed', String(on));
        if (on) chosen.add(number);
        else chosen.delete(number);
        chooseClasses(inputs, [...chosen].sort((a, b) => a - b));
      };
    }
    cells.push(cell);
  }
  $('classGrid').replaceChildren(...cells);
  $('classSummary').textContent = selectable
    ? 'Click the classes to keep; they fill Class selection.'
    : `${mrc.nz} images${mrc.nz > count ? `, the first ${count} shown` : ''}`;
  state.views.classes = `${label} · ${mrc.nz} images of ${mrc.nx} × ${mrc.ny}`;
  setView('classes');
}

/** Fills Class selection from the classes clicked in one iteration's averages. */
function chooseClasses(inputs, classes) {
  const select = state.values.select;
  select.options.mode = 'classes';
  select.options.classes = classes;
  Object.assign(select.inputs, inputs);
  status(classes.length ? `Classes ${classes.join(', ')} chosen for Class selection` : 'No classes chosen');
  if (state.command === 'select') renderForm();
}

function showFsc(fsc, label) {
  $('fscLead').textContent = `Final resolution ${fsc.finalResolution.toFixed(2)} Å · B-factor ${fsc.bfactor} Å²`;
  $('fscChart').innerHTML = fscChartSvg(fsc);
  state.views.fsc = `${label} · ${fsc.finalResolution.toFixed(2)} Å`;
  setView('fsc');
}

// 5. Compute server connection; the app needs the HPC features (protocol "HPC features").
// neurodesk-compute --www serves the app at the origin root; the catalogue
// serves it under /cryo-em/, where probing /api/v1/info would only 404.
const servedByComputeServer = new URL('.', location.href).pathname === '/';
const connection = createComputeConnection({ id: 'computeConnection', storageKey: 'cryo-em.compute', tool: 'relion', autodetect: servedByComputeServer });
$('computeControl').append(connection);

function serverFits(serverInfo) {
  const features = serverInfo?.features ?? [];
  return serverInfo?.ownership === 'single'
    && features.includes('projects')
    && features.includes('dataRoots')
    && Boolean(serverInfo.tools?.some(tool => tool.id === 'relion'));
}

connection.addEventListener('nd-compute-change', ({ detail }) => {
  const ready = detail.state === 'connected' || detail.state === 'simulated';
  const fits = ready && serverFits(detail.info);
  $('serverNeeds').hidden = !ready || fits;
  state.client = fits ? detail.client : null;
  state.info = fits ? detail.info : null;
  if (fits) {
    log.log(`Compute server ready: ${connection.message.textContent}`, detail.state === 'simulated' ? 'warning' : 'success');
    progress.reset('Connected · choose or create a project');
    loadProjects(recall('cryo-em.project')).catch(error => status(`Projects unavailable: ${error.message}`, 'error'));
  } else if (detail.state !== 'connecting') {
    state.project = null;
    state.jobs.clear();
    renderProjects([]);
    renderJobs();
  }
  syncControls();
});

// 6. Projects.
function renderProjects(projects) {
  const select = $('projectSelect');
  const options = [new Option(state.client ? (projects.length ? 'Choose a project…' : 'No projects yet') : 'Connect to a server first', '')];
  for (const project of projects) options.push(new Option(project.name, project.id));
  select.replaceChildren(...options);
  select.value = state.project?.id ?? '';
}

async function loadProjects(preferred = state.project?.id) {
  const { projects } = await state.client.projects();
  if (preferred && projects.some(project => project.id === preferred)) {
    state.project = { id: preferred };
    renderProjects(projects);
    await openProject(preferred);
  } else {
    state.project = null;
    renderProjects(projects);
    renderJobs();
    renderForm();
  }
}

async function openProject(id) {
  state.project = id ? { id } : null;
  state.selectedJob = null;
  state.jobs.clear();
  remember('cryo-em.project', id);
  if (id) await refreshProject();
  else {
    renderJobs();
    renderForm();
  }
  $('jobsSection').open = Boolean(id);
  syncControls();
}

/** Re-read the project and the details (outputs) of jobs that changed. */
async function refreshProject() {
  const client = state.client;
  const project = await client.project(state.project.id);
  if (client !== state.client || state.project?.id !== project.id) return;
  state.project = project;
  await Promise.all(project.jobs.map(async job => {
    const known = state.jobs.get(job.id);
    if (known && known.status === job.status && TERMINAL.has(job.status)) return;
    state.jobs.set(job.id, { ...job, ...await client.job(job.id) });
  }));
  for (const id of state.jobs.keys()) if (!project.jobs.some(job => job.id === id)) state.jobs.delete(id);
  renderJobs();
  renderForm();
  const active = [...project.jobs].reverse().find(job => ACTIVE.has(job.status));
  if (active && !state.following) void follow(active.id, `${stepLabel(active.command)} (${active.directory})`);
}

$('projectSelect').addEventListener('change', event => {
  void openProject(event.target.value).catch(error => status(`Project unavailable: ${error.message}`, 'error'));
});

$('createProject').addEventListener('click', async () => {
  const name = $('projectName').value.trim();
  if (!name) {
    status('Name the new project first', 'error');
    $('projectName').focus();
    return;
  }
  try {
    const project = await state.client.createProject(name);
    $('projectName').value = '';
    status(`Project ${project.name} created`);
    await loadProjects(project.id);
  } catch (error) {
    status(`Could not create the project: ${error.message}`, 'error');
  }
});

$('deleteProject').addEventListener('click', async () => {
  const project = state.project;
  if (!project || !await confirmAction('Delete project', `Delete ${project.name} and every file its ${project.jobs?.length ?? 0} jobs wrote on the server? This cannot be undone.`, 'Delete project')) return;
  try {
    await state.client.removeProject(project.id);
    status(`Project ${project.name} deleted`);
    state.project = null;
    await loadProjects(null);
  } catch (error) {
    status(error instanceof ComputeError && error.status === 409 ? 'Wait for the running job to end before deleting the project' : `Could not delete the project: ${error.message}`, 'error');
  }
});

// 7. Jobs and their outputs.
const results = createResultList({
  element: $('resultList'),
  onView: (name) => void viewOutput(state.selectedJob, name),
  onDownload: (name) => void downloadOutput(state.selectedJob, name),
});

function jobLabel(job) {
  return `${job.directory} · ${job.status}`;
}

function renderJobs() {
  const jobs = state.project?.jobs ?? [];
  const rows = jobs.map(job => {
    const row = document.createElement('div');
    row.className = 'nd-volume-toggle';
    row.dataset.job = job.id;
    const view = document.createElement('button');
    view.type = 'button';
    view.className = `nd-view-btn${job.id === state.selectedJob ? ' active' : ''}`;
    view.textContent = 'View';
    view.setAttribute('aria-label', `View ${job.directory}`);
    view.onclick = () => selectJob(job.id);
    const label = document.createElement('span');
    label.className = 'nd-stage-label';
    label.textContent = jobLabel(job);
    row.append(view, label);
    return row;
  });
  if (!rows.length) {
    const empty = document.createElement('p');
    empty.className = 'nd-empty-state';
    empty.textContent = state.project ? 'No jobs yet' : 'Choose a project';
    rows.push(empty);
  }
  $('jobList').replaceChildren(...rows);
  renderOutputs();
}

function viewable(name) {
  return /\.(mrc|mrcs|ctf)$/.test(name) || name.endsWith('/postprocess.star');
}

function renderOutputs() {
  const job = state.jobs.get(state.selectedJob);
  $('deleteJob').hidden = !job;
  $('jobSummary').hidden = !job;
  if (!job) {
    results.render({});
    return;
  }
  const outputs = job.outputs ?? [];
  const kept = outputs.filter(output => output.download === false).length;
  $('jobSummary').textContent = [
    jobLabel(job),
    job.error?.message,
    kept ? `${kept} larger file${kept === 1 ? '' : 's'} stay on the cluster` : '',
  ].filter(Boolean).join(' · ');
  const listed = outputs
    .filter(output => output.download !== false)
    .sort((a, b) => (a.name.split('/').length - b.name.split('/').length) || a.name.localeCompare(b.name));
  results.render(
    Object.fromEntries(listed.map(output => [output.name, { description: output.name.slice(job.directory.length + 1), viewable: viewable(output.name) }])),
    listed.map(output => output.name),
  );
}

/** The output a finished step shows first. */
function primaryOutput(job) {
  const names = (job.outputs ?? []).filter(output => output.download !== false).map(output => output.name).sort(finalIterationFirst);
  const pick = pattern => names.find(name => pattern.test(name));
  return {
    motioncorr: pick(/\/Movies\/[^/]+\.mrc$/),
    ctffind: pick(/\.ctf$/),
    extract: pick(/\.mrcs$/),
    class2d: pick(/_classes\.mrcs$/),
    initialmodel: pick(/\/initial_model\.mrc$/),
    refine3d: pick(/\/run_class001\.mrc$/),
    maskcreate: pick(/\/mask\.mrc$/),
    postprocess: pick(/\/postprocess\.star$/),
  }[job.command];
}

function selectJob(id, { show = false } = {}) {
  state.selectedJob = id;
  const job = state.jobs.get(id);
  renderJobs();
  $('outputSection').open = Boolean(job);
  const first = job && primaryOutput(job);
  if (show && first) void viewOutput(id, first);
}

async function fetchOutput(id, name) {
  const blob = await state.client.output(id, name);
  return new File([blob], name.split('/').pop(), { type: blob.type });
}

async function viewOutput(id, name) {
  const job = state.jobs.get(id);
  if (!job) return;
  try {
    const file = await fetchOutput(id, name);
    if (name.endsWith('.star')) showFsc(postprocessFsc(await file.text()), name);
    else {
      const mrc = readMrc(await file.arrayBuffer());
      if (mrc.stack) showStack(mrc, name, { job, name });
      else await showMrc(mrc, name);
    }
  } catch (error) {
    $('viewerError').hidden = false;
    $('viewerError').textContent = `Cannot show ${name}: ${error.message}`;
    status(`Cannot show ${name}: ${error.message}`, 'error');
  }
}

async function downloadOutput(id, name) {
  try {
    downloadFile(await fetchOutput(id, name));
    status(`${name} downloaded`);
  } catch (error) {
    status(`Download failed: ${error.message}`, 'error');
  }
}

$('deleteJob').addEventListener('click', async () => {
  const job = state.jobs.get(state.selectedJob);
  if (!job || !await confirmAction('Delete job', `Delete ${job.directory} and its files on the server? This cannot be undone.`, 'Delete job')) return;
  try {
    await state.client.remove(job.id);
    status(`${job.directory} deleted`);
    state.selectedJob = null;
    await refreshProject();
  } catch (error) {
    status(error instanceof ComputeError && error.status === 409 ? `${job.directory} cannot be deleted: ${error.message}` : `Could not delete ${job.directory}: ${error.message}`, 'error');
  }
});

// 8. The step form, generated from commands.json.
const stepSelect = $('stepSelect');
stepSelect.replaceChildren(...STEPS.map(step => new Option(step.label, step.command)));
stepSelect.addEventListener('change', () => {
  state.command = stepSelect.value;
  renderForm();
});

function fieldElement(id, label, unit, help, control) {
  const wrapper = document.createElement('div');
  wrapper.className = 'nd-field';
  const text = document.createElement('label');
  text.htmlFor = id;
  text.textContent = label;
  if (unit) {
    const small = document.createElement('small');
    small.textContent = unit;
    text.append(' ', small);
  }
  if (help) text.append(' ', renderInfoIcon(help, { label: `About ${label.toLowerCase()}` }));
  wrapper.append(text, control);
  return wrapper;
}

function optionControl(command, option) {
  const id = `option-${option.name}`;
  const values = state.values[command].options;
  const current = values[option.name] ?? option.default;
  const onChange = event => {
    const target = event.currentTarget;
    values[option.name] = parseOption(option, option.type === 'bool' ? target.checked : target.value);
    $('formMessage').hidden = true;
    if (stepForm(command, state.values[command]).controlling.has(option.name)) renderForm();
  };
  if (option.type === 'bool') {
    const label = document.createElement('label');
    label.className = 'nd-check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = id;
    input.checked = Boolean(current);
    input.addEventListener('change', onChange);
    label.append(input, ` ${option.label}`);
    if (option.help) label.append(' ', renderInfoIcon(option.help, { label: `About ${option.label.toLowerCase()}` }));
    return label;
  }
  let control;
  if (option.type === 'enum') {
    control = document.createElement('select');
    control.append(...option.enum.map(value => new Option(ENUM_TEXT[option.name]?.[value] ?? value, value)));
    if (option.required && current === undefined) control.prepend(new Option('Choose…', ''));
    control.value = current ?? '';
  } else {
    control = document.createElement('input');
    if (option.type === 'int' || option.type === 'number') {
      control.type = 'number';
      if (option.min !== undefined) control.min = String(option.min);
      if (option.max !== undefined) control.max = String(option.max);
      control.step = option.type === 'int' ? String(option.multipleOf ?? 1) : 'any';
    } else control.type = 'text';
    control.value = Array.isArray(current) ? current.join(', ') : (current ?? '');
    if (option.type === 'int-list') control.placeholder = '1, 3, 5';
  }
  control.id = id;
  control.addEventListener('change', onChange);
  return fieldElement(id, option.label, option.unit, option.help, control);
}

/** The input's value: the user's choice, else the newest matching output. */
function inputValue(command, input) {
  const chosen = state.values[command].inputs[input.name];
  if (chosen !== undefined) return chosen;
  return defaultInput(input, state.project?.jobs?.map(job => state.jobs.get(job.id) ?? job) ?? []);
}

function inputControl(command, input) {
  const id = `input-${input.name}`;
  const values = state.values[command].inputs;
  const value = inputValue(command, input);
  const wrapper = document.createElement('div');
  if (input.accept.includes('dataRoot')) {
    wrapper.append(rootBrowser(id, input, value, next => { values[input.name] = next; }));
    return wrapper;
  }
  const select = document.createElement('select');
  select.id = id;
  const jobs = state.project?.jobs?.map(job => state.jobs.get(job.id) ?? job) ?? [];
  const choices = inputChoices(input, jobs);
  if (input.optional) select.append(new Option('None', ''));
  else if (!choices.length) select.append(new Option(`Run ${input.from.map(typeLabel).join(' or ')} first`, ''));
  for (const choice of choices) select.append(new Option(choice.path, choice.path));
  if (input.accept.includes('dataFile')) select.append(new Option('File in a data root…', '@dataFile'));
  if (input.accept.includes('part')) select.append(new Option('Upload an MRC file…', '@part'));
  const kind = value === null || value === undefined ? '' : typeof value === 'string' ? value : value.part ? '@part' : '@dataFile';
  select.value = kind;
  select.addEventListener('change', () => {
    const choice = select.value;
    values[input.name] = choice === '' ? null
      : choice === '@part' ? { part: input.name }
        : choice === '@dataFile' ? { root: state.info.dataRoots[0]?.id ?? '', path: '' }
          : choice;
    $('formMessage').hidden = true;
    renderForm();
  });
  wrapper.append(fieldElement(id, input.label, '', input.help, select));
  if (kind === '@dataFile') wrapper.append(rootBrowser(`${id}-file`, input, value, next => { values[input.name] = next; }));
  if (kind === '@part') {
    const picker = $(PICKERS[input.name]);
    const file = state.uploads[input.name];
    picker.querySelector('span').textContent = file ? `${file.name} · ${(file.size / 1e6).toFixed(1)} MB` : `Choose an MRC ${input.label.toLowerCase()}`;
    picker.classList.toggle('has-files', Boolean(file));
    wrapper.append(picker);
  }
  return wrapper;
}

/** Browse a data root: folders for movies (with a file pattern), files for one file. */
function rootBrowser(id, input, value, onChange) {
  const pickFile = !input.accept.includes('dataRoot');
  const roots = state.info?.dataRoots ?? [];
  const current = { root: value?.root ?? roots[0]?.id ?? '', path: value?.path ?? '', pattern: value?.pattern ?? '*.tiff' };
  const directory = () => (pickFile ? current.path.split('/').slice(0, -1).join('/') : current.path);
  let folder = pickFile && value?.path ? directory() : current.path;
  const box = document.createElement('div');
  const rootSelect = document.createElement('select');
  rootSelect.id = `${id}-root`;
  rootSelect.append(...roots.map(root => new Option(root.label, root.id)));
  if (current.root && !roots.some(root => root.id === current.root)) rootSelect.append(new Option(current.root, current.root));
  rootSelect.value = current.root;
  const where = document.createElement('p');
  where.className = 'nd-file-info';
  const list = document.createElement('div');
  list.className = 'cryoem-entries';
  list.setAttribute('role', 'list');
  const pattern = document.createElement('input');
  pattern.type = 'text';
  pattern.id = `${id}-pattern`;
  pattern.value = current.pattern;
  const emit = () => {
    onChange(pickFile ? { root: current.root, path: current.path } : { root: current.root, path: folder, pattern: current.pattern });
    $('formMessage').hidden = true;
  };
  let token = 0;
  const load = async () => {
    const mine = ++token;
    where.textContent = `${current.root || 'No data root'} / ${folder || '(top)'}`;
    list.replaceChildren();
    if (!state.client) where.textContent += ' · connect to list its files';
    if (!state.client || !current.root) return;
    let entries = [];
    try {
      let cursor = null;
      do {
        const page = await state.client.entries(current.root, folder, cursor);
        entries = entries.concat(page.entries);
        cursor = page.next;
      } while (cursor && entries.length < 5000);
    } catch (error) {
      if (mine === token) where.textContent = `${current.root} / ${folder}: ${error.message}`;
      return;
    }
    if (mine !== token) return;
    const button = (text, onClick, pressed) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'nd-btn nd-btn-secondary nd-btn-sm';
      item.textContent = text;
      item.setAttribute('role', 'listitem');
      if (pressed !== undefined) item.setAttribute('aria-pressed', String(pressed));
      item.onclick = onClick;
      return item;
    };
    const items = [];
    if (folder) items.push(button('.. (up)', () => { folder = folder.split('/').slice(0, -1).join('/'); if (!pickFile) emit(); void load(); }));
    for (const entry of entries.filter(item => item.kind === 'directory')) {
      items.push(button(`${entry.name}/`, () => { folder = folder ? `${folder}/${entry.name}` : entry.name; if (!pickFile) emit(); void load(); }));
    }
    const files = entries.filter(item => item.kind === 'file');
    if (pickFile) {
      for (const entry of files) {
        const path = folder ? `${folder}/${entry.name}` : entry.name;
        items.push(button(entry.name, () => { current.path = path; emit(); void load(); }, path === current.path));
      }
    } else {
      const matcher = new RegExp(`^${current.pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
      where.textContent += ` · ${files.filter(entry => matcher.test(entry.name)).length} of ${files.length} files match`;
    }
    list.replaceChildren(...items);
  };
  rootSelect.addEventListener('change', () => {
    current.root = rootSelect.value;
    folder = '';
    current.path = '';
    emit();
    void load();
  });
  pattern.addEventListener('change', () => {
    current.pattern = pattern.value.trim();
    emit();
    void load();
  });
  box.append(fieldElement(rootSelect.id, `${input.label} from`, '', '', rootSelect), where, list);
  if (!pickFile) box.append(fieldElement(pattern.id, 'File pattern', '', 'Matches names in this folder: * is any run of characters, ? one character.', pattern));
  if (value === undefined || (!pickFile && value.path === undefined)) emit();
  void load();
  return box;
}

function profileControl(command) {
  const select = document.createElement('select');
  select.id = 'profileSelect';
  select.append(new Option('Server default', ''), ...(state.info?.profiles ?? []).map(profile => new Option(`${profile.name} · ${profile.summary}`, profile.name)));
  select.value = state.values[command].profile;
  select.addEventListener('change', () => { state.values[command].profile = select.value; });
  return fieldElement(select.id, 'Resources', '', 'A resource profile the server operator configured; each step has its own default.', select);
}

function renderForm() {
  const command = state.command;
  stepSelect.value = command;
  const form = stepForm(command, state.values[command]);
  // Pickers go back to their holder before the form is rebuilt.
  for (const id of Object.values(PICKERS)) $('pickers').append($(id));
  const nodes = [
    ...form.inputs.map(input => inputControl(command, input)),
    ...form.required.map(option => optionControl(command, option)),
  ];
  const settings = document.createElement('details');
  settings.className = 'nd-sidebar-section';
  settings.id = 'stepSettings';
  settings.open = state.settingsOpen;
  settings.addEventListener('toggle', () => { state.settingsOpen = settings.open; });
  const summary = document.createElement('summary');
  summary.className = 'nd-section-title';
  summary.textContent = 'Settings';
  const content = document.createElement('div');
  content.className = 'nd-section-content';
  content.append(...form.settings.map(option => optionControl(command, option)), profileControl(command));
  settings.append(summary, content);
  $('stepForm').replaceChildren(...nodes, settings);
  bindInfoTooltips($('stepForm'));
  $('runButton').textContent = `Run ${stepLabel(command).toLowerCase()}`;
  syncControls();
}

function syncControls() {
  const connected = Boolean(state.client);
  const busy = Boolean(state.following);
  $('projectSelect').disabled = !connected;
  $('projectName').disabled = !connected;
  $('createProject').disabled = !connected;
  $('deleteProject').disabled = !connected || !state.project || busy;
  $('deleteJob').disabled = busy;
  $('runButton').disabled = !connected || !state.project || busy;
  $('runButton').title = !connected ? 'Connect to a compute server first' : !state.project ? 'Choose or create a project first' : busy ? 'Wait for the running job to end' : '';
}

/** The spec of the current step, checked by the same validation the servers apply. */
function buildSpec() {
  const command = state.command;
  const form = stepForm(command, state.values[command]);
  const inputs = {};
  const files = {};
  for (const input of form.inputs) {
    const value = inputValue(command, input);
    if (value === null || value === undefined || value === '') continue;
    if (value.part) {
      if (!state.uploads[input.name]) throw new Error(`Choose an MRC file for ${input.label.toLowerCase()}`);
      files[input.name] = state.uploads[input.name];
    }
    inputs[input.name] = value;
  }
  const options = {};
  for (const option of [...form.required, ...form.settings]) {
    const value = state.values[command].options[option.name];
    if (value !== undefined) options[option.name] = value;
  }
  const spec = { tool: 'relion', command, project: state.project.id, inputs, options };
  if (state.values[command].profile) spec.profile = state.values[command].profile;
  validateRelionSpec(spec, { parts: Object.keys(files) });
  return { spec, files };
}

$('runButton').addEventListener('click', async () => {
  let request;
  try {
    request = buildSpec();
  } catch (error) {
    $('formMessage').textContent = error.message;
    $('formMessage').hidden = false;
    status(`Check the step: ${error.message}`, 'error');
    return;
  }
  $('formMessage').hidden = true;
  const label = stepLabel(state.command);
  try {
    const receipt = await state.client.submit(request.spec, request.files);
    log.log(`Submitted ${label}: ${JSON.stringify(request.spec)}`);
    const following = follow(receipt.id, label);
    await refreshProject();
    await following;
  } catch (error) {
    $('formMessage').textContent = error.message;
    $('formMessage').hidden = false;
    status(`${label} was not accepted: ${error.message}`, 'error');
  }
});

// 9. Following a job: the footer is the only live status.
function queuedText(label, event, job) {
  if (job?.scheduler?.state) return `${label}: ${job.message || `Slurm ${job.scheduler.state}`}`;
  return event.position > 0 ? `${label}: queued behind ${event.position}` : `${label}: queued`;
}

async function follow(id, label) {
  const client = state.client;
  const controller = new AbortController();
  state.following = { id, controller };
  syncControls();
  progress.begin(`${label}: queued`);
  try {
    const done = await client.watch(id, {
      onStatus: event => {
        if (event.status === 'queued') progress.setText(queuedText(label, event));
        else if (event.status === 'running') progress.setText(`${label}: running`);
        else if (event.status === 'cancelling') progress.setText(`${label}: cancelling…`);
      },
      onProgress: event => progress.setProgress(event.fraction, `${label}: ${event.stage}`),
      onLog: event => log.log(event.line, event.level),
    }, { signal: controller.signal });
    progress.end(`${label} finished${done.simulated ? ' (simulated)' : ''}`);
    log.log(`${label} finished in ${done.directory}`, 'success');
  } catch (error) {
    if (controller.signal.aborted) return;
    const cancelled = error instanceof ComputeError && error.code === 'cancelled';
    progress.end(cancelled ? `${label} cancelled` : `${label} failed: ${error.message}`, { success: false });
    $('statusText').classList.toggle('error', !cancelled);
    log.log(cancelled ? `${label} cancelled` : `${label} failed: ${error.message}`, cancelled ? 'warning' : 'error');
  } finally {
    if (state.following?.id === id) state.following = null;
    syncControls();
  }
  if (client !== state.client || !state.project) return;
  await refreshProject();
  selectJob(id, { show: state.jobs.get(id)?.status === 'succeeded' });
}

$('cancelButton').addEventListener('click', async () => {
  const running = state.following;
  if (!running) return;
  progress.setCancellable(false);
  progress.setText('Cancelling…');
  try {
    await state.client.cancel(running.id);
  } catch (error) {
    status(`Cancel failed: ${error.message}`, 'error');
    progress.setCancellable(true);
  }
});

// 10. Uploaded MRC inputs: their pickers, and a page drop onto the gain picker.
for (const [name, picker] of Object.entries(PICKERS)) {
  const input = $(picker).querySelector('input');
  input.addEventListener('change', () => {
    const file = [...input.files].find(item => /\.mrc$/i.test(item.name)) ?? input.files[0];
    input.value = '';
    if (!file) return;
    state.uploads[name] = file;
    const owner = name === 'gain' ? 'motioncorr' : state.command;
    if (state.values[owner]?.inputs) state.values[owner].inputs[name] = { part: name };
    if (name === 'gain') state.command = 'motioncorr';
    status(`${file.name} will be uploaded with ${stepLabel(state.command)}`);
    renderForm();
  });
}

// 11. The RELION tutorial: settings here, movies already on the server.
const exampleControl = createExampleSelector({
  examples,
  fileActions: false,
  scope: $('controls'),
  onStatus: (message, error) => status(message, error ? 'error' : 'info'),
  onLoad: async (_example, { fetchFiles, assertCurrent }) => {
    const [checksums] = await fetchFiles();
    const movies = exampleMovies(parseChecksums(await checksums.text()));
    assertCurrent();
    let note = 'connect a server with the examples data root to run it';
    if (state.client && state.info.dataRoots?.some(root => root.id === EXAMPLE_ROOT)) {
      const listing = await state.client.entries(EXAMPLE_ROOT, EXAMPLE_SETTINGS.import.inputs.movies.path).catch(() => ({ entries: [] }));
      const present = new Set(listing.entries.map(entry => entry.name));
      const missing = movies.filter(name => !present.has(name));
      if (missing.length) throw new Error(`The server's examples root lacks ${missing.length} of the ${movies.length} tutorial movies; run neurodesk-compute fetch-example relion-tutorial`);
      note = `${movies.length} movies found on the server`;
    } else if (state.client) {
      note = 'this server has no examples data root; run neurodesk-compute fetch-example relion-tutorial';
    }
    assertCurrent();
    for (const [command, settings] of Object.entries(EXAMPLE_SETTINGS)) {
      Object.assign(state.values[command].inputs, structuredClone(settings.inputs ?? {}));
      Object.assign(state.values[command].options, structuredClone(settings.options ?? {}));
    }
    state.command = 'import';
    renderForm();
    status(`RELION tutorial settings loaded · ${note}`);
  },
});
$('exampleControl').append(exampleControl);

// 12. Automation: open an MRC map or image in the viewer.
registerAppAutomation({
  app: APP.id,
  operations: {
    'open-map': async ({ inputs, signal }) => {
      const [file] = inputs.map;
      const mrc = readMrc(await file.arrayBuffer());
      signal.throwIfAborted();
      if (mrc.stack) showStack(mrc, file.name);
      else await showMrc(mrc, file.name);
      return { artifacts: [], summary: { nx: mrc.nx, ny: mrc.ny, nz: mrc.nz, angpix: mrc.angpix, stack: mrc.stack } };
    },
  },
});

renderForm();
renderJobs();
window.addEventListener('pagehide', () => {
  exampleControl.destroy();
  state.following?.controller.abort();
});

export default Object.freeze({ workspace, toolbar, log, info, results, connection });
