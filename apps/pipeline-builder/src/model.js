// DOM-independent workflow editing. The state is the NeuroFlow workflow document
// itself; every edit returns a new document. Type checking is not repeated here:
// callers pass `validate(doc)` (the NeuroFlow core) wherever compatibility matters.
export const NEUROFLOW_VERSION = "0.1.1";
const LOCAL_ID = /^[a-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)*$/;

export function emptyWorkflow() {
  return {
    neuroflow: NEUROFLOW_VERSION,
    kind: "workflow",
    id: "neurodesk.pipelines/untitled",
    version: "0.1.0",
    description: "",
    inputs: {},
    steps: {},
    outputs: {},
  };
}

export function parseWorkflow(text) {
  let doc;
  try { doc = JSON.parse(text); } catch { throw new Error("The file is not JSON."); }
  if (doc?.kind !== "workflow" || !isObject(doc.steps)) {
    throw new Error("The file is not a NeuroFlow workflow.");
  }
  // The editor walks these maps; anything else would break every render.
  const misshapen = shapeError(doc);
  if (misshapen) throw new Error(`The file is not a NeuroFlow workflow: ${misshapen} must be an object.`);
  return { ...emptyWorkflow(), ...doc, neuroflow: workflowVersion(doc.neuroflow) };
}

const isObject = value => typeof value === "object" && value !== null && !Array.isArray(value);

function shapeError(doc) {
  for (const key of ["inputs", "outputs"]) {
    if (doc[key] === undefined) continue;
    if (!isObject(doc[key])) return key;
    const bad = Object.keys(doc[key]).find(name => !isObject(doc[key][name]));
    if (bad !== undefined) return `${key}.${bad}`;
  }
  for (const [id, step] of Object.entries(doc.steps)) {
    if (!isObject(step)) return `steps.${id}`;
    if (step.inputs === undefined) continue;
    if (!isObject(step.inputs)) return `steps.${id}.inputs`;
    const bad = Object.keys(step.inputs).find(name => !isObject(step.inputs[name]));
    if (bad !== undefined) return `steps.${id}.inputs.${bad}`;
  }
  return null;
}

export function serializeWorkflow(doc) {
  return `${JSON.stringify({ ...doc, neuroflow: workflowVersion(doc.neuroflow) }, null, 2)}\n`;
}

function workflowVersion(version) {
  return version === undefined || version === "0.1.0" ? NEUROFLOW_VERSION : version;
}

export function elementType(type) {
  return /^core:array<(.+)>$/.exec(type)?.[1] ?? type;
}

const automation = tool => tool.extensions?.["neurodesk/automation"];

/** "Brain extraction · Extract brain" for a generated Neurodesk tool, else its id. */
export function toolLabel(tool) {
  const binding = automation(tool);
  const operation = binding?.contract.operations[binding.operation];
  return binding ? `${binding.contract.title} · ${operation?.title ?? binding.operation}` : tool.id;
}

/** Tools grouped by app title, for an operation picker. */
export function toolCatalog(tools) {
  const groups = new Map();
  for (const tool of tools) {
    const title = automation(tool)?.contract.title ?? "Other";
    if (!groups.has(title)) groups.set(title, []);
    groups.get(title).push(tool);
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b))
    .map(([title, list]) => ({ title, tools: list.sort((a, b) => a.id.localeCompare(b.id)) }));
}

/** A tool's inputs split into data inputs, parameters and the engine choice. */
export function toolFields(tool) {
  const entries = Object.entries(tool.inputs ?? {});
  return {
    data: entries.filter(([name]) => name.startsWith("input_")),
    parameters: entries.filter(([name]) => name.startsWith("param_")),
    engine: tool.inputs?.engine,
  };
}

function uniqueId(base, taken) {
  let id = base.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/^[^a-z]+/, "") || "step";
  if (!LOCAL_ID.test(id)) id = "step";
  if (!taken.has(id)) return id;
  let n = 2;
  while (taken.has(`${id}-${n}`)) n++;
  return `${id}-${n}`;
}

