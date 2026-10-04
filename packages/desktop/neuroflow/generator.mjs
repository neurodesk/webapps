import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parseContract } from '../src/contracts.js';
import { canonical, contractHash } from './runtime/contract.mjs';
import { qualifiers } from './qualifiers.mjs';

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
for (const name of ['common', 'events', 'tool', 'neuroflow-mcp']) {
  ajv.addSchema(JSON.parse(await readFile(new URL(`./vendor/${name}.schema.json`, import.meta.url))));
}
const schemaId = 'https://niivue.github.io/neuroflow-spec/schemas/0.1/tool.schema.json';
const validate = ajv.getSchema(schemaId);
const validateMcp = ajv.getSchema('https://niivue.github.io/neuroflow-spec/schemas/0.1/extensions/neuroflow-mcp.schema.json');
const validateQualifierType = ajv.getSchema('https://niivue.github.io/neuroflow-spec/schemas/0.1/common.schema.json#/$defs/typeQualifierRules');
const artifactTypes = new Set([
  'neuro:volume', 'neuro:mask', 'neuro:label-map', 'neuro:transform',
  'neuro:surface', 'neuro:report', 'neuro:ome-zarr',
]);
// Contract types whose representation matches a NeuroFlow 0.1 type. A mapped
// entry may add the format token (RFC 0010) that names the representation.
const aliases = {
  'neuro:table': { type: 'core:tabular' },
  'neuro:tractogram': { type: 'neuro:tract' },
  'neuro:gradients': { type: 'neuro:gradient-table' },
  'neuro:multiscale-volume': { type: 'neuro:ome-zarr' },
  'neuro:displacement-field': { type: 'neuro:transform', formats: ['displacement-field'] },
};

function mapType(type) {
  if (Array.isArray(type)) return { type: 'core:file' };
  if (artifactTypes.has(type) || type.startsWith('file:')) return { type };
  return aliases[type] ?? { type: `neurodesk:${type.slice(type.indexOf(':') + 1)}` };
}

function parameterType(field) {
  if (field.type !== 'array') return `core:${field.type}`;
  const item = field.items.type === 'array' ? 'core:json' : parameterType(field.items);
  return `core:array<${item}>`;
}

function dataDeclaration(field, description, kind, operation, context) {
  const mapped = mapType(field.type);
  const scalar = field.source === 'url' ? 'core:string'
    : field.source === 'directory' ? (mapped.type === 'neuro:ome-zarr' ? mapped.type : 'core:directory')
      : mapped.type;
  return {
    type: field.maximum === 1 ? scalar : `core:array<${scalar}>`,
    description,
    optional: field.minimum === 0,
    // A URL is a core:string, which carries no qualifier; its formats stay in the extension.
    ...(scalar !== 'core:string' && qualifiers(field, kind, operation, mapped, context)),
    extensions: { 'neurodesk/data': structuredClone(field) },
  };
}

const qualifierKeys = ['formats', 'space', 'resolution', 'density', 'labelSystem'];
const qualified = declarations => Object.values(declarations).some(declaration => qualifierKeys.some(key => key in declaration));

// Cross-declaration inheritance and version rules require the complete tool.
function qualifierErrors(tool) {
  const errors = [];
  if ((qualified(tool.inputs ?? {}) || qualified(tool.outputs ?? {})) && tool.neuroflow !== '0.1.1') {
    errors.push(`a document with type qualifiers declares 0.1.1, not ${tool.neuroflow}`);
  }
  for (const kind of ['inputs', 'outputs']) {
    for (const [name, declaration] of Object.entries(tool[kind] ?? {})) {
      for (const key of qualifierKeys) {
        const match = /^inputs\.(.+)$/.exec(typeof declaration[key] === 'string' ? declaration[key] : '');
        if (!match) continue;
        const path = `${kind}/${name}/${key}`;
        if (kind === 'inputs') {
          errors.push(`${path}: qualifier inheritance is only allowed on outputs`);
          continue;
        }
        if (!Object.hasOwn(tool.inputs ?? {}, match[1])) {
          errors.push(`${path} references undeclared input ${match[1]}`);
          continue;
        }
        const source = tool.inputs[match[1]];
        if (!validateQualifierType({ type: source.type, [key]: declaration[key] })) {
          errors.push(`${path}: ${key} does not apply to input ${match[1]} of type ${source.type}`);
        }
        if (source.type.startsWith('core:array<') && !declaration.type.startsWith('core:array<')) {
          errors.push(`${path}: this generator does not support a scalar output inheriting ${key} from collection input ${match[1]}`);
        }
      }
    }
  }
  return errors;
}

