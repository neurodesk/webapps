/**
 * Checks a tool call's input against the JSON Schema the tool publishes. The browser passes an agent's
 * arguments through unchecked, so every tool runs this first. It knows the keywords the tool table uses
 * (SCHEMA_KEYWORDS); a schema with any other keyword is a defect the tests catch.
 */
export const SCHEMA_KEYWORDS = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'items', 'enum',
  'minimum', 'maximum', 'multipleOf', 'minItems', 'maxItems', 'minLength', 'pattern', 'format',
  'title', 'description', 'default',
]);

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const types = {
  object: isObject,
  array: Array.isArray,
  string: value => typeof value === 'string',
  boolean: value => typeof value === 'boolean',
  number: value => typeof value === 'number' && Number.isFinite(value),
  integer: value => Number.isSafeInteger(value),
};
// The page checks run parameters with zod (automation/parameters.js), so a step is checked as zod's
// floatSafeRemainder checks it: the quotient within four scaled epsilons of an integer.
function multiple(value, step) {
  const ratio = value / step;
  return Math.abs(ratio - Math.round(ratio)) < 4 * Number.EPSILON * Math.max(Math.abs(ratio), 1);
}

function uri(value) {
  try {
    return Boolean(new URL(value).protocol);
  } catch {
    return false;
  }
}

/** The ways `value` breaks `schema`, one sentence each with the path; empty when it conforms. */
export function schemaIssues(schema, value, path = 'input') {
  if (schema.type && !types[schema.type](value)) return [`${path} must be ${schema.type === 'integer' ? 'a safe integer' : `${schema.type === 'array' || schema.type === 'object' ? 'an' : 'a'} ${schema.type}`}`];
  if (schema.enum && !schema.enum.some(option => option === value)) return [`${path} must be one of ${schema.enum.map(option => JSON.stringify(option)).join(', ')}`];
  const issues = [];
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) issues.push(`${path} must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) issues.push(`${path} must be at most ${schema.maximum}`);
    if (schema.multipleOf !== undefined && !multiple(value, schema.multipleOf)) issues.push(`${path} must be a multiple of ${schema.multipleOf}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) issues.push(`${path} needs at least ${schema.minLength} character(s)`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) issues.push(`${path} does not match ${schema.pattern}`);
    if (schema.format === 'uri' && !uri(value)) issues.push(`${path} must be an absolute URL`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) issues.push(`${path} needs at least ${schema.minItems} item(s)`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) issues.push(`${path} takes at most ${schema.maxItems} item(s)`);
    if (schema.items) value.forEach((item, index) => issues.push(...schemaIssues(schema.items, item, `${path}[${index}]`)));
  }
  if (isObject(value)) {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) issues.push(`${path}.${key} is required`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties && Object.hasOwn(schema.properties, key)) issues.push(...schemaIssues(schema.properties[key], item, `${path}.${key}`));
      else if (schema.additionalProperties === false) issues.push(`${path}.${key} is not a known field`);
    }
  }
  return issues;
}

/** Every keyword `schema` uses that schemaIssues does not check, by path. */
export function unsupportedKeywords(schema, path = 'schema') {
  return Object.entries(schema).flatMap(([keyword, value]) => {
    if (!SCHEMA_KEYWORDS.has(keyword)) return [`${path}.${keyword}`];
    if (keyword === 'properties') return Object.entries(value).flatMap(([key, property]) => unsupportedKeywords(property, `${path}.properties.${key}`));
    if (keyword === 'items') return unsupportedKeywords(value, `${path}.items`);
    return [];
  });
}
