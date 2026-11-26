#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  DEFAULT_BEADS_REF,
  applyOperations,
  assertMemoryRef,
  formatJsonl,
  initBeadsRef,
  listBeads,
  mutateBeadsRef,
  readBeadsFromRef,
  readyBeads,
  summarizeBeads,
  syncBeadsRef,
} from './lib/beads.mjs';

const USAGE = `Usage: node scripts/beads.mjs <command> [options]

Commands:
  init                           Initialize orphan memory/beads ref if missing
  create --title ... --scope ... Create a new bead
  upsert --dedupe-key ...        Idempotently create or refresh a bead
  show <id>                      Show a single bead
  list [--status S] [--kind K]   List beads
  ready [--target T] [--single-app]
                                 List actionable unblocked, unleased beads
  dep add|remove <id> --blocked-by <otherId>
                                 Add or remove a blocking dependency
  claim <id> [--owner O] [--branch B] [--ttl-hours 24] [--expected-revision N]
  release <id> [--owner O] [--force]
  note <id> --message "..." [--actor A]
  close <id> --reason "..." [--pr N]
  reopen <id> [--message "..."]
  apply <ops.json> [--safe] [--max-creates N] [--max-updates N] [--single-app] [--dry-run]
  export [--format jsonl|snapshot] [--max-items N]
  sync [--remote origin] [--push]

Global options:
  --ref <git-ref>   Target ref under refs/heads/memory/ (default: ${DEFAULT_BEADS_REF})
  --actor <name>    Actor name (default: $BEADS_ACTOR, $USER, or "local-agent")
  --json            Machine-readable JSON output
`;

function splitCsv(value) {
  if (!value) return [];
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function parseScope(scopeSpec) {
  if (!scopeSpec) throw new Error('--scope is required (e.g. app:topofit, package:runtime-support, exe:synthseg, shared:components, repo)');
  const parts = scopeSpec.split(':');
  if (parts.length > 2) {
    throw new Error(`Invalid --scope "${scopeSpec}": expected "<type>" or "<type>:<target1,target2>"`);
  }
  const [type, rawTargets] = parts;
  return { type, targets: splitCsv(rawTargets) };
}

function parseStrictInt(value, flag) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^-?\d+$/.test(value.trim())) {
    throw new Error(`${flag} must be a valid integer (got "${value}")`);
  }
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${flag} must be a safe integer (got "${value}")`);
  }
  return parsed;
}

function parseStrictNumber(value, flag) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value.trim())) {
    throw new Error(`${flag} must be a positive number (got "${value}")`);
  }
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive finite number (got "${value}")`);
  }
  return parsed;
}

function formatRow(bead) {
  const scope = bead.scope.targets.length ? `${bead.scope.type}:${bead.scope.targets.join(',')}` : bead.scope.type;
  const lease = bead.lease ? ` [claimed:${bead.lease.owner}]` : '';
  const deps = bead.deps.blockedBy.length ? ` [blocked-by:${bead.deps.blockedBy.join(',')}]` : '';
  return `${bead.id}  r${bead.revision}  P${bead.priority}  ${bead.status.padEnd(11)}  ${bead.kind.padEnd(11)}  ${scope}  ${bead.title}${lease}${deps}`;
}

