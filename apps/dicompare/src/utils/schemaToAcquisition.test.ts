import { describe, it, expect } from 'vitest';
import { convertSchemaToAcquisition } from './schemaToAcquisition';
import { seriesFieldToSchemaField } from './schemaFieldConverters';
import type { UnifiedSchema } from '../hooks/useSchemaService';

// Guarantee: importing a schema keeps a series field's graded constraint and
// custom messages, so saving it again writes them back out (issue #23).
describe('convertSchemaToAcquisition series fields', () => {
  const echoTime = {
    field: 'EchoTime',
    tag: '0018,0081',
    value: 0.8,
    tolerance: 0.1,
    errorTolerance: 0.3,
    warningMessage: 'Echo time drifted to %V',
    errorMessage: 'Echo time %V is out of range',
  };
  const schemaJson = JSON.stringify({
    name: 'Test',
    acquisitions: {
      T2star: {
        fields: [],
        series: [{ name: 'Echo 1', fields: [echoTime] }],
      },
    },
  });
  const schema = { id: 'test' } as UnifiedSchema;

  it('keeps graded bands and messages through import and export', async () => {
    const acquisition = await convertSchemaToAcquisition(schema, '0', async () => schemaJson);
    const field = acquisition!.series![0].fields[0];

    expect(field.graded).toBeDefined();
    expect(field.warningMessage).toBe(echoTime.warningMessage);
    expect(field.errorMessage).toBe(echoTime.errorMessage);

    const out = seriesFieldToSchemaField(field);
    expect(out).toMatchObject({
      value: 0.8,
      tolerance: 0.1,
      errorTolerance: 0.3,
      warningMessage: echoTime.warningMessage,
      errorMessage: echoTime.errorMessage,
    });
  });
});
