/**
 * QsmDicomInput (upstream DicomController) _classifyBatch: sorting dcm2niix output into magnitude, phase and extras, with
 * echo times and field strength from the sidecars. (FileImport.test.js covers Bruker naming.)
 */

import { jest } from '@jest/globals';
import { QsmDicomInput } from './QsmDicomInput.js';

const nifti = name => ({ name });
const sidecar = (name, json) => ({ name, text: async () => (typeof json === 'string' ? json : JSON.stringify(json)) });

function classify(niftis, sidecars = []) {
  const updateOutput = jest.fn();
  const dicom = new QsmDicomInput({ updateOutput });
  return dicom._classifyBatch(niftis, sidecars).then(result => ({ result, updateOutput }));
}

describe('QsmDicomInput._classifyBatch', () => {
  test('sorts each component by echo time and converts it to ms', async () => {
    const { result } = await classify(
      ['gre_e3', 'gre_e1', 'gre_e2', 'gre_e3_ph', 'gre_e1_ph', 'gre_e2_ph'].map(n => nifti(`${n}.nii`)),
      [1, 2, 3].flatMap(e => [
        sidecar(`gre_e${e}.json`, { EchoTime: e * 0.005, EchoNumber: e, ImageType: ['ORIGINAL', 'PRIMARY', 'M'] }),
        sidecar(`gre_e${e}_ph.json`, { EchoTime: e * 0.005, EchoNumber: e, ImageType: ['ORIGINAL', 'PRIMARY', 'P'] }),
      ]),
    );
    expect(result.magnitude.map(e => e.name)).toEqual(['gre_e1.nii', 'gre_e2.nii', 'gre_e3.nii']);
    expect(result.phase.map(e => e.name)).toEqual(['gre_e1_ph.nii', 'gre_e2_ph.nii', 'gre_e3_ph.nii']);
    expect(result.phase.map(e => e.echoTime)).toEqual([5, 10, 15]);
    expect(result.echoTimes).toEqual([5, 10, 15]);
    expect(result.jsonFiles).toHaveLength(6);
  });

  test('falls back to the echo number when echo times are missing', async () => {
    const { result } = await classify(
      [nifti('b.nii'), nifti('a.nii')],
      [sidecar('a.json', { EchoNumber: 2 }), sidecar('b.json', { EchoNumber: 1 })],
    );
    expect(result.magnitude.map(e => e.name)).toEqual(['b.nii', 'a.nii']);
    expect(result.echoTimes).toEqual([]);
  });

  test('without sidecars, the _ph suffix marks phase and everything else is magnitude', async () => {
    const { result } = await classify([nifti('scan_e1.nii.gz'), nifti('scan_e1_ph.nii.gz')]);
    expect(result.magnitude.map(e => e.name)).toEqual(['scan_e1.nii.gz']);
    expect(result.phase.map(e => e.name)).toEqual(['scan_e1_ph.nii.gz']);
    expect(result.magnitude[0]).toMatchObject({ echoTime: null, echoNumber: null });
    expect(result.fieldStrength).toBeNull();
  });

  test('images the classifier marks as other go to extras and are reported', async () => {
    const { result, updateOutput } = await classify(
      [nifti('loc.nii'), nifti('gre.nii')],
      [sidecar('loc.json', { ImageType: ['ORIGINAL', 'PRIMARY', 'LOCALIZER'] })],
    );
    expect(result.extras.map(e => e.name)).toEqual(['loc.nii']);
    expect(result.magnitude.map(e => e.name)).toEqual(['gre.nii']);
    // The plural counts magnitude + phase only.
    expect(updateOutput).toHaveBeenCalledWith('Found 1 magnitude and 0 phase image (1 other)');
  });

  test.each([
    [{ MagneticFieldStrength: 7 }, 7],
    [{ FieldStrength: 3 }, 3],
    [{ field_strength: 1.5 }, 1.5],
    [{}, null],
  ])('field strength from %j', async (json, expected) => {
    const { result } = await classify([nifti('gre.nii')], [sidecar('gre.json', json)]);
    expect(result.fieldStrength).toBe(expected);
  });

  test('takes the field strength from the first image that has one', async () => {
    const { result } = await classify(
      [nifti('a.nii'), nifti('b.nii')],
      [sidecar('a.json', { MagneticFieldStrength: 3 }), sidecar('b.json', { MagneticFieldStrength: 7 })],
    );
    expect(result.fieldStrength).toBe(3);
  });

  test('a malformed sidecar is skipped, not fatal', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { result } = await classify([nifti('gre_ph.nii')], [sidecar('gre_ph.json', '{not json')]);
      expect(result.phase.map(e => e.name)).toEqual(['gre_ph.nii']);
      expect(result.jsonFiles).toEqual([]);
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  test('the summary pluralizes on the magnitude + phase count', async () => {
    expect((await classify([nifti('gre.nii')])).updateOutput)
      .toHaveBeenCalledWith('Found 1 magnitude and 0 phase image');
    expect((await classify([nifti('gre.nii'), nifti('gre_ph.nii')])).updateOutput)
      .toHaveBeenCalledWith('Found 1 magnitude and 1 phase images');
  });
});

describe('QsmDicomInput._processResults', () => {
  test('passes the classified batch to onConversionComplete', async () => {
    const onConversionComplete = jest.fn();
    const dicom = new QsmDicomInput({ onConversionComplete, updateOutput: () => {} });
    await dicom._processResults([nifti('gre.nii'), nifti('gre_ph.nii'), sidecar('gre.json', { EchoTime: 0.01 })]);
    const batch = onConversionComplete.mock.calls[0][0];
    expect(batch.magnitude[0]).toMatchObject({ name: 'gre.nii', echoTime: 10 });
    expect(batch.phase.map(e => e.name)).toEqual(['gre_ph.nii']);
  });

  test('reports when dcm2niix produced no NIfTI', async () => {
    const onConversionComplete = jest.fn();
    const updateOutput = jest.fn();
    await new QsmDicomInput({ onConversionComplete, updateOutput })._processResults([sidecar('x.json', {})]);
    expect(onConversionComplete).not.toHaveBeenCalled();
    expect(updateOutput).toHaveBeenCalledWith(expect.stringContaining('No NIfTI files produced'));
  });
});
