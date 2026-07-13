import {
  CommandPreview,
  DicompareReportRenderer,
  EchoNavigator,
  FileIOController,
  LabelLegend,
  MetricsSummary,
  PipelineRegistry,
  StageResultList,
  categorizeNeuroFile,
  createElement,
  createNeuroWebapp,
  generateQsmxtCommand,
  lesionNetworkMappingPlugin,
  muscleMapPlugin,
  qsmPlugin,
  sctPlugin,
  synthstripPlugin,
  vesselBoostPlugin
} from '../../src/index.js';

const plugins = [
  synthstripPlugin,
  sctPlugin,
  vesselBoostPlugin,
  muscleMapPlugin,
  lesionNetworkMappingPlugin,
  qsmPlugin
];

const version = await loadVersion();
let app;

app = createNeuroWebapp({
  root: '#app',
  title: 'Neurodesk Webapp Components',
  subtitle: 'Reusable static neuroimaging webapp primitives',
  version,
  footerText: 'Showcase app for reusable browser neuroimaging components.',
  headerActions: [
    { id: 'aboutButton', label: 'About', onClick: () => app.modals.get('aboutModal')?.open() },
    { id: 'docsButton', label: 'Docs', onClick: () => window.open('./docs/components/catalog.md', '_blank') },
    { id: 'privacyButton', label: 'Privacy', onClick: () => app.modals.get('privacyModal')?.open() }
  ],
  viewerToolbar: {
    viewTypes: [
      { id: 'axial', label: 'Axial' },
      { id: 'sagittal', label: 'Sagittal' },
      { id: 'coronal', label: 'Coronal' },
      { id: 'render', label: '3D' }
    ],
    colormaps: [
      { id: 'gray', label: 'Gray' },
      { id: 'red-yellow', label: 'Red/Yellow' },
      { id: 'label', label: 'Labels' }
    ],
    opacity: 0.7
  },
  modals: [
    {
      id: 'aboutModal',
      title: 'About this showcase',
      content: 'This app uses the exported framework-free components directly: app shell, file triage, viewer controls, stage results, plugin metadata, command preview, echo navigation, and validation report rendering.'
    },
    {
      id: 'privacyModal',
      title: 'Privacy',
      content: 'The components are designed for local browser processing. Consuming apps decide which remote assets, models, or APIs they load.'
    }
  ]
});

app.refs.canvas.style.display = 'none';
app.refs.canvas.parentElement.appendChild(renderMockViewer());
app.refs.viewerInfoPrimary.textContent = 'Mock subject: sub-001_T1w.nii.gz | 192 x 224 x 176 | 1.0 mm isotropic';
app.refs.viewerInfoLabel.textContent = 'Overlay: spinalcord segmentation, opacity 70%';

const registry = new PipelineRegistry();
for (const plugin of plugins) registry.registerPlugin(plugin);

renderInputSection();
renderPipelineSection();
renderViewerSection();
renderPluginSection();
renderQsmSection();
renderReportSection();

app.console.log('Showcase mounted with shell, viewer toolbar, sidebar sections, stage results, plugins, and QSM command preview.');
app.setProgress(15, 'Ready');

function renderInputSection() {
  const content = createElement('div', { className: 'showcase-section-grid' }, [
    createElement('p', { text: 'FileIOController supports simple segmentation uploads and bucketed QSM-style inputs.' }),
    createElement('div', { className: 'showcase-button-row', id: 'inputModeButtons' }, [
      createElement('button', { type: 'button', text: 'Segmentation input', onclick: () => renderFiles('simple') }),
      createElement('button', { type: 'button', text: 'Bucketed QSM input', onclick: () => renderFiles('bucketed') })
    ]),
    createElement('div', { id: 'fileTriageOutput', className: 'showcase-card-grid' })
  ]);
  app.addSidebarSection({ id: 'inputs', title: 'File I/O', badge: 'drop zones', content });
  renderFiles('simple');
}

