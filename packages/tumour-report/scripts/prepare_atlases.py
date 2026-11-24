"""Prepare compact ICBM 152 2009a atlases from raidionics_rads_lib for browser use.

    python prepare_atlases.py <raidionics_rads_lib/raidionicsrads/Atlases> <output_dir>

Outputs on the canonical 197 x 233 x 189 1 mm RAS ICBM 2009a grid:
- mni_icbm152_t1_brain.nii.gz        Brain-masked MNI T1 template (float32, gzipped)
- mni_lateralisation.nii.gz          uint8 (1=right, 2=left)
- mni_lobes.nii.gz                   uint8 MNI lobe labels + mni_lobes.json
- schaefer7_mni.nii.gz               uint8 Schaefer 7-network labels + schaefer7.json
- schaefer17_mni.nii.gz              uint8 Schaefer 17-network labels + schaefer17.json
- resect_left_mni.nii.gz             float32 Kommers GBM left resection probability map
- resect_right_mni.nii.gz            float32 Kommers GBM right resection probability map
- bcb_tracts.bin.gz                  Single packed binary file of all 68 BCB tracts
                                     thresholded at >= 0.5, stored as tight bounding
                                     boxes with a JSON header (replaces 68 HTTP fetches).
"""
import argparse
import csv
import gzip
import hashlib
import json
import struct
from pathlib import Path

import nibabel as nib
import numpy as np

EXPECTED_SHAPE = (197, 233, 189)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save_nifti(data: np.ndarray, affine: np.ndarray, out_path: Path, dtype) -> dict:
    arr = np.asarray(data, dtype=dtype)
    assert arr.shape == EXPECTED_SHAPE, f'{out_path.name}: unexpected shape {arr.shape}'
    img = nib.Nifti1Image(arr, affine)
    img.set_data_dtype(dtype)
    nib.save(img, out_path)
    return {'filename': out_path.name, 'bytes': out_path.stat().st_size, 'sha256': sha256(out_path)}


def parse_lobe_labels(csv_path: Path) -> list[dict]:
    entries = []
    with csv_path.open('r', encoding='utf-8') as f:
        for row in csv.DictReader(f):
            label_str = (row.get('Label') or '').strip()
            if not label_str:
                continue
            region = '-'.join((row.get('Region') or '').strip().split())
            lat = (row.get('Laterality') or '').strip()
            matter = (row.get('Matter type') or '').strip()
            name = f'{region}_{lat}' if lat and lat != 'None' else f'{region}_'
            entries.append({
                'label': int(label_str),
                'name': name,
                'region': (row.get('Region') or '').strip(),
                'laterality': None if (not lat or lat == 'None') else lat,
                'matter': matter or None,
            })
    return entries


def parse_simple_labels(csv_path: Path) -> list[dict]:
    entries = []
    with csv_path.open('r', encoding='utf-8') as f:
        for row in csv.DictReader(f):
            label_str = (row.get('Label') or '').strip()
            if not label_str:
                continue
            region = (row.get('Region') or '').strip()
            entries.append({
                'label': int(label_str),
                'name': '_'.join(region.split()),
                'region': region,
            })
    return entries


