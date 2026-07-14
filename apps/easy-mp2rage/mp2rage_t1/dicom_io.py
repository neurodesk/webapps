"""Input discovery, classification and metadata extraction.

Accepts **either** Siemens DICOM series folders **or** NIfTI files produced by
``dcm2niix`` (with their BIDS ``.json`` sidecars).  Series roles and sequence
timing are inferred from the headers so the user only has to point at the data.

DICOM folders carry the full Siemens ``ASCCONV`` private header (exact timing).
NIfTI inputs rely on the dcm2niix JSON sidecar, which retains the acquisition
parameters even after default anonymisation (``-ba y``): RepetitionTime,
InversionTime, FlipAngle, PartialFourier, ImageType, RepetitionTimeExcitation …
The few values that live only on the sequence "special card" (MP2RAGE readout
TR; SA2RAGE outer TR / 2nd delay / 2nd flip angle) are CLI options in both modes.
"""
from __future__ import annotations
import glob
import json
import os
import re
import shutil
import subprocess

import numpy as np
import pydicom

_PF = {1: 0.5, 2: 0.625, 4: 0.75, 8: 0.875, 16: 1.0}
_NIFTI_EXT = ('.nii', '.nii.gz')


# ---------------------------------------------------------------------------
# ASCCONV (Siemens MrPhoenixProtocol) parsing  --  DICOM only
# ---------------------------------------------------------------------------
def read_ascconv(ds) -> dict:
    raw = None
    for tag in [(0x0029, 0x1020), (0x0029, 0x1120), (0x0029, 0x1010), (0x0029, 0x1110)]:
        if tag in ds:
            try:
                txt = bytes(ds[tag].value).decode('latin-1', errors='ignore')
            except Exception:
                continue
            if 'ASCCONV BEGIN' in txt:
                raw = txt
                break
    if raw is None:
        return {}
    start = raw.find('ASCCONV BEGIN')
    end = raw.find('ASCCONV END')
    out = {}
    for line in raw[start:end if end > 0 else None].splitlines():
        if '=' not in line:
            continue
        key, _, val = line.partition('=')
        key = key.strip()
        if key and not key.startswith('###'):
            out[key] = _cast(val.strip())
    return out


def _cast(v: str):
    v = v.strip().strip('"')
    if v.startswith('0x'):
        try:
            return int(v, 16)
        except ValueError:
            return v
    for conv in (int, float):
        try:
            return conv(v)
        except ValueError:
            pass
    return v


# ---------------------------------------------------------------------------
# standardised metadata (works for both DICOM and NIfTI)
# ---------------------------------------------------------------------------
def _meta_from_dicom(ds) -> dict:
    def g(k, d=None):
        v = ds.get(k, d)
        return list(v) if hasattr(v, '__iter__') and not isinstance(v, str) else v
    return dict(
        ImageType=[str(x) for x in (ds.get('ImageType', []) or [])],
        SequenceName=str(ds.get('SequenceName', '')),
        SeriesDescription=str(ds.get('SeriesDescription', '')),
        ProtocolName=str(ds.get('ProtocolName', '')),
        PulseSequenceDetails='',
        ScanningSequence=g('ScanningSequence', ''),
        MRAcquisitionType=str(ds.get('MRAcquisitionType', '')),
        InversionTime=float(ds.get('InversionTime', 0) or 0) / 1000.0,   # ms -> s
        FlipAngle=float(ds.get('FlipAngle', 0) or 0),
        RepetitionTime=float(ds.get('RepetitionTime', 0) or 0) / 1000.0,
        RepetitionTimeExcitation=None,
        PartialFourier=None,
        ImageOrientationPatient=g('ImageOrientationPatient'),
        MagneticFieldStrength=float(ds.get('MagneticFieldStrength', 0) or 0),
        SeriesNumber=int(ds.get('SeriesNumber', 0) or 0),
        PatientID=str(ds.get('PatientID', '') or ds.get('PatientName', '')),
    )


def _meta_from_json(js: dict) -> dict:
    return dict(
        ImageType=[str(x) for x in js.get('ImageType', [])],
        SequenceName=str(js.get('SequenceName', '')),
        SeriesDescription=str(js.get('SeriesDescription', '')),
        ProtocolName=str(js.get('ProtocolName', '')),
        PulseSequenceDetails=str(js.get('PulseSequenceDetails', '')),
        ScanningSequence=js.get('ScanningSequence', ''),
        MRAcquisitionType=str(js.get('MRAcquisitionType', '')),
        InversionTime=float(js.get('InversionTime', 0) or 0),            # already s
        FlipAngle=float(js.get('FlipAngle', 0) or 0),
        RepetitionTime=float(js.get('RepetitionTime', 0) or 0),
        RepetitionTimeExcitation=js.get('RepetitionTimeExcitation'),
        PartialFourier=js.get('PartialFourier'),
        ImageOrientationPatient=js.get('ImageOrientationPatientDICOM'),
        MagneticFieldStrength=float(js.get('MagneticFieldStrength', 0) or 0),
        SeriesNumber=int(js.get('SeriesNumber', 0) or 0),
        PatientID=str(js.get('PatientID', '')),
    )