function renderPipelineSection() {
  const stageContainer = createElement('div', { id: 'stageResults' });
  const metricsContainer = createElement('div', { id: 'metricsSummary' });
  const legendContainer = createElement('div', { id: 'labelLegend' });
  const runButton = createElement('button', {
    type: 'button',
    text: 'Run mock pipeline',
    onclick: () => runMockPipeline(stageList)
  });
  const content = createElement('div', { className: 'showcase-section-grid' }, [
    createElement('p', { text: 'Stage outputs use the same result list and metrics components that inference workers update.' }),
    createElement('div', { className: 'showcase-button-row' }, [runButton]),
    metricsContainer,
    legendContainer,
    stageContainer
  ]);
  app.addSidebarSection({ id: 'pipeline', title: 'Pipeline Outputs', badge: 'events', content });

  const stageList = new StageResultList({
    element: stageContainer,
    stageLabels: {
      brainMask: 'Brain mask',
      spinalCord: 'Spinal cord segmentation',
      qsm: 'QSM susceptibility map'
    },
    onView(stage) {
      app.refs.viewerInfoLabel.textContent = `Viewing stage: ${stage}`;
      app.console.log(`ViewerController.loadStageVolume('${stage}')`);
    },
    onDownload(stage) {
      app.console.log(`downloadStage('${stage}')`);
    }
  });

  new MetricsSummary({ element: metricsContainer }).render({
    stats: [
      { label: 'Stages', value: 3 },
      { label: 'Labels', value: 4 },
      { label: 'Volume', value: '12.42 ml' }
    ]
  });
  new LabelLegend({ element: legendContainer }).render([
    { index: 1, name: 'Cord', color: [45, 212, 191, 255] },
    { index: 2, name: 'Lesion', color: [248, 113, 113, 255] },
    { index: 3, name: 'Vessel', color: [250, 204, 21, 255] }
  ], { labelVolumes: { 1: 8.51, 2: 1.22, 3: 2.69 } });
  stageList.render(sampleResults(), ['brainMask', 'spinalCord', 'qsm']);
}

function renderViewerSection() {
  const echoNav = createElement('div', { id: 'echoNav', className: 'showcase-button-row' }, [
    createElement('button', { id: 'echoPrev', type: 'button', text: 'Previous echo' }),
    createElement('span', { id: 'echoLabel', className: 'showcase-pill', text: 'Echo 1/4' }),
    createElement('button', { id: 'echoNext', type: 'button', text: 'Next echo' })
  ]);
  const content = createElement('div', { className: 'showcase-section-grid' }, [
    createElement('p', { text: 'ViewerController centralizes base volumes, overlays, segmentation-as-base, screenshots, colormaps, and echo navigation.' }),
    echoNav,
    createElement('div', { className: 'showcase-pill-row' }, [
      createElement('span', { className: 'showcase-pill', text: 'NiiVue adapter' }),
      createElement('span', { className: 'showcase-pill', text: 'Stage volume mapping' }),
      createElement('span', { className: 'showcase-pill', text: 'Window/level controls' })
    ])
  ]);
  app.addSidebarSection({ id: 'viewer', title: 'Viewer Controls', badge: 'NiiVue', content });

  const echoNavigator = new EchoNavigator({});
  echoNavigator.setViewType('magnitude');
  echoNavigator.update(4);
  document.getElementById('echoPrev').addEventListener('click', () => {
    echoNavigator.navigate(-1, 4);
    echoNavigator.update(4);
    app.console.log(`Echo index: ${echoNavigator.getState().echoIndex}`);
  });
  document.getElementById('echoNext').addEventListener('click', () => {
    echoNavigator.navigate(1, 4);
    echoNavigator.update(4);
    app.console.log(`Echo index: ${echoNavigator.getState().echoIndex}`);
  });
}

function renderPluginSection() {
  const cards = plugins.map(plugin => createElement('div', { className: 'showcase-card' }, [
    createElement('strong', { text: plugin.name }),
    createElement('span', { text: plugin.description }),
    createElement('code', { text: plugin.id })
  ]));
  const content = createElement('div', { className: 'showcase-card-grid' }, cards);
  app.addSidebarSection({ id: 'plugins', title: 'Domain Plugins', badge: String(plugins.length), content });
}

function renderQsmSection() {
  const commandText = createElement('pre', { id: 'commandText', className: 'nd-command-preview' });
  const copyButton = createElement('button', { id: 'copyCommand', type: 'button', text: 'Copy command' });
  const modal = app.addModal({
    id: 'commandModal',
    title: 'qsmxt command preview',
    content: [commandText, copyButton]
  });
  const preview = new CommandPreview({
    modal: modal.root,
    textElement: commandText,
    copyButton,
    generator: (settings, context) => generateQsmxtCommand(settings, context.maskOps, context)
  });
  const command = preview.render(
    {
      dipoleInversion: 'tv',
      tv: { lambda: 0.002 },
      mask: { method: 'bet' },
      referenceMean: false
    },
    {
      input: 'sub-001_phase_e1.nii.gz',
      output: 'sub-001_qsm.nii.gz',
      maskOps: ['threshold:otsu', 'fill-holes'],
      doSwi: true
    }
  );
  const content = createElement('div', { className: 'showcase-section-grid' }, [
    createElement('p', { text: 'QSMbly plugin hooks expose settings schemas, mask operations, Rust/WASM stages, validation, and command preview.' }),
    createElement('button', { type: 'button', text: 'Open command preview', onclick: () => preview.open({}, { maskOps: [] }) }),
    createElement('code', { text: command })
  ]);
  app.addSidebarSection({ id: 'qsm', title: 'QSM Pipeline', badge: 'WASM', content });
}