export function validateTool(tool) {
  if (!validate(tool)) throw new Error(`Invalid NeuroFlow tool: ${ajv.errorsText(validate.errors)}`);
  if (!validateMcp(tool.extensions?.['neuroflow/mcp'])) throw new Error(`Invalid NeuroFlow MCP binding: ${ajv.errorsText(validateMcp.errors)}`);
  const errors = qualifierErrors(tool);
  if (errors.length) throw new Error(`Invalid NeuroFlow tool: ${errors.join('; ')}`);
  return tool;
}

export function generateTools(value) {
  const contract = parseContract(value);
  if (contract.schemaVersion !== 2) throw new Error('NeuroFlow generation requires a schema-2 automation contract');
  if (!contract.appVersion) throw new Error('NeuroFlow generation requires appVersion');
  return Object.entries(contract.operations).sort(([a], [b]) => a.localeCompare(b)).map(([id, operation]) => {
    const fullName = `neurodesk_${contract.app}__${id}`;
    const mcpName = fullName.length <= 64 ? fullName : `${fullName.slice(0, 47)}_${contractHash(fullName).slice(0, 16)}`;
    const inputs = {};
    const outputs = {};
    const bindings = { inputs: {}, parameters: {}, artifacts: {} };
    for (const [role, field] of Object.entries(operation.inputs)) {
      const name = `input_${role}`;
      bindings.inputs[role] = name;
      inputs[name] = dataDeclaration(field, field.description, 'inputs', operation, { app: contract.app, operationId: id });
    }
    for (const [key, field] of Object.entries(operation.parameters)) {
      const name = `param_${key}`;
      bindings.parameters[key] = name;
      inputs[name] = {
        type: parameterType(field), description: field.description, optional: true,
        ...(field.default !== undefined && { default: structuredClone(field.default) }),
        ...(field.enum && { enum: [...field.enum] }),
        ...(['number', 'integer'].includes(field.type) && {
          ...(field.minimum !== undefined && { min: field.minimum }),
          ...(field.maximum !== undefined && { max: field.maximum }),
        }),
        extensions: { 'neurodesk/parameter': structuredClone(field) },
      };
    }
    inputs.engine = {
      type: 'core:string', description: 'Desktop execution engine. Availability is checked before execution.',
      enum: [...operation.engines], default: operation.engines[0], optional: true,
    };
    for (const [role, field] of Object.entries(operation.artifacts)) {
      const name = `output_${role}`;
      bindings.artifacts[role] = name;
      outputs[name] = dataDeclaration(field, `${operation.title}: ${role}`, 'artifacts', operation, { app: contract.app, operationId: id });
    }
    outputs.report = { type: 'neuro:report', description: 'Verified Neurodesk run report, including provenance, measurements and artifact hashes.' };
    const tool = {
      $schema: schemaId, neuroflow: qualified(inputs) || qualified(outputs) ? '0.1.1' : '0.1.0', kind: 'tool',
      id: `neurodesk.webapps/${contract.app}/${id}`, version: contract.appVersion,
      description: operation.description,
      inputs, outputs, outputDelivery: { default: 'core:result-file' },
      extensions: {
        'neuroflow/mcp': { name: mcpName, title: `${contract.title}: ${operation.title}` },
        'neuroflow/launch': {
          kind: 'script', interpreter: 'node', script: '../../scripts/neurodesk.mjs',
          completion: 'exit', interactive: false,
          requirements: ['Node.js >= 22', 'Neurodesk Webapps desktop suite with schema-2 MCP automation'],
        },
        'neurodesk/automation': {
          schemaVersion: 1, operation: id, contract, contractSha256: contractHash(contract), ...bindings,
        },
      },
    };
    return canonical(validateTool(tool));
  });
}