function printOutput(data, asJson, formatter) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${formatter(data)}\n`);
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      ref: { type: 'string', default: DEFAULT_BEADS_REF },
      actor: { type: 'string', default: process.env.BEADS_ACTOR || process.env.USER || 'local-agent' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      title: { type: 'string' },
      summary: { type: 'string' },
      kind: { type: 'string' },
      status: { type: 'string' },
      priority: { type: 'string' },
      scope: { type: 'string' },
      target: { type: 'string' },
      'dedupe-key': { type: 'string' },
      'blocked-by': { type: 'string' },
      parent: { type: 'string' },
      'discovered-from': { type: 'string' },
      'github-issue': { type: 'string' },
      pr: { type: 'string' },
      branch: { type: 'string' },
      evidence: { type: 'string' },
      owner: { type: 'string' },
      'ttl-hours': { type: 'string' },
      'expected-revision': { type: 'string' },
      message: { type: 'string' },
      reason: { type: 'string' },
      force: { type: 'boolean', default: false },
      'single-app': { type: 'boolean', default: false },
      safe: { type: 'boolean', default: false },
      'max-creates': { type: 'string' },
      'max-updates': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      format: { type: 'string', default: 'snapshot' },
      'max-items': { type: 'string' },
      remote: { type: 'string', default: 'origin' },
      push: { type: 'boolean', default: false },
    },
  });

  const [command, ...rest] = positionals;
  if (values.help || !command) {
    process.stdout.write(USAGE);
    return;
  }

  const cwd = process.cwd();
  const ref = assertMemoryRef(values.ref);
  const actor = values.actor;

  if (command === 'init') {
    const result = initBeadsRef(cwd, { ref });
    printOutput(result, values.json, (r) => `${r.created ? 'Initialized' : 'Already initialized'} ${ref} at ${r.sha.slice(0, 12)}`);
    return;
  }

  if (command === 'create' || command === 'upsert') {
    const op = { op: command };
    if (values.title !== undefined) op.title = values.title;
    if (values.summary !== undefined) op.summary = values.summary;
    if (values.kind !== undefined) op.kind = values.kind;
    if (values.status !== undefined) op.status = values.status;
    if (values.priority !== undefined) op.priority = parseStrictInt(values.priority, '--priority');
    if (values.scope !== undefined) op.scope = parseScope(values.scope);
    if (values['dedupe-key'] !== undefined) op.dedupeKey = values['dedupe-key'];
    if (values['blocked-by'] !== undefined || values.parent !== undefined || values['discovered-from'] !== undefined) {
      op.deps = {
        blockedBy: splitCsv(values['blocked-by']),
        parent: values.parent ?? null,
        discoveredFrom: values['discovered-from'] ?? null,
      };
    }
    if (values['github-issue'] !== undefined || values.pr !== undefined || values.branch !== undefined || values.evidence !== undefined) {
      op.links = {};
      if (values['github-issue'] !== undefined) op.links.githubIssue = parseStrictInt(values['github-issue'], '--github-issue');
      if (values.pr !== undefined) op.links.pr = parseStrictInt(values.pr, '--pr');
      if (values.branch !== undefined) op.links.branch = values.branch;
      if (values.evidence !== undefined) op.links.evidence = splitCsv(values.evidence);
    }
    if (values.message !== undefined) op.note = values.message;
    if (command === 'upsert' && values['expected-revision'] !== undefined) {
      op.expectedRevision = parseStrictInt(values['expected-revision'], '--expected-revision');
    }
    const res = mutateBeadsRef(cwd, [op], { ref, actor, message: `beads: ${command} ${op.dedupeKey || op.title || ''}`.trim() });
    const id = res.createdIds[0] ?? res.updatedIds[0] ?? res.untouchedIds[0];
    const bead = res.beads.get(id);
    printOutput({ commitSha: res.commitSha, changed: res.changed, bead }, values.json, (r) => formatRow(r.bead));
    return;
  }

  if (command === 'show') {
    const id = rest[0];
    if (!id) throw new Error('Usage: show <id>');
    const { beads } = readBeadsFromRef(cwd, ref);
    const bead = beads.get(id);
    if (!bead) throw new Error(`Bead not found: ${id}`);
    printOutput(bead, values.json, (b) => JSON.stringify(b, null, 2));
    return;
  }

  if (command === 'list') {
    const { beads } = readBeadsFromRef(cwd, ref);
    const items = listBeads(beads, {
      status: values.status ?? null,
      kind: values.kind ?? null,
      target: values.target ?? null,
      singleAppOnly: values['single-app'],
    });
    printOutput(items, values.json, (rows) => (rows.length ? rows.map(formatRow).join('\n') : '(no beads)'));
    return;
  }

  if (command === 'ready') {
    const { beads } = readBeadsFromRef(cwd, ref);
    const items = readyBeads(beads, {
      kind: values.kind ?? null,
      target: values.target ?? null,
      singleAppOnly: values['single-app'],
    });
    printOutput(items, values.json, (rows) => (rows.length ? rows.map(formatRow).join('\n') : '(no ready beads)'));
    return;
  }

  if (command === 'dep') {
    const [action, id] = rest;
    if ((action !== 'add' && action !== 'remove') || !id || !values['blocked-by']) {
      throw new Error('Usage: dep add|remove <id> --blocked-by <otherId>');
    }
    const op = {
      op: action === 'add' ? 'dep_add' : 'dep_remove',
      id,
      blockedBy: values['blocked-by'],
    };
    if (values['expected-revision'] !== undefined) {
      op.expectedRevision = parseStrictInt(values['expected-revision'], '--expected-revision');
    }
    const res = mutateBeadsRef(cwd, [op], { ref, actor, message: `beads: dep ${action} ${id}` });
    printOutput(res.beads.get(id), values.json, formatRow);
    return;
  }

  if (command === 'claim') {
    const id = rest[0];
    if (!id) throw new Error('Usage: claim <id> [--owner O] [--branch B] [--ttl-hours 24]');
    const ttlHours = values['ttl-hours'] !== undefined ? parseStrictNumber(values['ttl-hours'], '--ttl-hours') : 24;
    const op = {
      op: 'claim',
      id,
      owner: values.owner ?? actor,
      ttlHours,
    };
    if (values.branch !== undefined) op.branch = values.branch;
    if (values.message !== undefined) op.note = values.message;
    if (values['expected-revision'] !== undefined) {
      op.expectedRevision = parseStrictInt(values['expected-revision'], '--expected-revision');
    }
    const res = mutateBeadsRef(cwd, [op], { ref, actor, message: `beads: claim ${id}` });
    printOutput(res.beads.get(id), values.json, formatRow);
    return;
  }

  if (command === 'release') {
    const id = rest[0];
    if (!id) throw new Error('Usage: release <id> [--owner O] [--force]');
    const op = {
      op: 'release',
      id,
      owner: values.owner ?? actor,
      force: values.force,
    };
    if (values.message !== undefined) op.note = values.message;
    if (values['expected-revision'] !== undefined) {
      op.expectedRevision = parseStrictInt(values['expected-revision'], '--expected-revision');
    }
    const res = mutateBeadsRef(cwd, [op], { ref, actor, message: `beads: release ${id}` });
    printOutput(res.beads.get(id), values.json, formatRow);
    return;
  }

  if (command === 'note') {
    const id = rest[0];
    if (!id || !values.message) throw new Error('Usage: note <id> --message "..."');
    const op = {
      op: 'note',
      id,
      note: values.message,
    };
    if (values['expected-revision'] !== undefined) {
      op.expectedRevision = parseStrictInt(values['expected-revision'], '--expected-revision');
    }
    const res = mutateBeadsRef(cwd, [op], { ref, actor, message: `beads: note ${id}` });
    printOutput(res.beads.get(id), values.json, formatRow);
    return;
  }

  if (command === 'close') {
    const id = rest[0];
    if (!id || !values.reason) throw new Error('Usage: close <id> --reason "..." [--pr N]');
    const op = {
      op: 'close',
      id,
      reason: values.reason,
    };
    if (values.pr !== undefined) op.pr = parseStrictInt(values.pr, '--pr');
    if (values['expected-revision'] !== undefined) {
      op.expectedRevision = parseStrictInt(values['expected-revision'], '--expected-revision');
    }
    const res = mutateBeadsRef(cwd, [op], { ref, actor, message: `beads: close ${id}` });
    printOutput(res.beads.get(id), values.json, formatRow);
    return;
  }

  if (command === 'reopen') {
    const id = rest[0];
    if (!id) throw new Error('Usage: reopen <id> [--message "..."]');
    const op = { op: 'reopen', id };
    if (values.message !== undefined) op.note = values.message;
    if (values['expected-revision'] !== undefined) {
      op.expectedRevision = parseStrictInt(values['expected-revision'], '--expected-revision');
    }
    const res = mutateBeadsRef(cwd, [op], { ref, actor, message: `beads: reopen ${id}` });
    printOutput(res.beads.get(id), values.json, formatRow);
    return;
  }

  if (command === 'apply') {
    const file = rest[0];
    if (!file) throw new Error('Usage: apply <ops.json> [--safe] [--dry-run]');
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    let operations;
    if (Array.isArray(raw)) {
      operations = raw;
    } else if (raw && typeof raw === 'object' && !Array.isArray(raw) && Array.isArray(raw.operations)) {
      const extraKeys = Object.keys(raw).filter((key) => key !== 'operations');
      if (extraKeys.length > 0) {
        throw new Error(`Unexpected top-level field(s) in operations file: ${extraKeys.join(', ')}`);
      }
      operations = raw.operations;
    } else {
      throw new Error('Operations file must be a JSON array or an object with an "operations" array');
    }
    const maxCreates = parseStrictInt(values['max-creates'], '--max-creates') ?? (values.safe ? 5 : Infinity);
    const maxUpdates = parseStrictInt(values['max-updates'], '--max-updates') ?? (values.safe ? 10 : Infinity);
    const applyOptions = {
      actor,
      maxCreates,
      maxUpdates,
      requireExpectedRevision: values.safe,
      singleAppOnly: values['single-app'],
      lockActor: values.safe,
    };
    if (values['dry-run']) {
      const { beads } = readBeadsFromRef(cwd, ref);
      const res = applyOperations(beads, operations, applyOptions);
      printOutput({ dryRun: true, createdIds: res.createdIds, updatedIds: res.updatedIds, untouchedIds: res.untouchedIds }, values.json, (r) => `Dry run valid: ${r.createdIds.length} created, ${r.updatedIds.length} updated, ${r.untouchedIds.length} untouched`);
      return;
    }
    const res = mutateBeadsRef(cwd, operations, { ref, message: `beads: apply ${operations.length} op(s) by ${actor}`, ...applyOptions });
    printOutput({ commitSha: res.commitSha, changed: res.changed, createdIds: res.createdIds, updatedIds: res.updatedIds, untouchedIds: res.untouchedIds }, values.json, (r) => `Applied (${r.commitSha.slice(0, 12)}): ${r.createdIds.length} created, ${r.updatedIds.length} updated, ${r.untouchedIds.length} untouched`);
    return;
  }

  if (command === 'export') {
    const { beads } = readBeadsFromRef(cwd, ref);
    if (values.format === 'jsonl') {
      process.stdout.write(formatJsonl(beads));
      return;
    }
    if (values.format !== 'snapshot') {
      throw new Error(`Unsupported --format "${values.format}": expected "snapshot" or "jsonl"`);
    }
    const maxItems = parseStrictInt(values['max-items'], '--max-items') ?? 100;
    const snapshot = summarizeBeads(beads, { maxItems });
    process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
    return;
  }

  if (command === 'sync') {
    const res = syncBeadsRef(cwd, { ref, remote: values.remote, push: values.push });
    printOutput(res, values.json, (r) => `Synced ${r.ref} (${r.count} beads, sha ${r.sha.slice(0, 12)}${r.pushed ? ', pushed' : ''})`);
    return;
  }

  throw new Error(`Unknown command: ${command}\n\n${USAGE}`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`beads error: ${error.message}\n`);
  process.exitCode = 1;
}