# ---------------------------------------------------------------------------
# input discovery
# ---------------------------------------------------------------------------
def _first_dicom(folder: str) -> str:
    files = []
    for p in ('*.IMA', '*.ima', '*.dcm', '*.DCM'):
        files += glob.glob(os.path.join(folder, p))
    if not files:
        files = [f for f in glob.glob(os.path.join(folder, '*')) if os.path.isfile(f)]
    for f in sorted(files):
        try:
            pydicom.dcmread(f, stop_before_pixels=True)
            return f
        except Exception:
            continue
    raise FileNotFoundError(f"No readable DICOM found in {folder}")


def _json_sidecar(nifti_path: str) -> dict:
    stem = nifti_path
    for ext in _NIFTI_EXT:
        if stem.endswith(ext):
            stem = stem[:-len(ext)]
            break
    jp = stem + '.json'
    if os.path.exists(jp):
        with open(jp) as f:
            return json.load(f)
    return {}


def classify(meta) -> str:
    itype = [str(x).upper() for x in meta['ImageType']]
    seqname = str(meta['SequenceName']).lower()
    desc = (str(meta['SeriesDescription']) + ' ' + str(meta['ProtocolName'])).lower()
    details = str(meta['PulseSequenceDetails']).lower()
    ss = meta['ScanningSequence']
    scanseq = '\\'.join(ss) if isinstance(ss, (list, tuple)) else str(ss)  # "GR\\IR"

    if 'FLIP ANGLE MAP' in itype:
        return 'tfl_famap'
    if 'sa2rage' in desc or 'sa2rage' in details:
        return 'sa2rage'
    if 'UNI' in itype:
        return 'uni'
    if seqname.startswith('tfl2d') or ('b1map' in desc and meta['MRAcquisitionType'] == '2D'):
        return 'tfl_mag'
    if 'IR' in scanseq and 'M' in itype:
        return 'mp2rage_inv'
    return 'unknown'


def survey(inputs):
    recs = []
    for path in inputs:
        if os.path.isdir(path):
            ds = pydicom.dcmread(_first_dicom(path), stop_before_pixels=True)
            meta, asc, kind = _meta_from_dicom(ds), read_ascconv(ds), 'dicom'
        elif path.lower().endswith(_NIFTI_EXT):
            js = _json_sidecar(path)
            if not js:
                raise SystemExit(
                    f"NIfTI input '{path}' has no .json sidecar; cannot read the "
                    f"acquisition metadata. Convert with `dcm2niix -b y`.")
            meta, asc, kind = _meta_from_json(js), {}, 'nifti'
        else:
            raise SystemExit(f"Input '{path}' is neither a DICOM folder nor a .nii/.nii.gz file.")
        recs.append(dict(path=path, kind=kind, meta=meta, asc=asc,
                         klass=classify(meta), ti=meta['InversionTime'],
                         fa=meta['FlipAngle'], series=meta['SeriesNumber'],
                         desc=meta['SeriesDescription']))
    invs = sorted([r for r in recs if r['klass'] == 'mp2rage_inv'], key=lambda x: x['ti'])
    for rank, r in enumerate(invs):
        r['klass'] = 'inv1' if rank == 0 else 'inv2'
    return recs


def subject_label(rec) -> str:
    pid = rec['meta'].get('PatientID', '')
    if pid:
        s = re.sub(r'[^A-Za-z0-9]+', '', str(pid))
        if s:
            return s
    stem = os.path.basename(rec['path'].rstrip('/'))
    for ext in _NIFTI_EXT:
        if stem.endswith(ext):
            stem = stem[:-len(ext)]
    s = re.sub(r'[^A-Za-z0-9]+', '', stem)
    return s or 'sub'


# ---------------------------------------------------------------------------
# geometry helper (NIfTI mode: number of partition/slice encodes)
# ---------------------------------------------------------------------------
def partition_count(shape, affine, iop):
    """Size of the image axis parallel to the slice(partition) normal."""
    if iop is None or len(iop) != 6:
        return None
    row = np.asarray(iop[:3], float)
    col = np.asarray(iop[3:], float)
    normal = np.cross(row, col)
    R = affine[:3, :3]
    cos = R / (np.linalg.norm(R, axis=0) + 1e-12)
    return int(shape[int(np.argmax(np.abs(normal @ cos)))])


def pf_fraction(code, default=1.0):
    try:
        return _PF.get(int(code), default)
    except (TypeError, ValueError):
        return default


# ---------------------------------------------------------------------------
# sequence parameter builders (prefer ASCCONV; fall back to JSON + geometry)
# ---------------------------------------------------------------------------
def detect_b0(by, override=None):
    """Field strength in Tesla: explicit override, else header, else 7."""
    if override:
        return float(override)
    for key in ('uni', 'inv2', 'inv1', 'sa2rage'):
        if key in by:
            b = by[key]['meta'].get('MagneticFieldStrength')
            if b:
                return float(b)
    return 7.0


