import { fieldToSchemaField, seriesFieldToSchemaField } from './schemaFieldConverters';
import type { DicomField, SeriesField } from '../types';

const baseField = (overrides: Partial<DicomField>): DicomField => ({
  tag: '0018,0081',
  name: 'EchoTime',
  keyword: 'EchoTime',
  value: 3,
  vr: 'DS',
  level: 'acquisition',
  ...overrides,
});

describe('fieldToSchemaField severity', () => {
  test('serializes warning severity', () => {
    const out = fieldToSchemaField(baseField({ severity: 'warning' }));
    expect(out.severity).toBe('warning');
  });

  test('omits default error severity', () => {
    expect(fieldToSchemaField(baseField({ severity: 'error' })).severity).toBeUndefined();
    expect(fieldToSchemaField(baseField({})).severity).toBeUndefined();
  });

  test('carries the constraint value alongside severity', () => {
    const out = fieldToSchemaField(baseField({
      value: 66,
      severity: 'warning',
      validationRule: { type: 'exact', value: 66 },
    }));
    expect(out.value).toBe(66);
    expect(out.severity).toBe('warning');
  });
});

describe('fieldToSchemaField notes', () => {
  test('serializes a trimmed note', () => {
    const out = fieldToSchemaField(baseField({ notes: '  Vendor requires 3T for SNR.  ' }));
    expect(out.notes).toBe('Vendor requires 3T for SNR.');
  });

  test('omits absent or whitespace-only notes', () => {
    expect(fieldToSchemaField(baseField({})).notes).toBeUndefined();
    expect(fieldToSchemaField(baseField({ notes: '   ' })).notes).toBeUndefined();
  });

  // Notes are an acquisition-field concept only; on a series the rationale is
  // recorded once against the series itself. The metaschema rejects the key on
  // a series field, so writing one here would emit an invalid schema.
  test('never writes a note onto a series field', () => {
    const seriesField = {
      tag: '0018,1314',
      name: 'FlipAngle',
      value: 9,
      notes: 'Ernst angle',
    } as SeriesField & { notes: string };

    expect(seriesFieldToSchemaField(seriesField).notes).toBeUndefined();
    // ...even though the same object keeps its note on the acquisition path.
    expect(fieldToSchemaField(seriesField).notes).toBe('Ernst angle');
  });
});

describe('fieldToSchemaField custom messages', () => {
  test('serializes trimmed warning/error messages', () => {
    const out = fieldToSchemaField(baseField({
      warningMessage: '  %V is a bit off  ',
      errorMessage: '%V is wrong',
    }));
    expect(out.warningMessage).toBe('%V is a bit off');
    expect(out.errorMessage).toBe('%V is wrong');
  });

  test('omits absent or whitespace-only messages', () => {
    const out = fieldToSchemaField(baseField({ warningMessage: '   ', errorMessage: '' }));
    expect(out.warningMessage).toBeUndefined();
    expect(out.errorMessage).toBeUndefined();
  });

  // Messages are orthogonal to the constraint representation — they ride along on
  // graded and series fields too.
  test('serializes messages on a series field', () => {
    const out = seriesFieldToSchemaField({
      tag: '0018,0081', name: 'EchoTime', value: 10,
      errorMessage: 'no echo near 10ms',
    } as SeriesField);
    expect(out.errorMessage).toBe('no echo near 10ms');
  });
});
