/**
 * FileIOController bucket logic: categorization, the single-file and mutual-exclusivity rules,
 * reordering and moving. Pure apart from the DOM-backed list rendering, which these paths skip.
 */

import { jest } from '@jest/globals';
import { FileIOController } from './FileIOController.js';

const file = name => ({ name });
const names = bucket => bucket.map(e => e.name);

function controller() {
  const callbacks = {
    onFilesChanged: jest.fn(), onMagnitudeFilesChanged: jest.fn(), onPhaseFilesChanged: jest.fn(),
  };
  return { io: new FileIOController(callbacks), callbacks };
}

describe('categorizeFile', () => {
  const { io } = controller();
  const cat = (name, metadata) => io.categorizeFile(file(name), metadata);

  test.each([
    ['sub-01_echo-1_part-phase_MEGRE.nii.gz', 'phase'],
    ['sub-01_echo-1_part-mag_MEGRE.nii.gz', 'magnitude'],
    ['gre_e2_ph.nii', 'phase'],
    ['gre_e2.phase.nii', 'phase'],
    ['totalfield.nii.gz', 'totalField'],
    ['B0.nii', 'totalField'],
    ['field_map.nii.gz', 'totalField'],
    ['localfield.nii', 'localField'],
    ['chi_map.nii.gz', 'localField'],
    ['magnitude_e1.nii', 'magnitude'],
    ['anatomy.nii.gz', 'extra'],
  ])('%s -> %s', (name, bucket) => {
    expect(cat(name)).toBe(bucket);
  });

  test('sidecars and non-NIfTI files', () => {
    expect(cat('gre_e1.JSON')).toBe('json');
    expect(cat('notes.txt')).toBe('extra');
    expect(cat('phase.dcm')).toBe('extra');
  });

  test('metadata wins over the filename', () => {
    expect(cat('phase.nii', { ImageType: ['ORIGINAL', 'PRIMARY', 'M'] })).toBe('magnitude');
    expect(cat('mag.nii', { ImageType: ['ORIGINAL', 'PRIMARY', 'P'] })).toBe('phase');
  });

  test('"phase" must be a separate token', () => {
    // "phaseimage" in a protocol name is not a phase marker on its own.
    expect(cat('MGE_phaseimage_lowres.nii')).not.toBe('phase');
    expect(cat('sub-01_phasecontrast.nii')).toBe('extra');
  });
});

describe('bucket rules', () => {
  test('totalField and localField hold one file; a second moves the first to extra', () => {
    const { io } = controller();
    io._addToBucket('totalField', { name: 'a.nii' });
    io._addToBucket('totalField', { name: 'b.nii' });
    expect(names(io.buckets.totalField)).toEqual(['b.nii']);
    expect(names(io.buckets.extra)).toEqual(['a.nii']);
  });

  test.each([
    ['phase', ['totalField', 'localField']],
    ['totalField', ['phase', 'localField']],
    ['localField', ['phase', 'totalField']],
  ])('adding to %s clears the other primary buckets into extra', (target, others) => {
    const { io } = controller();
    io.buckets.phase = [{ name: 'p1.nii' }, { name: 'p2.nii' }];
    io.buckets.totalField = [{ name: 't.nii' }];
    io.buckets.localField = [{ name: 'l.nii' }];
    io.buckets.magnitude = [{ name: 'm.nii' }];
    const before = { phase: names(io.buckets.phase), totalField: ['t.nii'], localField: ['l.nii'] };

    io._enforceExclusivity(target);

    for (const other of others) expect(io.buckets[other]).toEqual([]);
    expect(names(io.buckets[target])).toEqual(before[target]);
    expect(names(io.buckets.extra).sort()).toEqual(others.flatMap(o => before[o]).sort());
    expect(names(io.buckets.magnitude)).toEqual(['m.nii']);
  });

  test('magnitude and json never trigger exclusivity', () => {
    const { io } = controller();
    io.buckets.phase = [{ name: 'p.nii' }];
    io.buckets.totalField = [{ name: 't.nii' }];
    io._enforceExclusivity('magnitude');
    io._enforceExclusivity('json');
    expect(io.buckets.phase).toHaveLength(1);
    expect(io.buckets.totalField).toHaveLength(1);
  });

  test('the input mode follows the buckets', () => {
    const { io } = controller();
    expect(io.getInputMode()).toBe('raw');
    io._addToBucket('totalField', { name: 't.nii' });
    expect(io.getInputMode()).toBe('totalField');
    io._addToBucket('localField', { name: 'l.nii' });
    expect(io.getInputMode()).toBe('localField');
    expect(io.buckets.totalField).toEqual([]);
  });

  test('raw data is valid only with matching, non-zero magnitude and phase counts', () => {
    const { io } = controller();
    expect(io.hasValidData()).toBe(false);
    io.buckets.magnitude = [{ name: 'm1' }, { name: 'm2' }];
    io.buckets.phase = [{ name: 'p1' }];
    expect(io.hasValidData()).toBe(false);
    io.buckets.phase.push({ name: 'p2' });
    expect(io.hasValidData()).toBe(true);
  });
});