function renderReportSection() {
  const reportRoot = createElement('div', { id: 'reportRoot', className: 'showcase-report' });
  const content = createElement('div', { className: 'showcase-section-grid' }, [
    createElement('p', { text: 'Validation renderers can surface DiCompare-style acquisition checks before a worker starts.' }),
    reportRoot
  ]);
  app.addSidebarSection({ id: 'validation', title: 'Validation Report', badge: 'checks', content });
  new DicompareReportRenderer({ element: reportRoot }).render({
    acquisitions: [{ name: 'GRE multi-echo' }],
    complianceResults: [
      {
        acquisitionName: 'GRE multi-echo',
        results: [
          { passed: true, message: 'Echo spacing is consistent across 4 echoes.' },
          { passed: true, message: 'Magnitude and phase files are paired.' },
          { passed: false, message: 'BIDS JSON missing optional IntendedFor field.' }
        ]
      }
    ]
  });
}

function renderFiles(mode) {
  for (const button of document.querySelectorAll('#inputModeButtons button')) {
    button.classList.toggle('active', button.textContent.toLowerCase().includes(mode === 'simple' ? 'segmentation' : 'bucketed'));
  }
  const output = document.getElementById('fileTriageOutput');
  output.innerHTML = '';
  if (mode === 'simple') {
    const controller = new FileIOController({ mode: 'simple' });
    controller.setFile({ name: 'sub-001_T1w.nii.gz' });
    output.appendChild(renderFileCard('input', [controller.getActiveFile()?.name].filter(Boolean)));
    app.console.log('FileIOController(simple): accepted one NIfTI input.');
    return;
  }
  const controller = new FileIOController({ mode: 'bucketed' });
  const files = [
    { name: 'sub-001_magnitude_e1.nii.gz' },
    { name: 'sub-001_phase_e1.nii.gz' },
    { name: 'sub-001_phase_e2.nii.gz' },
    { name: 'sub-001_part-phase_GRE.json' },
    { name: 'sub-001_mask.nii.gz' }
  ];
  controller.addFiles(files);
  for (const bucket of ['magnitude', 'phase', 'json', 'mask', 'extra']) {
    output.appendChild(renderFileCard(bucket, controller.getBucket(bucket).map(file => file.name)));
  }
  app.console.log(`Bucketed input mode: ${controller.getInputMode()}; first file classified as ${categorizeNeuroFile(files[0])}.`);
}

function renderFileCard(label, files) {
  return createElement('div', { className: 'showcase-card' }, [
    createElement('strong', { text: label }),
    createElement('span', { text: files.length ? files.join(', ') : 'No files' })
  ]);
}

function renderMockViewer() {
  return createElement('div', { className: 'showcase-viewer' }, [
    createElement('div', {}, [
      createElement('h2', { text: 'Reusable NiiVue viewer surface' }),
      createElement('p', { text: 'Mocked anatomical base, segmentation overlay, stage outputs, and echo-aware controls show the common viewer architecture without loading patient data.' }),
      createElement('div', { className: 'showcase-slices' }, [
        createElement('div', { className: 'showcase-slice', title: 'Axial slice' }),
        createElement('div', { className: 'showcase-slice', title: 'Sagittal slice' }),
        createElement('div', { className: 'showcase-slice', title: 'Coronal slice' })
      ])
    ]),
    createElement('div', { className: 'showcase-layer-stack' }, [
      renderLayer('Base', 'T1w NIfTI'),
      renderLayer('Overlay', 'Cord / lesion labels'),
      renderLayer('Stage', 'QSM map output')
    ])
  ]);
}

function renderLayer(label, value) {
  return createElement('div', { className: 'showcase-layer' }, [
    createElement('strong', { text: label }),
    createElement('span', { text: value })
  ]);
}

function runMockPipeline(stageList) {
  app.console.log('PipelineExecutor event: init');
  app.setProgress(20, 'Loading assets');
  setTimeout(() => app.setProgress(55, 'Running worker stage'), 140);
  setTimeout(() => {
    app.setProgress(100, 'Complete');
    stageList.render(sampleResults(), ['brainMask', 'spinalCord', 'qsm']);
    app.console.log('PipelineExecutor event: stage-data for brainMask, spinalCord, qsm');
  }, 320);
}

function sampleResults() {
  return {
    brainMask: { description: 'Brain mask', fileName: 'brain_mask.nii.gz' },
    spinalCord: { description: 'Spinal cord segmentation', fileName: 'spinalcord_seg.nii.gz' },
    qsm: { description: 'QSM susceptibility map', fileName: 'qsm.nii.gz' }
  };
}

async function loadVersion() {
  try {
    const packageJson = await fetch('./package.json').then(response => response.json());
    const buildInfo = await fetch('./build-info.json').then(response => response.ok ? response.json() : null).catch(() => null);
    const suffix = buildInfo?.versionSuffix || (buildInfo?.buildEnv === 'staging' ? `-staging+${String(buildInfo.sha || '').slice(0, 7)}` : '');
    return `${packageJson.version}${suffix}`;
  } catch {
    return '0.1.0';
  }
}