def pack_bcb_tracts(standalone_dir: Path, out_path: Path, cutoff: float = 0.5) -> dict:
    tract_files = sorted(standalone_dir.glob('*.nii.gz'))
    assert tract_files, f'No BCB tract files in {standalone_dir}'
    header_tracts = []
    payload_chunks = []
    offset = 0
    for path in tract_files:
        img = nib.load(path)
        data = img.get_fdata()
        assert data.shape == EXPECTED_SHAPE, f'{path.name}: unexpected shape {data.shape}'
        mask = data >= cutoff
        coords = np.argwhere(mask)
        if len(coords) == 0:
            continue
        lo = coords.min(axis=0).tolist()
        hi = (coords.max(axis=0) + 1).tolist()
        sub = mask[lo[0]:hi[0], lo[1]:hi[1], lo[2]:hi[2]]
        # Fortran order (x fastest, matching NIfTI linear indexing x + nx*(y + ny*z))
        flat = np.packbits(sub.ravel(order='F'), bitorder='little').tobytes()
        stem = path.name.replace('.nii.gz', '')
        clean_name = stem[:-4] if stem.endswith('_mni') else stem
        header_tracts.append({
            'id': stem,
            'name': clean_name,
            'bbox': [lo[0], lo[1], lo[2], hi[0], hi[1], hi[2]],
            'voxels': int(mask.sum()),
            'byteOffset': offset,
            'byteLength': len(flat),
        })
        payload_chunks.append(flat)
        offset += len(flat)

    meta = json.dumps({
        'format': 'bcb-tracts-bitpack-v1',
        'dims': list(EXPECTED_SHAPE),
        'cutoff': cutoff,
        'tracts': header_tracts,
    }, separators=(',', ':')).encode('utf-8')
    blob = struct.pack('<I', len(meta)) + meta + b''.join(payload_chunks)
    with gzip.GzipFile(filename=out_path, mode='wb', compresslevel=9, mtime=0) as gz:
        gz.write(blob)
    return {
        'filename': out_path.name,
        'bytes': out_path.stat().st_size,
        'sha256': sha256(out_path),
        'tract_count': len(header_tracts),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('atlases_dir', type=Path)
    parser.add_argument('output_dir', type=Path)
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)

    mni_dir = args.atlases_dir / 'mni_icbm152_nlin_sym_09a'
    t1_img = nib.load(mni_dir / 'mni_icbm152_t1_tal_nlin_sym_09a.nii')
    mask_img = nib.load(mni_dir / 'mni_icbm152_t1_tal_nlin_sym_09a_mask.nii')
    affine = t1_img.affine
    brain_t1 = t1_img.get_fdata().astype(np.float32) * (mask_img.get_fdata() > 0.5)

    summary = []
    summary.append({'id': 'mni-icbm152-t1-brain', **save_nifti(brain_t1, affine, args.output_dir / 'mni_icbm152_t1_brain.nii.gz', np.float32)})
    summary.append({'id': 'mni-lateralisation', **save_nifti(nib.load(mni_dir / 'extended_lateralisation_mask.nii.gz').get_fdata(), affine, args.output_dir / 'mni_lateralisation.nii.gz', np.uint8)})
    summary.append({'id': 'mni-lobes', **save_nifti(nib.load(mni_dir / 'reduced_lobes_brain.nii.gz').get_fdata(), affine, args.output_dir / 'mni_lobes.nii.gz', np.uint8)})
    (args.output_dir / 'mni_lobes.json').write_text(json.dumps(parse_lobe_labels(mni_dir / 'lobe_labels_description.csv'), indent=2) + '\n')

    schaefer_dir = args.atlases_dir / 'Schaefer400'
    summary.append({'id': 'schaefer7', **save_nifti(nib.load(schaefer_dir / 'schaefer7MNI_mni.nii.gz').get_fdata(), affine, args.output_dir / 'schaefer7_mni.nii.gz', np.uint8)})
    summary.append({'id': 'schaefer17', **save_nifti(nib.load(schaefer_dir / 'schaefer17MNI_mni.nii.gz').get_fdata(), affine, args.output_dir / 'schaefer17_mni.nii.gz', np.uint8)})
    (args.output_dir / 'schaefer7.json').write_text(json.dumps(parse_simple_labels(schaefer_dir / '7regions_description.csv'), indent=2) + '\n')
    (args.output_dir / 'schaefer17.json').write_text(json.dumps(parse_simple_labels(schaefer_dir / '17regions_description.csv'), indent=2) + '\n')

    resect_dir = args.atlases_dir / 'resectability_maps'
    resect_l = np.nan_to_num(nib.load(resect_dir / 'Resection_probability_map_left_mni.nii.gz').get_fdata(), nan=0.0, posinf=0.0, neginf=0.0)
    resect_r = np.nan_to_num(nib.load(resect_dir / 'Resection_probability_map_right_mni.nii.gz').get_fdata(), nan=0.0, posinf=0.0, neginf=0.0)
    summary.append({'id': 'resect-left', **save_nifti(resect_l, affine, args.output_dir / 'resect_left_mni.nii.gz', np.float32)})
    summary.append({'id': 'resect-right', **save_nifti(resect_r, affine, args.output_dir / 'resect_right_mni.nii.gz', np.float32)})

    summary.append({'id': 'bcb-tracts', **pack_bcb_tracts(args.atlases_dir / 'bcb_tracts' / 'StandAlone', args.output_dir / 'bcb_tracts.bin.gz')})
    print(json.dumps(summary, indent=2))


if __name__ == '__main__':
    main()
