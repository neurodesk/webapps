import { createHash } from 'node:crypto';

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

export const contractHash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function makeRequest(tool, values, timeoutMs) {
  const binding = tool.extensions['neurodesk/automation'];
  const operation = binding.contract.operations[binding.operation];
  const allowed = new Set(Object.keys(tool.inputs));
  for (const key of Object.keys(values)) {
    if (!allowed.has(key)) throw new Error(`Unknown tool input: ${key}`);
  }
  const inputs = {};
  const parameters = {};
  for (const [role, name] of Object.entries(binding.inputs)) {
    const value = values[name];
    if (value === undefined) continue;
    const source = operation.inputs[role].source;
    // A single-file role is a scalar NeuroFlow input; the desktop always takes a list.
    inputs[role] = source === 'url' ? { url: value } : source === 'directory' ? { directory: value }
      : Array.isArray(value) ? value : [value];
  }
  for (const [key, name] of Object.entries(binding.parameters)) {
    if (values[name] !== undefined) parameters[key] = values[name];
  }
  return {
    app: binding.contract.app,
    operation: binding.operation,
    inputs,
    parameters,
    engine: values.engine ?? operation.engines[0],
    timeoutMs,
    retainViewer: false,
  };
}
