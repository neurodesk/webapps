/**
 * Helpers for parameterized validation functions.
 *
 * A library function may declare typed parameters (ValidationParameterDefinition[]);
 * a selected instance stores the user's values in configuredParams. The merged
 * {name: value} dict is what gets injected into the rule implementation as
 * `params` / `ctx.params` by dicompare.
 */

import { ValidationParameterDefinition } from '../types';

export interface ParameterizedFunctionLike {
  // Same naming as the schema format: parameterDefinitions = typed
  // declarations; configured values live in configuredParams (UI) or the
  // serialized rule's `parameters` dict (mapped to configuredParams on load).
  parameterDefinitions?: ValidationParameterDefinition[];
  configuredParams?: Record<string, any>;
}

/** Parameter declarations for a function, or [] when it has none. */
export function getParameterDefinitions(func: ParameterizedFunctionLike): ValidationParameterDefinition[] {
  return Array.isArray(func.parameterDefinitions) ? func.parameterDefinitions : [];
}

/** Declaration defaults overlaid with the user's configured values. */
export function getEffectiveParams(func: ParameterizedFunctionLike): Record<string, any> {
  const merged: Record<string, any> = {};
  for (const decl of getParameterDefinitions(func)) {
    merged[decl.name] = decl.default;
  }
  return { ...merged, ...(func.configuredParams || {}) };
}

/** Format a parameter value for compact display (chips, interpolated names). */
export function formatParamValue(value: any): string {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return `[${value.join(', ')}]`;
  return String(value);
}

/**
 * Replace {paramName} placeholders in a rule name with configured values,
 * e.g. "Echo Count (>={min_echoes})" -> "Echo Count (>=8)". Placeholders
 * without a value are left as-is.
 */
export function interpolateRuleName(name: string, params: Record<string, any>): string {
  if (!name) return name;
  return name.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, key) => {
    const value = params[key];
    return value === null || value === undefined || value === '' ? match : formatParamValue(value);
  });
}

/** Display name for a selected function with placeholders resolved. */
export function getDisplayName(func: ParameterizedFunctionLike & { name: string; customName?: string }): string {
  return interpolateRuleName(func.customName || func.name, getEffectiveParams(func));
}

/** Coerce raw input text to the declared parameter type. */
export function coerceParamValue(decl: ValidationParameterDefinition, raw: string | boolean): any {
  if (decl.type === 'boolean') return Boolean(raw);
  if (typeof raw !== 'string') return raw;
  if (raw === '') return null;
  if (decl.type === 'number') {
    const num = Number(raw);
    return Number.isNaN(num) ? raw : num;
  }
  return raw;
}
