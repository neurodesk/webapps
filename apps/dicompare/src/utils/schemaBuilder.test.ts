import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { buildSchemaFromAcquisitions } from './schemaBuilder';
import { convertSchemaToAcquisition } from './schemaToAcquisition';
import type { Acquisition, DicomField, SeriesField } from '../types';

const acquisition = (overrides: Partial<Acquisition>): Acquisition => ({
  id: 'a1',
  protocolName: 'T2star',
  seriesDescription: '',
  totalFiles: 0,
  acquisitionFields: [],
  series: [],
  metadata: {},
  ...overrides,
});

const gradedEchoTime = {
  tag: '0018,0081',
  name: 'Echo Time',
  keyword: 'EchoTime',
  value: 5,
  graded: { value: 5, tolerance: 0.5, errorTolerance: 2 },
  warningMessage: 'Echo time drifted to %V',
  errorMessage: 'Echo time %V is out of range',
};

describe('buildSchemaFromAcquisitions', () => {
  it('preserves a defined empty contains constraint at acquisition and series levels', () => {
    const field = {
      tag: '0008,103E',
      name: 'SeriesDescription',
      value: 'T1',
      vr: 'LO',
      level: 'acquisition' as const,
      validationRule: { type: 'contains' as const, contains: '' },
    };
    const schema = buildSchemaFromAcquisitions([acquisition({
      acquisitionFields: [field],
      series: [{ name: 'Series 1', fields: [field] }],
    })], {});
    expect(JSON.parse(JSON.stringify(schema)).acquisitions.T2star).toEqual({
      description: '',
      detailed_description: '',
      fields: [{ field: 'SeriesDescription', tag: '0008,103E', contains: '' }],
      series: [{ name: 'Series 1', fields: [{ field: 'SeriesDescription', tag: '0008,103E', contains: '' }] }],
    });
  });

  it('serializes arbitrary acquisition names without consuming object prototype keys', () => {
    const names = ['__proto__', 'constructor', 'prototype', 'toString', 'Scan'];
    const schema = buildSchemaFromAcquisitions(names.map(protocolName => acquisition({
      protocolName,
      acquisitionFields: [{ tag: '0008,0060', name: 'Modality', value: 'MR', vr: 'CS', level: 'acquisition' }],
    })), {});
    const exported = JSON.parse(JSON.stringify(schema));
    expect(Object.keys(exported.acquisitions)).toEqual(names);
    for (const name of names) {
      expect(Object.hasOwn(exported.acquisitions, name)).toBe(true);
      expect(exported.acquisitions[name].fields).toEqual([{ field: 'Modality', tag: '0008,0060', value: 'MR' }]);
    }
  });

  it('writes graded bands and custom messages at both levels', () => {
    const schema: any = buildSchemaFromAcquisitions([acquisition({
      acquisitionFields: [{ ...gradedEchoTime, vr: 'DS', level: 'acquisition' } as DicomField],
      series: [{ name: 'Echo 1', fields: [gradedEchoTime as SeriesField] }],
    })], { name: 'Test' });

    const expected = {
      field: 'EchoTime',
      tag: '0018,0081',
      value: 5,
      tolerance: 0.5,
      errorTolerance: 2,
      warningMessage: gradedEchoTime.warningMessage,
      errorMessage: gradedEchoTime.errorMessage,
    };
    const acq = schema.acquisitions.T2star;
    expect(acq.fields[0]).toEqual(expected);
    expect(acq.series[0].fields[0]).toEqual(expected);
  });

  it('does not write a value alongside range or contains constraints', () => {
    const schema: any = buildSchemaFromAcquisitions([acquisition({
      acquisitionFields: [
        { tag: '0018,0050', name: 'SliceThickness', value: 4.2, vr: 'DS', level: 'acquisition',
          validationRule: { type: 'range', min: 4, max: 5 } },
        { tag: '0008,0008', name: 'ImageType', value: ['M'], vr: 'CS', level: 'acquisition',
          validationRule: { type: 'contains_any', contains_any: ['M', 'P'] } },
      ],
    })], {});
    expect(schema.acquisitions.T2star.fields).toEqual([
      { field: 'SliceThickness', tag: '0018,0050', min: 4, max: 5 },
      { field: 'ImageType', tag: '0008,0008', contains_any: ['M', 'P'] },
    ]);
  });

  it('drops series fields with no constraint and series left empty', () => {
    const schema: any = buildSchemaFromAcquisitions([acquisition({
      series: [{ name: 'Empty', fields: [{ name: 'EchoTime', tag: '0018,0081', value: undefined }] }],
    })], {});
    expect(schema.acquisitions.T2star.series).toEqual([]);
  });
});

// Guarantee: every shipped schema survives import (convertSchemaToAcquisition)
// followed by save (buildSchemaFromAcquisitions). Normalised for differences
// that don't change meaning: key order, the legacy vr/dataType keys, empty
// arrays/objects, and the 'derived' tag written for tagless fields.
describe('shipped schemas round-trip through import and save', () => {
  const dir = join(__dirname, '../../public/schemas');
  const files = readdirSync(dir).filter(f =>
    f.endsWith('.json') && f !== 'index.json' && !f.startsWith('doi-mapping'));

  const canon = (o: any, parentHasTag = true): any => {
    if (Array.isArray(o)) return o.map(x => canon(x));
    if (!o || typeof o !== 'object') return o;
    const out: Record<string, any> = {};
    for (const k of Object.keys(o).sort()) {
      const v = o[k];
      if (k === 'vr' || k === 'dataType') continue;
      if (Array.isArray(v) && !v.length) continue;
      if (v && typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length) continue;
      // Some schemas store a field's value wrapped as { value, validationRule }.
      out[k] = k === 'value' && v && typeof v === 'object' && !Array.isArray(v) && 'validationRule' in v
        ? v.value : canon(v);
    }
    if ('field' in out && out.tag === undefined) out.tag = 'derived';
    return out;
  };

  it.each(files)('%s', async (file) => {
    const text = readFileSync(join(dir, file), 'utf8');
    const original = JSON.parse(text);
    const names = Object.keys(original.acquisitions || {});
    const acquisitions = await Promise.all(
      names.map((_, i) => convertSchemaToAcquisition({ id: file } as any, String(i), async () => text)));

    const rebuilt: any = buildSchemaFromAcquisitions(acquisitions as Acquisition[], original);
    for (const name of names) {
      expect(canon(rebuilt.acquisitions[name]), `${file} / ${name}`)
        .toEqual(canon(original.acquisitions[name]));
    }
  });
});
