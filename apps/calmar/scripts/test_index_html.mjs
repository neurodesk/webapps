#!/usr/bin/env node --no-warnings
// Contract test for web/index.html under the CALMaR rewrite. Pins the sidebar
// structure the orchestrator binds to, plus that no SCT branding survives.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'web/index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'web/css/styles.css'), 'utf8');
const serviceWorker = fs.readFileSync(path.join(ROOT, 'web/coi-serviceworker.js'), 'utf8');
const runScript = fs.readFileSync(path.join(ROOT, 'web/run.sh'), 'utf8');

// Title + h1 reflect the CALMaR identity, not SCT.
assert.match(html, /<title>[^<]*CALMaR\s*\|\s*Co-designed Automated Lesion Mapping and Reporting[^<]*<\/title>/,
  'page title must include the CALMaR project name');
assert.match(html, /<h1>CALMaR<\/h1>/,
  'main heading must use CALMaR as the app name');
assert.match(html, /class=["']tagline["']>Co-designed Automated Lesion Mapping and Reporting<\/span>/,
  'header tagline must be the expanded CALMaR name');
assert.doesNotMatch(html, /Browser-based lesion atlas overlap and reporting/,
  'old browser-based tagline copy should not remain');
assert.doesNotMatch(html, /SpinalCordToolbox/i,
  'no surviving "SpinalCordToolbox" branding allowed');
assert.doesNotMatch(html, /\bSCT\b(?!\.com)/,   // allow URL fragments like spinalcordtoolbox.com
  'no surviving "SCT" branding allowed (apart from any incidental URL).');

// Sidebar sections — the orchestrator binds to these IDs. If they drift, the
// app fails silently instead of throwing, so we lock them down.
const requiredIds = [
  // Phase 32 — sidebar redesign: three primary sections (Input → Run → Results).
  // Per-stage controls live inside <details> disclosures inside Run/Results so
  // the orchestrator's bindings keep working without dominating the UI.
  '#startPage',
  '#enterAppButton',
  '#startPrivacyButton',
  '#startPrivacyInlineButton',
  '#startCitationsButton',
  '#startHowHeading',
  '#stepLoadSection',
  '#stepLesionSection',
  // (#stepNetworkSection removed; computeOverlapButton moved under the Run
  //  section's Advanced disclosure.)
  '#resultsSection',
  '#networkOverlapTable',
  '#directFunctionProfileResults',
  '#directFunctionProfileTable',
  '#downloadOverlapCsv',
  '#computeOverlapButton',
  '#outsideAtlasWarning',
  '#structuralFileInput',
  '#deepIslesDwiFileInput',
  '#deepIslesAdcFileInput',
  '#atlasSelect',
  '#lesionFileInput',
  // Phase 2a.1.4b additions: brain-extraction button (explicit trigger) and
  // the brain-mask download button.
  '#runBrainExtractionButton',
  '#downloadBrainMaskButton',
  // Phase 2a.2.3 additions: lesion-segmentation trigger button + mask
  // download button.
  '#runLesionSegmentationButton',
  '#runDeepIslesSegmentationButton',
  '#startManualMaskButton',
  '#downloadLesionMaskButton',
  // Phase 3.4 additions: registration button.
  '#runRegistrationButton',
  '#registrationQcMode',
  '#registrationBlendValue',
  '#registrationBlendLabel',
  '#checkAtlasAlignmentButton',
  // Phase 4.4 additions: Network map subsection.
  '#computeNetworkMapButton',
  '#downloadNetworkMapButton',
  // Phase 5 additions: threshold controls + thresholded download.
  '#networkThresholdValue',
  '#networkThresholdSymmetric',
  '#networkThresholdMinCluster',
  '#affectedNetworkResults',
  '#affectedNetworkTable',
  '#mapFunctionProfileResults',
  '#mapFunctionProfileTable',
  '#downloadThresholdedNetworkMapButton',
  '#showSubjectAtlasButton',
  '#downloadSubjectAtlasButton',
  // Phase 6 additions: warp+resample bridge button + one-click full chain.
  '#applyRegistrationToLesionButton',
  '#runFullPipelineButton',
// Phase 16 addition: in-browser affine pre-registration.
  '#prealignToMniButton',
  // Phase 21 addition: clear-results / new-run UX control.
  '#clearResultsButton',
  // Phase 32 additions: Advanced disclosure container.
  '#advancedStageControls',
  // Patient-space viewer layer toggles.
  '#layerToggleT1',
  '#layerToggleBrainMask',
  '#layerToggleLesionMask',
  '#layerToggleThresholdMap',
  '#layerToggleAtlasQc',
  // Split logging: default clinician-facing analysis log plus collapsed
  // technical support log.
  '#consoleOutput',
  '#copyConsole',
  '#clearConsole',
  '#technicalLogDetails',
  '#technicalConsoleOutput',
  '#copyTechnicalConsole',
  '#clearTechnicalConsole',
  // Manual lesion-mask refinement toolbar.
  '#maskDrawingToolbar',
  '#maskReviewStatus',
  '#maskApprovalBanner',
  '#manualMaskFileInput',
  '#uploadManualMaskButton',
  '#maskPaintButton',
  '#maskEraseButton',
  '#maskEraseClusterButton',
  '#maskBrushSize',
  '#maskBrushSizeLabel',
  '#maskShapeSelect',
  '#maskFilledToggle',
  '#maskUndoButton',
  '#maskBlankButton',
  '#uploadReviewMaskButton',
  '#maskSmoothButton',
  '#maskInterpolateAxis',
  '#maskInterpolateButton',
  '#maskInterpolateHelp',
  '#confirmLesionMaskButton',
  '#downloadEditedLesionMaskButton'
];
for (const id of requiredIds) {
  const escaped = id.slice(1);
  const re = new RegExp(`id=["']${escaped}["']`);
  assert.match(html, re, `index.html must contain element with ${id}`);
}

assert.match(html, /aria-label=["']CALMaR start page["']/,
  'index.html must expose a start page before the analysis workspace');
assert.match(html, /Process stroke lesion maps locally in your browser\./,
  'start page must explain that CALMaR processes stroke lesion maps locally');
assert.match(html, /Patient images, masks, voxel values, screenshots, and generated outputs stay on this computer\./,
  'start page must state that patient-derived data stays local');
assert.match(html, /How It Works[\s\S]*1\. Load T1 data[\s\S]*2\. Review the mask[\s\S]*3\. Map and report/,
  'start page must include a three-step How It Works explanation');
assert.match(html, /Atlas and model assets may be downloaded when a workflow needs them/,
  'start page privacy copy must distinguish public assets from patient-derived files');
assert.match(html, /Background execution is possible if this site is added under "Always keep these sites active" in your browser settings\./,
  'start page must explain how to allow background execution');
assert.match(css, /\.start-page\s*\{[^}]*height:\s*100vh;[^}]*overflow:\s*hidden;/,
  'start page overlay must be a one-screen layout without internal scrolling');
assert.match(css, /\.start-main\s*\{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\)\s+auto;/,
  'start page content must allocate the hero and How It Works sections within one viewport');
assert.match(css, /\.start-step\s*\{[^}]*grid-template-columns:\s*40px\s+1fr;[^}]*text-align:\s*left;/,
  'desktop start-page steps must use compact horizontal rows instead of tall cards');