export function addStep(doc, tool) {
  const stepId = uniqueId(automation(tool)?.contract.app ?? tool.id.split("/").pop(), new Set(Object.keys(doc.steps)));
  return { doc: { ...doc, steps: { ...doc.steps, [stepId]: { tool: tool.id, inputs: {} } } }, stepId };
}

function withStep(doc, stepId, change) {
  const step = doc.steps[stepId];
  if (!step) throw new Error(`No step ${stepId}.`);
  return { ...doc, steps: { ...doc.steps, [stepId]: change(step) } };
}

/**
 * Drop the workflow inputs among `refs` that no step reads any more; an input nobody
 * read before the edit stays. Step input bindings and conditions can read workflow
 * inputs; NeuroFlow outputs reference step outputs only.
 */
function dropUnread(doc, refs) {
  const read = new Set(Object.values(doc.steps).flatMap(step => [
    ...Object.values(step.inputs ?? {}).map(binding => binding.ref),
    step.condition,
  ]));
  const inputs = Object.fromEntries(Object.entries(doc.inputs ?? {})
    .filter(([name]) => !refs.has(`inputs.${name}`) || read.has(`inputs.${name}`)));
  return { ...doc, inputs };
}

function withBinding(doc, stepId, name, binding) {
  const replaced = doc.steps[stepId]?.inputs?.[name]?.ref;
  return dropUnread(withStep(doc, stepId, step => {
    const inputs = { ...step.inputs };
    if (binding) inputs[name] = binding; else delete inputs[name];
    return { ...step, inputs };
  }), new Set([replaced]));
}

/** Workflow inputs, then outputs of the steps before `stepId`, as candidate refs. */
export function candidateSources(doc, stepId, tools) {
  const byId = new Map(tools.map(tool => [tool.id, tool]));
  const sources = Object.entries(doc.inputs ?? {}).map(([name, decl]) => ({ ref: `inputs.${name}`, label: `Workflow input ${name}`, type: decl.type, formats: decl.formats, order: -1 }));
  let order = 0;
  for (const [id, step] of Object.entries(doc.steps)) {
    if (id === stepId) break;
    for (const [name, decl] of Object.entries(byId.get(step.tool)?.outputs ?? {})) {
      sources.push({ ref: `steps.${id}.outputs.${name}`, label: `${id} → ${name}`, type: decl.type, formats: decl.formats, order });
    }
    order++;
  }
  return sources;
}

function gradientFormats(decl) {
  if (!["neuro:gradients", "neuro:gradient-table"].includes(elementType(decl?.type))) return [];
  return (decl.extensions?.["neurodesk/data"]?.formats ?? decl.formats ?? [])
    .map(format => format.replace(/^(bval|bvec)s$/, "$1"));
}

/**
 * The candidates the validator accepts for one input: a trial binding counts when it
 * leaves no error on that input's path.
 */
export function compatibleSources(doc, stepId, name, tools, validate) {
  const path = `steps.${stepId}.inputs.${name}`;
  const decl = tools.find(tool => tool.id === doc.steps[stepId].tool)?.inputs?.[name];
  const formats = gradientFormats(decl);
  return candidateSources(doc, stepId, tools).flatMap(source => {
    const { issues = [] } = validate(withBinding(doc, stepId, name, { ref: source.ref }));
    if (issues.some(issue => issue.severity === "error" && issue.path === path)) return [];
    const requiresRuntimeCheck = issues.some(issue => issue.path === path && issue.outcome === "requires-runtime-check")
      || Boolean(formats.length && !source.formats?.length);
    return [{ ...source, requiresRuntimeCheck, label: source.label + (requiresRuntimeCheck ? " (needs a run-time check)" : "") }];
  }).sort((a, b) => Number(a.requiresRuntimeCheck) - Number(b.requiresRuntimeCheck));
}

/**
 * Prefer matching roles across all steps, then proximity and an exact element
 * type. Primary DWI ports use image, images or dwi. SynthSeg accepts an extracted
 * brain as its primary structural image, as in the shipped T1 workflow.
 */
