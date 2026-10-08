import * as z from 'zod/v4';

export function operationParameterSchema(field) {
  let schema;
  if (field.type === 'boolean') schema = z.boolean();
  else if (field.type === 'array') {
    schema = z.array(operationParameterSchema(field.items));
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
  return field.description === undefined ? schema : schema.describe(field.description);
}

export function operationParametersSchema(fields) {
  const shape = Object.fromEntries(Object.entries(fields).map(([key, field]) => {
    const value = operationParameterSchema(field);
    return [key, field.default === undefined ? value.optional() : value.prefault(structuredClone(field.default))];
  }));
  return z.strictObject(shape).prefault({});
}
