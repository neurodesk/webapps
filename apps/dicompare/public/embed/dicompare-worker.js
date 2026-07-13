/**
 * dicompare Web Worker
 * Runs Pyodide + dicompare Python package in a background thread
 * for DICOM protocol validation.
 *
 * This is a classic (non-module) worker because Pyodide must be loaded
 * via importScripts() from CDN when there's no bundler.
 *
 * Provided by dicompare-web for embedding in third-party tools.
 * See: https://github.com/astewartau/dicompare-web
 */

const PYODIDE_CDN = 'https://cdn.jsdelivr.net/pyodide/v0.27.0/full/';
// Version updated automatically by the version-bump GitHub Action on release
const DICOMPARE_PACKAGE = 'dicompare==0.6.0';

let pyodide = null;

// --- Response helpers ---

function sendResponse(response) {
  self.postMessage(response);
}

function sendSuccess(id, payload) {
  sendResponse({ id, type: 'success', payload });
}

function sendError(id, error) {
  sendResponse({ id, type: 'error', error: { message: error.message || String(error) } });
}

function sendProgress(id, payload) {
  sendResponse({ id, type: 'progress', payload });
}

// --- Initialization ---

async function initializePyodide(requestId) {
  console.log('[dicompare Worker] Initializing Pyodide...');
  const startTime = Date.now();

  sendProgress(requestId, { percentage: 5, currentOperation: 'Loading Python runtime...' });

  importScripts(PYODIDE_CDN + 'pyodide.js');

  sendProgress(requestId, { percentage: 10, currentOperation: 'Starting Python...' });

  pyodide = await loadPyodide({ indexURL: PYODIDE_CDN });

  const loadTime = Date.now() - startTime;
  console.log(`[dicompare Worker] Pyodide loaded in ${loadTime}ms`);

  sendProgress(requestId, { percentage: 30, currentOperation: 'Installing packages...' });
  await pyodide.loadPackage(['micropip', 'sqlite3']);

  sendProgress(requestId, { percentage: 50, currentOperation: 'Installing DICOM analysis tools...' });

  await pyodide.runPythonAsync(`
import micropip
await micropip.install('${DICOMPARE_PACKAGE}')

import dicompare
import dicompare.interface
import dicompare.validation
import json
from typing import List, Dict, Any

print("[dicompare Worker] dicompare modules imported successfully")
  `);

  // Get versions
  const versionResult = await pyodide.runPython(`
import json, sys, dicompare
json.dumps({
    'pyodide': '.'.join(map(str, sys.version_info[:3])),
    'dicompare': getattr(dicompare, '__version__', 'unknown')
})
  `);

  const versions = JSON.parse(versionResult);
  console.log(`[dicompare Worker] Ready - Python ${versions.pyodide}, dicompare ${versions.dicompare}`);

  sendProgress(requestId, { percentage: 100, currentOperation: 'Ready' });
  sendSuccess(requestId, versions);
}

// --- DICOM Analysis ---

async function handleAnalyzeFiles(id, payload) {
  if (!pyodide) throw new Error('Pyodide not initialized');

  const { fileNames, fileContents } = payload;
  console.log(`[dicompare Worker] Analyzing ${fileNames.length} files...`);

  // Set up progress callback
  pyodide.globals.set('progress_callback', (progress) => {
    const p = progress.toJs ? progress.toJs() : progress;
    sendProgress(id, {
      percentage: p.percentage || 0,
      currentOperation: p.currentOperation || 'Processing...',
      totalFiles: p.totalFiles || fileNames.length,
      totalProcessed: p.totalProcessed || 0
    });
  });

  // Convert ArrayBuffers to Uint8Arrays for Pyodide
  const contents = fileContents.map(buf => new Uint8Array(buf));

  pyodide.globals.set('dicom_file_names', fileNames);
  pyodide.globals.set('dicom_file_contents', contents);

  const result = await pyodide.runPythonAsync(`
import json
from dicompare.interface import analyze_dicom_files_for_ui

names = list(dicom_file_names)
total_files = len(names)
print(f"[dicompare Worker] Processing {total_files} files...")

dicom_bytes = {}
for i, name in enumerate(names):
    content = dicom_file_contents[i]
    if hasattr(content, 'getBuffer'):
        buf = content.getBuffer()
        dicom_bytes[name] = bytes(buf.data)
        buf.release()
    elif hasattr(content, 'to_py'):
        dicom_bytes[name] = bytes(content.to_py())
    else:
        dicom_bytes[name] = bytes(content)

print(f"[dicompare Worker] Converted {len(dicom_bytes)} files, analyzing...")
acquisitions = await analyze_dicom_files_for_ui(dicom_bytes, progress_callback)
json.dumps(acquisitions, default=str)
  `);

  sendSuccess(id, JSON.parse(result));
}

// --- Validation ---

async function handleValidateAcquisition(id, payload) {
  if (!pyodide) throw new Error('Pyodide not initialized');

  const { acquisition, schemaContent, acquisitionIndex } = payload;

  pyodide.globals.set('acquisition_data', acquisition);
  pyodide.globals.set('schema_content', schemaContent);
  pyodide.globals.set('schema_acquisition_index', acquisitionIndex ?? null);

  const result = await pyodide.runPython(`
import json
from dicompare.interface import validate_acquisition_direct

acq_data = acquisition_data if not hasattr(acquisition_data, 'to_py') else acquisition_data.to_py()
schema_str = schema_content if not hasattr(schema_content, 'to_py') else schema_content.to_py()
acq_index = schema_acquisition_index if not hasattr(schema_acquisition_index, 'to_py') else schema_acquisition_index.to_py()

results = validate_acquisition_direct(acq_data, schema_str, acq_index)
json.dumps(results, default=str)
  `);

  sendSuccess(id, JSON.parse(result));
}

// --- Diffusion gradient binding ---

async function handleAttachGradientFiles(id, payload) {
  if (!pyodide) throw new Error('Pyodide not initialized');

  const { acquisitions, files } = payload;
  console.log(`[dicompare Worker] Binding ${files.length} gradient file(s) to ${acquisitions.length} acquisition(s)`);

  pyodide.globals.set('grad_acquisitions_json', JSON.stringify(acquisitions));
  pyodide.globals.set('grad_files_json', JSON.stringify(files));

  await pyodide.runPython(`
import json
from dicompare.interface import attach_gradient_files_to_acquisitions

_aj = grad_acquisitions_json if isinstance(grad_acquisitions_json, str) else grad_acquisitions_json.to_py()
_fj = grad_files_json if isinstance(grad_files_json, str) else grad_files_json.to_py()
_grad_result_json = json.dumps(
    attach_gradient_files_to_acquisitions(json.loads(_aj), json.loads(_fj)),
    default=str,
)
  `);

  const result = pyodide.globals.get('_grad_result_json');
  sendSuccess(id, JSON.parse(result));
}

// --- Message Router ---

self.onmessage = async (event) => {
  const { id, type, payload } = event.data;

  try {
    switch (type) {
      case 'initialize':
        await initializePyodide(id);
        break;
      case 'analyzeFiles':
        await handleAnalyzeFiles(id, payload);
        break;
      case 'validateAcquisition':
        await handleValidateAcquisition(id, payload);
        break;
      case 'attachGradientFiles':
        await handleAttachGradientFiles(id, payload);
        break;
      default:
        sendError(id, new Error(`Unknown message type: ${type}`));
    }
  } catch (error) {
    sendError(id, error instanceof Error ? error : new Error(String(error)));
  }
};

console.log('[dicompare Worker] Script loaded, waiting for initialize message...');