export function preferredSource(sources, name, decl, tool) {
  const origin = source => /^steps\.([^.]+)/.exec(source.ref)?.[1] ?? "";
  const suffix = name.replace(/^input_/, "");
  const imageRoles = ["image", "images", "dwi"];
  const structural = automation(tool ?? {})?.contract.app === "synthseg";
  const role = source => source.ref.split(".").pop().replace(/^output_/, "");
  const matches = source => role(source) === suffix
    || imageRoles.includes(suffix) && (imageRoles.includes(role(source)) || structural && role(source) === "brain");
  const origins = [...new Set(sources.map(origin))];
  const eligible = sources.filter(source => {
    if (decl.optional) return Boolean(origin(source)) && matches(source);
    if (!imageRoles.includes(suffix)) return true;
    if (["neuro:mask", "neuro:label-map"].includes(elementType(source.type))) return false;
    if (origin(source)) return imageRoles.includes(role(source)) || structural && role(source) === "brain";
    return !/(?:^|[-_])(?:b0|mask|bias|field|fieldmap|sidecar|log|reverse|brain)(?:$|[-_])/.test(role(source));
  });
  const rank = source => [Number(matches(source)), source.order ?? origins.indexOf(origin(source)), Number(source.type === elementType(decl.type))];
  return eligible.reduce((best, source) => {
    if (!best) return source;
    const a = rank(source);
    const b = rank(best);
    const difference = a.findIndex((value, index) => value !== b[index]);
    return difference >= 0 && a[difference] > b[difference] ? source : best;
  }, undefined);
}

export function bindInput(doc, stepId, name, ref) {
  return withBinding(doc, stepId, name, ref ? { ref } : null);
}

/** Add a workflow input shaped like the tool's input and bind the step to it. */
export function bindNewWorkflowInput(doc, stepId, name, tool) {
  const decl = tool.inputs[name];
  const inputName = uniqueId(name.replace(/^input_/, ""), new Set(Object.keys(doc.inputs ?? {})));
  const input = { type: decl.type };
  if (decl.formats) input.formats = [...decl.formats];
  if (decl.description) input.description = decl.description;
  return bindInput({ ...doc, inputs: { ...doc.inputs, [inputName]: input } }, stepId, name, `inputs.${inputName}`);
}

/** Bind required inputs and optional inputs with an earlier matching output role. */
export function autoBind(doc, stepId, tools, validate) {
  const tool = tools.find(entry => entry.id === doc.steps[stepId].tool);
  for (const [name, decl] of toolFields(tool).data) {
    const source = preferredSource(compatibleSources(doc, stepId, name, tools, validate), name, decl, tool);
    if (source) doc = bindInput(doc, stepId, name, source.ref);
    else if (!decl.optional) doc = bindNewWorkflowInput(doc, stepId, name, tool);
  }
  return doc;
}

/** A parameter is written only when it differs from the tool default. */
export function setParameter(doc, stepId, name, value, tool) {
  const decl = tool.inputs[name];
  const unset = value === undefined || value === "" || (typeof value === "number" && Number.isNaN(value));
  const isDefault = JSON.stringify(value) === JSON.stringify(decl?.default);
  return withBinding(doc, stepId, name, unset || isDefault ? null : { constant: value });
}

const isArray = decl => elementType(decl.type) !== decl.type;

/** Value constraints: an array's per-item schema, else the scalar declaration. */
function itemLimits(decl) {
  if (!isArray(decl)) return { enum: decl.enum, minimum: decl.min, maximum: decl.max };
  const { enum: allowed, minimum, maximum } = decl.extensions?.["neurodesk/parameter"]?.items ?? {};
  return { enum: allowed, minimum, maximum };
}

function itemError(value, type, limits) {
  const shown = JSON.stringify(value);
  if (type === "core:number" && !Number.isFinite(value)) return `Expected a number, got ${shown}.`;
  if (type === "core:integer" && !Number.isInteger(value)) return `Expected an integer, got ${shown}.`;
  if (type === "core:boolean" && typeof value !== "boolean") return `Expected true or false, got ${shown}.`;
  if (!["core:number", "core:integer", "core:boolean", "core:json"].includes(type) && typeof value !== "string") {
    return `Expected text, got ${shown}.`;
  }
  if (limits.enum && !limits.enum.includes(value)) return `${shown} is not one of ${limits.enum.join(", ")}.`;
  if (limits.minimum !== undefined && value < limits.minimum) return `${shown} is below the minimum ${limits.minimum}.`;
  if (limits.maximum !== undefined && value > limits.maximum) return `${shown} is above the maximum ${limits.maximum}.`;
}

