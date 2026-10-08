import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { fromSchemaField, toSchemaField } from '../components/common/constraintModel';

// Guarantee: threading a shipped schema's numeric fields through the graded model
// (fromSchemaField -> toSchemaField) does not change their serialized constraint —
// no error becomes a warning, no bound shifts. Existing schemas keep their exact
// behavior; the new keys are purely additive.

const SCHEMA_DIR = join(__dirname, '../../public/schemas');

// The constraint-relevant keys the graded model round-trips. Any other keys
// (tag, vr, field, dataType, notes, valueMultiplicity, …) are carried by the
// surrounding converters, not by from/toSchemaField, so we compare only these.
const CONSTRAINT_KEYS = [
  'value', 'min', 'max', 'tolerance',
  'errorMin', 'errorMax', 'errorTolerance', 'reference', 'severity',
] as const;

function constraintSubset(f: any): Record<string, any> {
  const out: Record<string, any> = {};
  for (const k of CONSTRAINT_KEYS) if (f[k] !== undefined) out[k] = f[k];
  return out;
}

function collectFields(schema: any): any[] {
  const fields: any[] = [];
  const acqs = schema.acquisitions ?? {};
  for (const acq of Object.values<any>(acqs)) {
    for (const f of acq.fields ?? []) fields.push(f);
    for (const s of acq.series ?? []) {
      for (const f of s.fields ?? []) fields.push(f);
    }
  }
  return fields;
}

const schemaFiles = readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.json'));

describe('shipped schemas round-trip through the graded model unchanged', () => {
  it('finds schema files', () => {
    expect(schemaFiles.length).toBeGreaterThan(0);
  });

  for (const file of schemaFiles) {
    const schema = JSON.parse(readFileSync(join(SCHEMA_DIR, file), 'utf-8'));
    const fields = collectFields(schema);

    it(`${file}: numeric fields serialize identically`, () => {
      for (const field of fields) {
        const graded = fromSchemaField(field);
        // Non-numeric fields (strings/enums/lists/contains*) opt out — the model
        // returns null and the legacy path serializes them untouched.
        if (graded === null) continue;

        const before = constraintSubset(field);
        const after = constraintSubset(toSchemaField(graded));
        expect(after, `${file} / ${field.field}`).toEqual(before);
      }
    });
  }
});