def build_mp2rage_params(by, uni_img, trflash_s, inv_eff, b0=7.0,
                         slices=None, tis=None, fa=None):
    uni = by['uni']
    asc = uni['asc']
    if asc:                                   # DICOM: exact
        n_sl = slices or asc.get('sKSpace.lImagesPerSlab') or asc.get('sKSpace.lPartitions')
        pf = pf_fraction(asc.get('sKSpace.ucSlicePartialFourier'))
        acc3d = asc.get('sPat.lAccelFact3D', 1) or 1
        TR = asc['alTR[0]'] / 1e6
        TIs = tis or (asc['alTI[0]'] / 1e6, asc['alTI[1]'] / 1e6)
        FA = fa or (float(asc['adFlipAngleDegree[0]']), float(asc['adFlipAngleDegree[1]']))
        B0 = float(b0)
    else:                                     # NIfTI: JSON + geometry
        m = uni['meta']
        TR = m['RepetitionTime']
        if tis is None:
            if 'inv1' not in by or 'inv2' not in by:
                raise SystemExit(
                    "NIfTI mode needs the INV1 and INV2 images (with .json) to read the "
                    "two inversion times / flip angles, or pass --mp2rage-tis and "
                    "--mp2rage-fa explicitly.")
            TIs = (by['inv1']['meta']['InversionTime'], by['inv2']['meta']['InversionTime'])
        else:
            TIs = tis
        if fa is None:
            FA = (by['inv1']['meta']['FlipAngle'], by['inv2']['meta']['FlipAngle'])
        else:
            FA = fa
        pf = m.get('PartialFourier') or 1.0
        acc3d = 1
        n_sl = slices or partition_count(uni_img.shape[:3], uni_img.affine,
                                         m.get('ImageOrientationPatient'))
        if not n_sl:
            raise SystemExit("Could not infer MP2RAGE slices-per-slab; pass --mp2rage-slices.")
        B0 = float(b0)
    nz_bef = round(n_sl * (pf - 0.5) / acc3d)
    nz_aft = round(n_sl * 0.5 / acc3d)
    return dict(B0=float(B0), TR=float(TR), TIs=(float(TIs[0]), float(TIs[1])),
                FlipDegrees=(float(FA[0]), float(FA[1])),
                NZslices=(int(nz_bef), int(nz_aft)), TRFLASH=float(trflash_s),
                inv_eff=float(inv_eff), _pf=float(pf), _slices=int(n_sl))


def build_sa2rage_params(by, sa_img, tr=None, td1=None, td2=None, fa=None,
                         nz=None, slices=None, average_t1=1.5):
    sa = by['sa2rage']
    asc = sa['meta']
    if sa['asc']:
        trflash = sa['asc'].get('alTR[0]', 5000) / 1e6
        hdr_td1 = sa['asc'].get('alTI[0]', 150000) / 1e6
        hdr_fa = float(sa['asc'].get('adFlipAngleDegree[0]', 6.0))
        n_sl = slices or sa['asc'].get('sKSpace.lImagesPerSlab') \
            or sa['asc'].get('sKSpace.lPartitions') or 48
        pf = pf_fraction(sa['asc'].get('sKSpace.ucSlicePartialFourier'))
    else:
        m = sa['meta']
        trflash = m.get('RepetitionTimeExcitation') or 0.005
        hdr_td1 = 0.150
        hdr_fa = float(m.get('FlipAngle', 6.0) or 6.0)
        pf = m.get('PartialFourier') or 1.0
        n_sl = slices or partition_count(sa_img.shape[:3], sa_img.affine,
                                         m.get('ImageOrientationPatient')) or 48
    td1 = hdr_td1 if td1 is None else td1
    td2 = 1.5 if td2 is None else td2
    tr = 2.4 if tr is None else tr
    fa = (hdr_fa, hdr_fa) if fa is None else fa
    if nz is None:
        nz = (round(n_sl * (pf - 0.5)) or n_sl // 2, round(n_sl * 0.5))
    return dict(TR=float(tr), TRFLASH=float(trflash),
                TIs=(float(td1), float(td2)), FlipDegrees=(float(fa[0]), float(fa[1])),
                NZslices=(int(nz[0]), int(nz[1])), averageT1=float(average_t1))


# ---------------------------------------------------------------------------
# DICOM -> NIfTI conversion (via dcm2niix) -- only for DICOM inputs
# ---------------------------------------------------------------------------
def have_dcm2niix() -> bool:
    return shutil.which('dcm2niix') is not None


def to_nifti(folder: str, workdir: str, tag: str):
    out = os.path.join(workdir, tag)
    os.makedirs(out, exist_ok=True)
    subprocess.run(['dcm2niix', '-z', 'y', '-b', 'n', '-f', 'img', '-o', out, folder],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    niis = sorted(glob.glob(os.path.join(out, '*.nii.gz')))
    if not niis:
        raise RuntimeError(f"dcm2niix produced no output for {folder}")
    return niis