/** Why a parameter constant does not match its declaration, if it does not. */
export function parameterError(value, decl) {
  if (!isArray(decl)) return itemError(value, decl.type, itemLimits(decl));
  if (!Array.isArray(value)) return `Expected an array, got ${JSON.stringify(value)}.`;
  const { minItems, maxItems } = decl.extensions?.["neurodesk/parameter"] ?? {};
  if (minItems !== undefined && value.length < minItems) return `Expected at least ${minItems} values, got ${value.length}.`;
  if (maxItems !== undefined && value.length > maxItems) return `Expected at most ${maxItems} values, got ${value.length}.`;
  for (const item of value) {
    const error = itemError(item, elementType(decl.type), itemLimits(decl));
    if (error) return error;
  }
}

function fromText(text, type) {
  if (type === "core:boolean") return text === "true" ? true : text === "false" ? false : text;
  if (["core:number", "core:integer"].includes(type)) return text !== "" && Number.isFinite(Number(text)) ? Number(text) : text;
  return text;
}

/**
 * A parameter's value from control text. Arrays read JSON (`[10, 20]`) or
 * comma-separated values. Empty text, or an empty array, clears the parameter.
 */
export function parseParameter(text, decl) {
  const trimmed = text.trim();
  if (!trimmed) return { value: undefined };
  let value;
  if (!isArray(decl)) value = fromText(trimmed, decl.type);
  else if (trimmed.startsWith("[")) {
    try { value = JSON.parse(trimmed); } catch { value = undefined; }
    if (!Array.isArray(value)) return { error: "Enter a JSON array or comma-separated values." };
  } else {
    value = trimmed.split(",").map(item => item.trim());
    if (value.includes("")) return { error: "A value is missing between commas." };
    value = value.map(item => fromText(item, elementType(decl.type)));
  }
  if (Array.isArray(value) && !value.length) return { value: undefined };
  const error = parameterError(value, decl);
  return error ? { error } : { value };
}

/** Control text for a parameter value; arrays use the JSON form `parseParameter` reads. */
export function parameterText(value) {
  if (value === undefined || value === null) return "";
  return Array.isArray(value) ? `[${value.map(item => JSON.stringify(item)).join(", ")}]` : String(value);
}

export function outputKey(doc, stepId, name) {
  return Object.entries(doc.outputs ?? {}).find(([, output]) => output.ref === `steps.${stepId}.outputs.${name}`)?.[0];
}

export function setWorkflowOutput(doc, stepId, name, on, tool) {
  const outputs = { ...doc.outputs };
  const existing = outputKey(doc, stepId, name);
  if (!on) {
    if (existing) delete outputs[existing];
  } else if (!existing) {
    const key = uniqueId(name.replace(/^output_/, ""), new Set(Object.keys(outputs)));
    outputs[key] = { type: tool.outputs[name].type, ref: `steps.${stepId}.outputs.${name}` };
  }
  return { ...doc, outputs };
}

/** Remove a step, the bindings and outputs that read it, and inputs only it used. */
export function removeStep(doc, stepId) {
  const prefix = `steps.${stepId}.outputs.`;
  const { [stepId]: removed, ...rest } = doc.steps;
  if (!removed) return doc;
  const steps = Object.fromEntries(Object.entries(rest).map(([id, step]) => [id, {
    ...step,
    inputs: Object.fromEntries(Object.entries(step.inputs ?? {}).filter(([, binding]) => !binding.ref?.startsWith(prefix))),
  }]));
  const outputs = Object.fromEntries(Object.entries(doc.outputs ?? {}).filter(([, output]) => !output.ref?.startsWith(prefix)));
  return dropUnread({ ...doc, steps, outputs }, new Set(Object.values(removed.inputs ?? {}).map(binding => binding.ref)));
}

