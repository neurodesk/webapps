import { registerAppAutomation, type OperationContext, type Artifact } from '@neurodesk/webapp-components/automation';
import { DicompareWorkerAPI } from '../services/DicompareWorkerAPI';
import type { FileObject } from '../utils/fileUploadUtils';

function filesFor(context: OperationContext, role: string): File[] {
  const files = context.inputs[role];
  if (!Array.isArray(files)) throw new Error(`${role} must contain uploaded files`);
  return files;
}

async function analyze(context: OperationContext, compare: boolean) {
  const { signal, progress } = context;
  const worker = new DicompareWorkerAPI();
  const cancel = () => worker.terminate(new DOMException('Cancelled', 'AbortError'));
  signal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted();
    const originals = filesFor(context, 'dicom');
    const files: FileObject[] = [];
    for (const [index, file] of originals.entries()) {
      files.push({ name: `${index}-${file.name}`, content: new Uint8Array(await file.arrayBuffer()) });
      signal.throwIfAborted();
    }
    const acquisitions = await worker.analyzeFilesForUI(files, event => progress({ message: event.currentOperation, value: event.percentage / 100 }));
    signal.throwIfAborted();
    if (!acquisitions.length) throw new Error('No DICOM acquisitions were found in the supplied files.');
    let report: object = { acquisitions };
    if (compare) {
      const schemaFile = filesFor(context, 'schema')[0];
      const schema = await schemaFile.text();
      const parsed: unknown = JSON.parse(schema);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The protocol schema must be a JSON object.');
      const schemaIndex = context.parameters.schemaIndex;
      if (typeof schemaIndex !== 'number' || !Number.isInteger(schemaIndex) || schemaIndex < 0) throw new Error('The schema acquisition index must be a nonnegative integer.');
      const comparison = [];
      for (const acquisition of acquisitions) {
        signal.throwIfAborted();
        progress({ message: `Validating ${acquisition.protocolName}` });
        const results: unknown[] = await worker.validateAcquisitionAgainstSchema(acquisition, 'uploaded', async () => schema, String(schemaIndex));
        comparison.push({ acquisition: acquisition.id, protocolName: acquisition.protocolName, results });
      }
      report = { schema: schemaFile.name, schemaIndex, acquisitions, comparison };
    }
    signal.throwIfAborted();
    const role = compare ? 'comparison' : 'acquisitions';
    const artifact: Artifact = { role, file: new File([JSON.stringify(report, null, 2)], `${role}.json`, { type: 'application/json' }) };
    return { artifacts: [artifact], provenance: { engine: 'dicompare-python-worker' }, summary: { acquisitions: acquisitions.length, inputFiles: originals.length } };
  } finally {
    signal.removeEventListener('abort', cancel);
    worker.terminate();
  }
}

registerAppAutomation({
  app: 'dicompare',
  operations: { analyze: context => analyze(context, false), compare: context => analyze(context, true) },
});
