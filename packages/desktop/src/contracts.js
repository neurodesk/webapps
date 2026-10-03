import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import * as z from 'zod/v4';
import { operationLimitsSchema, validateOperationLimits } from './resource-limits.js';
import { validateNiftiEncoding } from './input-inspection.js';

const selector = z.string().trim().min(1);
const name = z.string().regex(/^[a-z][a-z0-9-]*$/);
const fieldName = z.string().regex(/^[a-z][a-zA-Z0-9_-]*$/);
const lifecycle = {
  selector: '#statusText',
  snapshotSelector: '#neurodesk-run',
  stateAttribute: 'data-neurodesk-state',
  runIdAttribute: 'data-neurodesk-run-id',
  ready: 'ready',
  succeeded: 'succeeded',
  failed: 'failed',
  cancelled: 'cancelled',
};
const parameter = z.strictObject({
  type: z.enum(['string', 'number', 'boolean']),
  description: z.string(),
  selector,
  action: z.enum(['select', 'fill', 'check']),
  enum: z.array(z.string()).min(1).optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  multipleOf: z.number().positive().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

const legacyContractSchema = z.strictObject({
  schemaVersion: z.literal(1),
  app: name,
  appVersion: z.string().regex(/^\d+\.\d+\.\d{8}$/).optional(),
  title: z.string().min(1),
  description: z.string().min(1),
  inputs: z.record(name, z.strictObject({
    type: z.literal('neuro:volume'),
    formats: z.array(z.literal('nifti')).min(1),
    space: z.string().min(1),
    description: z.string().min(1),
    selector,
  })).refine(value => Object.keys(value).length > 0, 'Declare at least one input'),
  parameters: z.record(name, parameter),
  artifacts: z.record(name, z.strictObject({
    type: z.enum(['neuro:volume', 'neuro:mask', 'neuro:label-map']),
    mediaType: z.string().min(1),
    space: z.string().min(1),
    labelSystem: z.string().optional(),
    selector,
  })).refine(value => Object.keys(value).length > 0, 'Declare at least one artifact'),
  controls: z.strictObject({ run: selector, cancel: selector, report: selector }),
  lifecycle: z.strictObject(Object.fromEntries(Object.entries(lifecycle).map(([key, value]) => [key, z.literal(value)]))).default(lifecycle),
  engines: z.array(z.enum(['browser', 'native'])).min(1),
});

const semanticType = z.string().regex(/^(?:neuro|file):[a-z][a-z0-9-]*$/);
const operationParameter = z.lazy(() => z.strictObject({
  type: z.enum(['string', 'number', 'integer', 'boolean', 'array']),
  description: z.string(),
  enum: z.array(z.union([z.string(), z.number(), z.boolean()])).min(1).optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  multipleOf: z.number().positive().optional(),
  items: operationParameter.optional(),
  default: z.json().optional(),
}));
const operationSchema = z.strictObject({
  title: z.string().min(1),
  description: z.string().min(1),
  mode: z.enum(['batch', 'viewer']),
  inputs: z.record(fieldName, z.strictObject({
    source: z.enum(['files', 'url', 'directory']),
    type: semanticType,
    formats: z.array(z.string().regex(/^[a-z0-9-]+$/)).min(1).optional(),
    minimum: z.number().int().nonnegative().default(1),
    maximum: z.number().int().positive().optional(),
    description: z.string().min(1),
    space: z.string().optional(),
  })),
  parameters: z.record(fieldName, operationParameter),
  artifacts: z.record(fieldName, z.strictObject({
    type: z.union([semanticType, z.array(semanticType).min(1)]),
    mediaType: z.string().min(1),
    space: z.string().optional(),
    labelSystem: z.string().optional(),
    minimum: z.number().int().nonnegative().default(1),
    maximum: z.number().int().nonnegative().optional(),
  })),
  engines: z.array(z.enum(['browser', 'native'])).min(1),
  limits: operationLimitsSchema.optional(),
}).superRefine((operation, context) => {
  for (const role of Object.keys(operation.limits?.browser.inputs ?? {})) {
    const input = operation.inputs[role];
    if (!operation.engines.includes('browser') || input?.source !== 'files' || !input.formats?.includes('nifti')) {
      context.addIssue({ code: 'custom', path: ['limits', 'browser', 'inputs', role], message: 'Resource limits require a declared browser NIfTI file input' });
    }
  }
});
const operationContractSchema = z.strictObject({
  schemaVersion: z.literal(2),
  app: name,
  appVersion: z.string().regex(/^\d+\.\d+\.\d{8}$/).optional(),
  title: z.string().min(1),
  description: z.string().min(1),
  defaultOperation: name,
  operations: z.record(name, operationSchema),
});

export const contractSchema = z.discriminatedUnion('schemaVersion', [legacyContractSchema, operationContractSchema]);
export const contractJsonSchema = () => z.toJSONSchema(contractSchema);

export function parseContract(value) {
  const contract = contractSchema.parse(value);
  if (contract.schemaVersion === 2) {
    if (!contract.operations[contract.defaultOperation]) throw new Error('Default operation is not declared');
    for (const operation of Object.values(contract.operations)) {
      for (const [role, field] of Object.entries(operation.inputs)) {
        if (field.source === 'files' && !field.formats) throw new Error(`${role}: file inputs require formats`);
        if (field.maximum !== undefined && field.minimum > field.maximum) throw new Error(`${role}: invalid input cardinality`);
        if (field.source !== 'files' && (field.minimum > 1 || field.maximum !== 1)) throw new Error(`${role}: URL and directory inputs require a maximum of one`);
      }
      for (const [role, field] of Object.entries(operation.artifacts)) {
        if (field.maximum !== undefined && field.minimum > field.maximum) throw new Error(`${role}: invalid artifact cardinality`);
      }
      for (const [key, field] of Object.entries(operation.parameters)) validateParameter(key, field);
    }
    return contract;
  }
  for (const [key, field] of Object.entries(contract.parameters)) {
    if ((field.action === 'check') !== (field.type === 'boolean')) throw new Error(`${key}: check requires a boolean parameter`);
    if (field.action === 'select' && (field.type !== 'string' || !field.enum)) throw new Error(`${key}: select requires a string enum`);
    if (field.enum && field.type !== 'string') throw new Error(`${key}: enum requires a string parameter`);
    if ((field.minimum !== undefined || field.maximum !== undefined || field.multipleOf !== undefined) && field.type !== 'number') throw new Error(`${key}: bounds require a number`);
    if (field.minimum > field.maximum) throw new Error(`${key}: minimum exceeds maximum`);
    if (field.default !== undefined) parameterSchema(field).parse(field.default);
  }
  return contract;
}

function validateParameter(key, field) {
  if (field.minimum > field.maximum) throw new Error(`${key}: minimum exceeds maximum`);
  if (field.enum && (field.type === 'array' || field.enum.some(value => typeof value !== (field.type === 'integer' ? 'number' : field.type)))) {
    throw new Error(`${key}: enum values must match the parameter type`);
  }
  if (field.type === 'array' && !field.items) throw new Error(`${key}: array parameters require items`);
  if (field.type !== 'array' && field.items) throw new Error(`${key}: items requires an array`);
  if (field.items) validateParameter(`${key} item`, field.items);
  if (field.default !== undefined) parameterSchema(field).parse(field.default);
}

export function parameterSchema(field) {
  let schema;
  if (field.type === 'boolean') schema = z.boolean();
  else if (field.type === 'array') {
    schema = z.array(parameterSchema(field.items));
    if (field.minimum !== undefined) schema = schema.min(field.minimum);
    if (field.maximum !== undefined) schema = schema.max(field.maximum);
  } else if (field.type === 'number' || field.type === 'integer') {
    schema = z.number().finite();
    if (field.type === 'integer') schema = schema.int();
    if (field.minimum !== undefined) schema = schema.min(field.minimum);
    if (field.maximum !== undefined) schema = schema.max(field.maximum);
    if (field.multipleOf !== undefined) schema = schema.multipleOf(field.multipleOf);
  } else schema = z.string();
  if (field.enum) schema = field.type === 'string' ? z.enum(field.enum) : schema.and(z.literal(field.enum));
  return schema.describe(field.description);
}

export function operationFor(contract, operation) {
  if (contract.schemaVersion !== 2) return contract;
  const id = operation ?? contract.defaultOperation;
  const selected = contract.operations[id];
  if (!selected) throw new Error(`Unknown operation: ${id}`);
  return { ...selected, app: contract.app, appVersion: contract.appVersion, schemaVersion: 2, operation: id };
}

export function requestSchema(contract, operation) {
  if (contract.schemaVersion === 2) {
    const selected = operationFor(contract, operation);
    return z.strictObject({
      operation: z.literal(selected.operation).default(selected.operation),
      inputs: z.strictObject(Object.fromEntries(Object.entries(selected.inputs).map(([role, field]) => {
        let schema = field.source === 'url'
          ? z.strictObject({ url: z.httpUrl() })
          : field.source === 'directory'
            ? z.strictObject({ directory: z.string().min(1) })
            : z.array(z.string().min(1))
              .min(field.formats.includes('dicom') ? Math.min(1, field.minimum) : field.minimum)
              .max(field.formats.includes('dicom') ? 100000 : Math.min(100000, field.maximum ?? 100000));
        schema = schema.describe(field.description);
        return [role, field.minimum > 0 ? schema : schema.optional()];
      }))).prefault({}),
      parameters: z.strictObject(Object.fromEntries(Object.entries(selected.parameters).map(([key, field]) => [
        key, field.default === undefined ? parameterSchema(field).optional() : parameterSchema(field).default(field.default),
      ]))).prefault({}),
      selections: z.strictObject(Object.fromEntries(Object.entries(selected.inputs)
        .filter(([, field]) => field.formats?.includes('dicom'))
        .map(([role]) => [role, z.string().regex(/^[a-f0-9]{64}$/).optional()]))).prefault({}),
      engine: z.enum(selected.engines).default(selected.engines[0]),
      timeoutMs: z.number().int().min(1).max(86400000).default(1800000),
      retainViewer: z.boolean().default(selected.mode === 'viewer'),
    });
  }
  return z.strictObject({
    inputs: z.strictObject(Object.fromEntries(Object.entries(contract.inputs).map(([role, field]) => [
      role, z.array(z.string().min(1)).length(1).describe(`${field.description} Absolute path to one NIfTI file.`),
    ]))),
    parameters: z.strictObject(Object.fromEntries(Object.entries(contract.parameters).map(([key, field]) => [
      key, field.default === undefined ? parameterSchema(field).optional() : parameterSchema(field).default(field.default),
    ]))).prefault({}),
    engine: z.enum(contract.engines).default('browser'),
    timeoutMs: z.number().int().min(1).max(86400000).default(1800000),
  });
}

export async function validateRequest(contract, value) {
  const request = requestSchema(contract, value?.operation).parse(value);
  if (contract.schemaVersion === 2) {
    const selected = operationFor(contract, request.operation);
    for (const [role, source] of Object.entries(request.inputs)) {
      const field = selected.inputs[role];
      if (field.source === 'url') {
        const url = new URL(source.url);
        if (url.username || url.password) throw new Error('Input URLs must not contain credentials');
        source.url = url.href;
      } else if (field.source === 'directory') {
        if (!isAbsolute(source.directory)) throw new Error(`Input path must be absolute: ${source.directory}`);
        if (!(await stat(source.directory)).isDirectory()) throw new Error(`Input is not a directory: ${source.directory}`);
        source.directory = await realpath(source.directory);
      } else {
        const files = [];
        for (const path of source) {
          if (!isAbsolute(path)) throw new Error(`Input path must be absolute: ${path}`);
          const info = await stat(path);
          if (info.isDirectory()) {
            if (!field.formats.includes('dicom')) throw new Error(`${role}: directory input requires DICOM support`);
            await collectFiles(path, files);
          } else if (info.isFile()) files.push(path);
          else throw new Error(`Input is not a regular file: ${path}`);
        }
        if ((!files.length && field.minimum > 0) || files.length > 100000) throw new Error(`${role}: invalid input file count`);
        const unique = new Set();
        for (const path of files) {
          const canonical = await realpath(path);
          if (unique.has(canonical)) throw new Error(`${role}: duplicate input file ${path}`);
          unique.add(canonical);
          if (!acceptsFile(field, path)) throw new Error(`${role}: unsupported input format: ${path}`);
          if (field.formats.includes('nifti') && /\.nii(?:\.gz)?$/i.test(path)) await validateNiftiEncoding(path);
        }
        if (!field.formats.includes('dicom') && (files.length < field.minimum || files.length > (field.maximum ?? Infinity))) {
          throw new Error(`${role}: input cardinality mismatch`);
        }
        request.inputs[role] = files;
      }
    }
    await validateOperationLimits(selected, request);
    return request;
  }
  for (const paths of Object.values(request.inputs)) {
    for (const path of paths) {
      if (!isAbsolute(path)) throw new Error(`Input path must be absolute: ${path}`);
      if (!/\.nii(?:\.gz)?$/i.test(path)) throw new Error(`Input must be NIfTI: ${path}`);
      if (!(await stat(path)).isFile()) throw new Error(`Input is not a file: ${path}`);
      await validateNiftiEncoding(path);
    }
  }
  return request;
}

const fileFormats = {
  nifti: /\.nii(?:\.gz)?$/i,
  surface: /\.(?:gii|mz3|obj|ply|stl|surf|pial|white|inflated|sphere)(?:\.gz)?$/i,
  table: /\.(?:csv|tsv)$/i,
  dicom: /(?:\.(?:dcm|dicom|ima))?$|\.[0-9]+$/i,
};
function acceptsFile(field, path) {
  if (field.formats.includes('dicom')) return true;
  return field.formats.some(format => (fileFormats[format] ?? new RegExp(`\\.${format}(?:\\.gz)?$`, 'i')).test(path));
}

async function collectFiles(directory, files) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`DICOM directory contains a symbolic link: ${path}`);
    if (entry.isDirectory()) await collectFiles(path, files);
    else if (entry.isFile()) files.push(path);
    if (files.length > 100000) throw new Error('DICOM input exceeds 100000 files');
  }
}