/** Reorder a step without discarding its bindings or the workflow's inputs and outputs. */
export function moveStep(doc, stepId, direction) {
  const entries = Object.entries(doc.steps);
  const index = entries.findIndex(([id]) => id === stepId);
  const next = index + direction;
  if (index < 0 || next < 0 || next >= entries.length) return doc;
  [entries[index], entries[next]] = [entries[next], entries[index]];
  return { ...doc, steps: Object.fromEntries(entries) };
}

/** Checks the app contract constraints not yet enforced by NeuroFlow's validator. */
export function workflowIssues(doc, tools) {
  const byId = new Map(tools.map(tool => [tool.id, tool]));
  const issues = [];
  const warn = (code, path, message) => issues.push({ severity: "warning", code, path, message });
  const declaration = ref => {
    const input = /^inputs\.([^.]+)$/.exec(ref ?? "");
    if (input) return Object.hasOwn(doc.inputs ?? {}, input[1]) ? doc.inputs[input[1]] : undefined;
    const output = /^steps\.([^.]+)\.outputs\.([^.]+)$/.exec(ref ?? "");
    return output && byId.get(doc.steps[output[1]]?.tool)?.outputs?.[output[2]];
  };
  for (const [id, step] of Object.entries(doc.steps)) {
    const tool = byId.get(step.tool);
    for (const [name, input] of Object.entries(tool?.inputs ?? {})) {
      const path = `steps.${id}.inputs.${name}`;
      const binding = step.inputs?.[name];
      const source = declaration(binding?.ref);
      // NeuroFlow 0.6.0 checks type, enum, min and max; this also covers the
      // per-item limits in neurodesk/parameter. validator.js keeps one issue per path.
      const invalid = binding && "constant" in binding && (name.startsWith("param_") || name === "engine")
        && parameterError(binding.constant, input);
      if (invalid) issues.push({ severity: "error", code: "constant-invalid", path, message: invalid });
      // The bval-bvec pair token stays in metadata because the runtime cannot inspect it.
      // Known bindings still need the same checks when imported or edited.
      const expected = gradientFormats(input);
      const provided = gradientFormats(source);
      if (expected.length && provided.length && !provided.some(format => expected.includes(format))) {
        issues.push({
          severity: "error", code: "formats-incompatible", path,
          message: `Formats are incompatible: expected ${expected.join(" or ")}, got ${provided.join(" or ")}.`,
        });
      }
      const limits = input.extensions?.["neurodesk/data"];
      if (limits) {
        const minimum = limits.minimum ?? 0;
        const maximum = limits.maximum;
        const bounded = minimum > 0 || Number.isInteger(maximum);
        let count;
        if (!binding) count = 0;
        else if ("constant" in binding) count = Array.isArray(binding.constant) ? binding.constant.length : 1;
        else if (source && elementType(source.type) === source.type) count = 1;
        if (count !== undefined) {
          if (count < minimum) warn("input-count", path, `Expected at least ${minimum} items; this binding supplies ${count}.`);
          if (Number.isInteger(maximum) && count > maximum) warn("input-count", path, `Expected at most ${maximum} items; this binding supplies ${count}.`);
        } else if (source && bounded) {
          const bounds = [`minimum ${minimum}`, ...(Number.isInteger(maximum) ? [`maximum ${maximum}`] : [])];
          warn("input-count", path, `Item count needs a run-time check (${bounds.join(", ")}).`);
        }
      }
    }
  }
  return issues;
}

/**
 * Issues keyed by step id; workflow-level issues, and any that name no step, are under "".
 * Step ids are matched whole, longest first, because an imported id may contain a dot.
 */
export function issuesByStep(issues, stepIds) {
  const ids = [...stepIds].sort((a, b) => b.length - a.length);
  const grouped = new Map();
  for (const issue of issues) {
    const path = issue.path ?? "";
    const key = ids.find(id => path === `steps.${id}` || path.startsWith(`steps.${id}.`)) ?? "";
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(issue);
  }
  return grouped;
}