describe('addFiles', () => {
  test('sorts each bucket in natural order and fires the callbacks once', async () => {
    const { io, callbacks } = controller();
    await io.addFiles(['mag_e10.nii', 'mag_e2.nii', 'mag_e1.nii'].map(file));
    expect(names(io.buckets.magnitude)).toEqual(['mag_e1.nii', 'mag_e2.nii', 'mag_e10.nii']);
    expect(callbacks.onMagnitudeFilesChanged).toHaveBeenCalledTimes(1);
    expect(callbacks.onFilesChanged).toHaveBeenCalledWith('buckets', null);
  });

  test('takes echo time (ms) and number from a matching sidecar', async () => {
    const { io } = controller();
    await io.addFiles([
      file('gre_e2_ph.nii'),
      { name: 'gre_e2_ph.json', text: async () => JSON.stringify({ EchoTime: 0.0125, EchoNumber: 2 }) },
    ]);
    expect(io.buckets.phase[0]).toMatchObject({ echoTime: 12.5, echoNumber: 2 });
    expect(names(io.buckets.json)).toEqual(['gre_e2_ph.json']);
  });

  test('reports an unreadable sidecar and still adds the image', async () => {
    const updateOutput = jest.fn();
    const io = new FileIOController({ updateOutput });
    await io.addFiles([file('gre_ph.nii'), { name: 'gre_ph.json', text: async () => '{oops' }]);
    expect(updateOutput).toHaveBeenCalledWith(expect.stringContaining('Could not read sidecar gre_ph.json'));
    expect(names(io.buckets.phase)).toEqual(['gre_ph.nii']);
  });
});

describe('reorderFile', () => {
  function withMagnitudes() {
    const c = controller();
    c.io.buckets.magnitude = ['a', 'b', 'c', 'd'].map(name => ({ name }));
    return c;
  }

  test('moves an entry to the new position', () => {
    const { io, callbacks } = withMagnitudes();
    io.reorderFile('magnitude', 0, 2);
    expect(names(io.buckets.magnitude)).toEqual(['b', 'c', 'a', 'd']);
    io.reorderFile('magnitude', 3, 0);
    expect(names(io.buckets.magnitude)).toEqual(['d', 'b', 'c', 'a']);
    expect(callbacks.onMagnitudeFilesChanged).toHaveBeenCalledTimes(2);
  });

  test('clamps the target index', () => {
    const { io } = withMagnitudes();
    io.reorderFile('magnitude', 1, 99);
    expect(names(io.buckets.magnitude)).toEqual(['a', 'c', 'd', 'b']);
    io.reorderFile('magnitude', 2, -5);
    expect(names(io.buckets.magnitude)).toEqual(['d', 'a', 'c', 'b']);
  });

  test('ignores an out-of-range source, an unknown bucket, or a no-op move', () => {
    const { io, callbacks } = withMagnitudes();
    io.reorderFile('magnitude', 4, 0);
    io.reorderFile('magnitude', -1, 0);
    io.reorderFile('nonexistent', 0, 1);
    io.reorderFile('magnitude', 2, 2);
    expect(names(io.buckets.magnitude)).toEqual(['a', 'b', 'c', 'd']);
    expect(callbacks.onFilesChanged).not.toHaveBeenCalled();
  });
});

describe('moveFile and removeFile', () => {
  test('moving into phase applies exclusivity and sorts the target', () => {
    const { io } = controller();
    io.buckets.extra = [{ name: 'z_ph.nii' }];
    io.buckets.phase = [{ name: 'a_ph.nii' }];
    io.buckets.totalField = [{ name: 'total.nii' }];
    io.moveFile('extra', 0, 'phase');
    expect(names(io.buckets.phase)).toEqual(['a_ph.nii', 'z_ph.nii']);
    expect(names(io.buckets.extra)).toEqual(['total.nii']);
  });

  test('moving into a single-file bucket displaces its occupant', () => {
    const { io } = controller();
    io.buckets.extra = [{ name: 'new.nii' }];
    io.buckets.localField = [{ name: 'old.nii' }];
    io.moveFile('extra', 0, 'localField');
    expect(names(io.buckets.localField)).toEqual(['new.nii']);
    expect(names(io.buckets.extra)).toEqual(['old.nii']);
  });

  test('removeFile drops the entry and ignores bad indices', () => {
    const { io } = controller();
    io.buckets.magnitude = [{ name: 'a' }, { name: 'b' }];
    io.removeFile('magnitude', 5);
    io.removeFile('magnitude', 0);
    expect(names(io.buckets.magnitude)).toEqual(['b']);
  });
});