export function generateJob(contract, request) {
  if (request.engine !== 'browser') throw new Error('Desktop jobs require the browser engine');
  if (contract.schemaVersion === 2) return {
    schemaVersion: 2, app: contract.app, automation: { contract }, request: { ...request, retainViewer: false },
  };
  return {
    schemaVersion: 1,
    app: contract.app,
    timeoutMs: request.timeoutMs,
    failSelector: null,
    expectedDownloads: Object.keys(contract.artifacts).length + 1,
    automation: { contract },
    steps: [
      ...Object.entries(contract.inputs).flatMap(([role, field]) => [
        { action: 'upload', selector: field.selector, paths: request.inputs[role], input: role },
        { action: 'wait', selector: contract.lifecycle.selector, condition: 'state', value: contract.lifecycle.ready },
      ]),
      ...Object.entries(request.parameters).map(([key, value]) => ({
        action: contract.parameters[key].action,
        selector: contract.parameters[key].selector,
        value,
      })),
      { action: 'click', selector: contract.controls.run },
      { action: 'wait', selector: contract.lifecycle.selector, condition: 'state', value: contract.lifecycle.succeeded },
      ...Object.entries(contract.artifacts).map(([role, field]) => ({ action: 'click', selector: field.selector, artifact: role })),
      { action: 'click', selector: contract.controls.report, artifact: 'report' },
    ],
  };
}

export async function readContract(path) {
  return parseContract(JSON.parse(await readFile(path, 'utf8')));
}