assert.match(css, /\.start-step h4,\s*\.start-step p\s*\{[^}]*grid-column:\s*2;/,
  'start-page step text must stay in the text column instead of wrapping under the icon');
assert.match(css, /@media\s*\(max-width:\s*540px\)[\s\S]*\.start-links\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/,
  'mobile start-page header links must use a compact two-column grid');
const moreAppsLinks = [
  ...html.matchAll(/<a\b(?=[^>]*href=["']\.\.\/["'])(?=[^>]*class=["'][^"']*\bheader-link\b[^"']*["'])(?=[^>]*title=["']More Neurodesk web apps["'])[^>]*>[\s\S]*?<span>More Apps<\/span>[\s\S]*?<\/a>/g)
];
assert.equal(moreAppsLinks.length, 2,
  'start page and workspace headers must return to the composite More Apps page');
for (const link of moreAppsLinks) {
  assert.doesNotMatch(link[0], /target=["']_blank["']/,
    'More Apps must navigate in the current tab');
  assert.match(link[0], /<rect x=["']3["'] y=["']3["'] width=["']7["'] height=["']7["']\/>/,
    'More Apps link must use the shared 2x2 grid icon pattern');
}

const prealignButton = html.match(/<button\b[^>]*id=["']prealignToMniButton["'][^>]*>([\s\S]*?)<\/button>/i);
assert.ok(prealignButton, '#prealignToMniButton must be a button element');
assert.equal(prealignButton[1].trim(), '2 Pre-align T1',
  '#prealignToMniButton visible label must stay compact');
assert.doesNotMatch(prealignButton[1], /<sup\b/i,
  '#prealignToMniButton must not embed unit/superscript text that wraps into a broken label');
assert.match(prealignButton[0], /title=["']Pre-align T1 to the MNI160 1 mm grid["']/,
  '#prealignToMniButton title must retain the MNI160 1 mm detail');

const workflowStart = html.indexOf('aria-label="Advanced workflow order"');
const workflowEnd = html.indexOf('</details>', workflowStart);
const advancedWorkflow = workflowStart >= 0 && workflowEnd > workflowStart
  ? html.slice(workflowStart, workflowEnd)
  : '';
assert.ok(advancedWorkflow, 'advanced controls must expose an ordered workflow container');
assert.match(
  advancedWorkflow,
  /1 Brain extraction[\s\S]*2 Pre-align T1[\s\S]*3 Lesion mask[\s\S]*Auto seed mask[\s\S]*DeepISLES DWI\/ADC seed[\s\S]*Manual mask[\s\S]*Upload mask[\s\S]*4 MNI registration \(SynthMorph\)[\s\S]*5 Check atlas alignment[\s\S]*6 Warp lesion → atlas grid[\s\S]*7 Compute atlas overlap[\s\S]*8 Compute network map/,
  'advanced controls must show the seed/manual mask review workflow in execution order'
);
assert.match(html, /<label\b[^>]*for=["']atlasSelect["'][^>]*>Atlas<\/label>/,
  'atlas selector label must be exactly Atlas');
assert.match(html, /<option\s+value=["']schaefer400["']\s+selected>Schaefer 400 parcels<\/option>/,
  'atlas selector must select Schaefer 400 parcels by default');
assert.match(html, /<option\s+value=["']yeo7["']>Yeo 7 networks<\/option>/,
  'atlas selector must keep Yeo 7 networks selectable for compatibility');
assert.match(
  advancedWorkflow,
  /aria-label=["']Lesion mask source choice["'][\s\S]*id=["']runLesionSegmentationButton["'][\s\S]*id=["']runDeepIslesSegmentationButton["'][\s\S]*id=["']startManualMaskButton["'][\s\S]*id=["']uploadManualMaskButton["']/,
  'advanced controls must offer SynthStroke seed, DeepISLES seed, blank manual mask, and manual mask upload choices'
);
assert.match(
  advancedWorkflow,
  /<input\b[^>]*id=["']manualMaskFileInput["'][^>]*class=["']hidden["'][^>]*accept=["']\.nii,\.nii\.gz["'][^>]*>/i,
  'manual mask upload must use a hidden NIfTI-only file input behind the compact buttons'
);
assert.match(
  advancedWorkflow,
  /id=["']runRegistrationButton["'][\s\S]*id=["']registrationQcMode["'][\s\S]*id=["']checkAtlasAlignmentButton["'][\s\S]*id=["']registrationBlendValue["'][\s\S]*id=["']applyRegistrationToLesionButton["']/,
  'advanced QC controls must follow execution order: registration -> QC view -> check alignment -> blend -> lesion warp'
);
assert.doesNotMatch(html, /Researcher mode: lesion mask/,
  'advanced controls must not expose the researcher-mode lesion-mask upload');
assert.match(html, /<input\b[^>]*id=["']lesionFileInput["'][^>]*class=["']hidden["'][^>]*>/i,
  'manual lesion-mask input may remain only as a hidden compatibility hook');
assert.match(html, /<option\s+value=["']patient["']>Patient space<\/option>/,
  'registration QC selector must offer patient-space view');
assert.match(html, /<option\s+value=["']mni["']\s+selected>MNI space<\/option>/,
  'registration QC selector must default to MNI-space view for patient/template blending');
assert.match(html, /<option\s+value=["']checkerboard["']>Checkerboard<\/option>/,
  'registration QC selector must offer checkerboard view');
assert.match(html, /<option\s+value=["']displacement["']>Displacement<\/option>/,
  'registration QC selector must offer displacement view');
const registrationBlendInput = html.match(/<input\b[^>]*id=["']registrationBlendValue["'][^>]*>/i);
assert.ok(registrationBlendInput, 'registration QC must expose a Patient/MNI blend slider');
assert.match(registrationBlendInput[0], /type=["']range["']/,
  'Patient/MNI blend control must be a range slider');
assert.match(registrationBlendInput[0], /min=["']0["'][\s\S]*max=["']1["'][\s\S]*step=["']0\.05["'][\s\S]*value=["']0\.5["']/,
  'Patient/MNI blend slider must run from MNI-only to registered-patient-only with a 50% default');
assert.match(html, /Patient\/MNI blend/,
  'registration QC blend label must make the MNI/patient comparison explicit');
assert.doesNotMatch(html, /id=["']networkThresholdMode["']/,
  'connectivity-map threshold UI must not expose an absolute-vs-percent mode selector');
assert.doesNotMatch(html, /Absolute t-stat|Absolute mode|absolute mode/i,
  'connectivity-map threshold UI must not expose absolute t-stat thresholding');
assert.match(html, /Top voxels/,
  'connectivity-map threshold UI must present a top-percent voxel slider');
assert.match(html, /Use \|t\| magnitude/,
  'connectivity-map threshold UI may only offer top-percent ranking by magnitude, not a t-stat threshold mode');
assert.match(html, /Analysis log/,
  'default log viewer must be clinician-facing analysis log');
assert.match(html, /<details\b[^>]*id=["']technicalLogDetails["'][^>]*>/i,
  'technical support log must be a collapsed details viewer by default');
assert.doesNotMatch(html, /<details\b[^>]*id=["']technicalLogDetails["'][^>]*\bopen\b/i,
  'technical support log must not be open by default');
assert.match(html, /Copy this when reporting a problem\./,
  'technical log summary must tell users which log to send for support');
assert.match(html, /Model and processing details/,
  'technical log viewer must be labelled as model and processing details');
assert.match(html, /aria-label=["']Lesion mask drawing tools["']/,
  'viewer toolbar must expose compact lesion-mask drawing controls');
assert.match(html, /Paint[\s\S]*Erase[\s\S]*Erase cluster[\s\S]*Confirm mask/,
  'mask drawing toolbar must label whole-cluster erasing explicitly');
assert.match(html, /Erase the connected lesion cluster under the cursor/,
  'mask drawing toolbar must describe what the cluster erase action does');
assert.match(html, /Start a blank mask/,
  'mask drawing toolbar must allow blank manual lesion masks');
assert.match(html, /id=["']uploadReviewMaskButton["'][\s\S]*Upload/,
  'mask drawing toolbar must allow uploading a replacement mask during review');
assert.match(html, /Smooth the 3D mask volume/,
  'mask drawing toolbar must expose a 3D mask smoothing tool');
assert.match(html, /Interpolate mask between boundary slices/,
  'mask drawing toolbar must expose between-slice interpolation');
assert.match(html, /id=["']maskInterpolateHelp["'][\s\S]*Interpolate mask help[\s\S]*first and last non-empty slices[\s\S]*NiiVue mask interpolation/,
  'mask interpolation help must explain the boundary-slice interpolation behavior');
assert.match(html, /aria-label=["']Draw lesion mask["'][\s\S]*id=["']maskPaintButton["'][\s\S]*id=["']maskBrushSize["'][\s\S]*id=["']maskShapeSelect["'][\s\S]*id=["']maskFilledToggle["']/,
  'mask review toolbar must group drawing mode, brush, shape, and fill controls together');
assert.match(html, /aria-label=["']Mask edit actions["'][\s\S]*id=["']maskUndoButton["'][\s\S]*id=["']maskBlankButton["'][\s\S]*id=["']maskSmoothButton["']/,
  'mask review toolbar must group undo, blank, and smooth edit actions together');
assert.match(html, /aria-label=["']Mask slice interpolation["'][\s\S]*id=["']maskInterpolateAxis["'][\s\S]*id=["']maskInterpolateButton["'][\s\S]*id=["']maskInterpolateHelp["']/,
  'mask review toolbar must group interpolation axis, action, and help together');
assert.match(html, /id=["']downloadEditedLesionMaskButton["'][\s\S]*Download/,
  'mask confirmation toolbar must expose a download option for the edited mask');
assert.match(html, /class=["']mask-file-actions["'][\s\S]*id=["']uploadReviewMaskButton["'][\s\S]*id=["']downloadEditedLesionMaskButton["']/,
  'mask confirmation toolbar must group Upload and Download as file actions');
assert.match(html, /aria-label=["']Mask review actions["'][\s\S]*id=["']confirmLesionMaskButton["'][\s\S]*class=["']mask-file-actions["']/,
  'mask review toolbar must group confirm and file actions after editing tools');
assert.match(html, /id=["']maskApprovalBanner["'][\s\S]*Mask approval required[\s\S]*Review the lesion mask before analysis continues\./,
  'mask review must expose a persistent approval banner without duplicating action buttons');
assert.doesNotMatch(html, /id=["']approveLesionMaskButton["']|id=["']downloadReviewMaskButton["']/,
  'mask approval banner must not duplicate the toolbar confirm/download actions');

assert.doesNotMatch(html, /id=["']pipelineSelect["']/,
  'Pipeline selector must not be visible; Run analysis is input-driven');
assert.doesNotMatch(html, /for=["']pipelineSelect["']/,
  'Pipeline label must not be visible; internal pipeline selection is not a user-facing control');

// Helper copy should live behind compact inline help popovers, following the
// QSMbly-style "i" affordance, rather than always-visible paragraphs.
assert.match(html, /class=["'][^"']*\bhelp-icon\b[^"']*["']/,
  'index.html must include compact help icons');
assert.match(html, /class=["'][^"']*\bhelp-popover\b[^"']*["']/,
  'index.html must include help popover content');
assert.match(html, /Loading the image only displays it; processing starts when you click Run analysis/,
  'structural input help must make explicit that loading does not start processing');
assert.doesNotMatch(html, /<p\s+class=["']param-help["']/,
  'always-visible param-help paragraphs should be replaced with popovers or status text');
assert.doesNotMatch(html, /auto-promoted on file drop|auto-fires/i,
  'UI copy must not imply processing starts on file load');
assert.match(html, /Direct lesion overlap/,
  'direct lesion result section must clearly label the lesion-overlap table');
assert.match(html, /id=["']resultsSection["'][\s\S]*id=["']networkThresholdMinCluster["'][\s\S]*Direct lesion overlap/,
  'min-cluster control must appear at the beginning of Results before following result tables');
assert.match(html, /id=["']networkThresholdMinCluster["'][^>]*value=["']30["']/,
  'min-cluster control must default to 30 voxels');
assert.match(html, /Atlas labels listed here contain lesion voxels directly/,
  'direct lesion help must explain that the first table is direct lesion overlap');
assert.match(html, /Threshold connectivity map/,
  'threshold panel must identify the second result source as a connectivity map');
assert.match(html, /group-FC weighted t-map derived from the direct lesion-overlap profile/,
  'threshold help must explain the connectivity-map source');
assert.match(html, /Connectivity-map effects/,
  'threshold results must clearly label the affected-network table');
assert.match(html, /surviving the thresholded connectivity map/,
  'affected-network help must explain that the second table comes from the thresholded map');
assert.match(html, /Functional associations from direct lesion overlap/,
  'direct lesion functional profile section must clearly identify its source table');
assert.match(html, /Functional associations from connectivity-map effects/,
  'connectivity-map functional profile section must clearly identify its source table');
assert.match(html, /Exploratory literature terms are available for selected atlas labels/,
  'direct functional profile help must frame terms as exploratory literature associations');
assert.match(html, /Atlas label drivers/,
  'static functional profile tables must use atlas-label driver copy for the default Schaefer atlas');
assert.match(html, /they are not clinical predictions/,
  'functional profile help must avoid clinical prediction framing');
assert.match(html, /Show subject atlas/,
  'results actions must expose subject-space atlas QC');

// Module loader points at the new orchestrator, not the old SCT app.
assert.match(html, /<script\s[^>]*src=["']js\/lnm-app\.js["'][^>]*type=["']module["']/,
  '<script type=module src="js/lnm-app.js"> must be present');
assert.doesNotMatch(html, /spinalcordtoolbox-app\.js/,
  'old spinalcordtoolbox-app.js script tag must be gone');
assert.match(html, /<script\s[^>]*src=["']coi-serviceworker\.js["']/,
  'COI service worker script must remain loaded for same-origin mask downloads');
assert.match(html, /https:\/\/www\.googletagmanager\.com\/gtag\/js\?id=G-4Z9774J59Y/,
  'Google Analytics loader must use the Neurodesk GA4 measurement ID');
assert.match(html, /gtag\(['"]config['"],\s*['"]G-4Z9774J59Y['"]\)/,
  'Google Analytics config must use the Neurodesk GA4 measurement ID');
assert.match(html, /navigator\.doNotTrack\s*\|\|\s*window\.doNotTrack\s*\|\|\s*navigator\.msDoNotTrack/,
  'Google Analytics must check the browser Do Not Track values used by neurodesk.org');
assert.match(html, /if\s*\(!doNotTrack\)\s*{[\s\S]*?gtag\(['"]config['"],\s*['"]G-4Z9774J59Y['"]\)/,
  'Google Analytics config must be guarded by the Do Not Track check');
assert.doesNotMatch(html, /Cloudflare Web Analytics|cloudflareinsights\.com|data-cf-beacon|4312648587884e6b984b7bc189db840e/,
  'the old Cloudflare analytics provider must be absent');
assert.match(html, /Google Analytics collects aggregate page usage and performance metrics without patient images, masks, voxel values, screenshots, generated outputs, filenames, or analysis results\. If your browser's Do Not Track setting is enabled, Google Analytics tracking is not configured\./,
  'privacy copy must disclose Google Analytics data limits and Do Not Track behavior');
assert.match(serviceWorker, /__lnm_downloads/,
  'service worker must serve staged mask downloads from the same-origin route');
assert.match(serviceWorker, /lnm-mask-downloads-v1/,
  'service worker must use the mask download Cache Storage bucket');
assert.match(serviceWorker, /r\.method\s*!==\s*["']GET["'][\s\S]*event\.respondWith\(fetch\(r\)\)/,
  'service worker must let localhost download POSTs reach the dev server');
assert.match(serviceWorker, /if\s*\(!response\)\s*return\s+fetch\(r\)/,
  'service worker must let uncached localhost download GETs reach the dev server');
assert.doesNotMatch(serviceWorker, /window\.crossOriginIsolated\s*!==\s*false\s*\|\|\s*!coi\.shouldRegister\(\)/,
  'service worker registration must not be skipped when server COOP/COEP already makes the page isolated');
assert.match(runScript, /X-LNM-Stage-Only/,
  'local dev server must support staged HTTP mask downloads without direct-writing to ~/Downloads');
assert.match(runScript, /Content-Disposition/,
  'local dev server must serve staged mask downloads as attachments');
assert.match(runScript, /os\.replace\(tmp_path,\s*output_path\)/,
  'local dev server must keep atomic direct-save support for non-staged local downloads');
assert.match(runScript, /ThreadingHTTPServer/,
  'local dev server must handle download route requests without blocking other app requests');

// NiiVue canvas must remain (we reuse it for structural + lesion overlay).
assert.match(html, /id=["']gl1["']/, '#gl1 NiiVue canvas must be retained');

console.log(`index.html OK: ${requiredIds.length} required IDs, no SCT branding, lnm-app.js wired.`);
