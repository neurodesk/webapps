"""End-to-end MP2RAGE T1 mapping pipeline (SA2RAGE or generic B1 map)."""
from __future__ import annotations
import json
import os
import tempfile

import numpy as np
import nibabel as nib
from scipy.ndimage import (map_coordinates, gaussian_filter,
                           binary_fill_holes, binary_closing)

from . import dicom_io as dio
from . import model as mp
from . import denoise as dn


# ---------------------------------------------------------------------------
# small image helpers
# ---------------------------------------------------------------------------
def _load(niis):
    """Load a converted series (one 4D file, or several 3D files stacked)."""
    if len(niis) == 1:
        return nib.load(niis[0])
    vols = [nib.load(n) for n in niis]
    data = np.stack([v.get_fdata() for v in vols], axis=-1)
    return nib.Nifti1Image(data, vols[0].affine, vols[0].header)


def _load_any(path, workdir, tag):
    """Load a B1 map given as a DICOM folder or a NIfTI file (no sidecar needed)."""
    if os.path.isdir(path):
        return _load(dio.to_nifti(path, workdir, tag))
    if path.lower().endswith(('.nii', '.nii.gz')):
        return nib.load(path)
    raise SystemExit(f"--b1-map '{path}' is neither a DICOM folder nor a .nii/.nii.gz file.")


def _b1_to_relative(vol, kind, ref_angle):
    """Convert a stored B1-map volume to relative B1 (1.0 = nominal)."""
    vol = np.asarray(vol, dtype=float)
    if vol.ndim == 4:
        vol = vol[..., 0]
    if kind == 'tfl':          # Siemens tfl FLIP ANGLE MAP: value = achieved flip x10
        return vol / 10.0 / float(ref_angle)
    if kind == 'percent':      # value = percent of nominal (100 = nominal)
        return vol / 100.0
    if kind == 'relative':     # value already relative (1.0 = nominal)
        return vol
    raise SystemExit(f"unknown --b1-map-type '{kind}'")


def resample_to(src_img, tgt_img, order=1, cval=np.nan):
    src = np.asarray(src_img.get_fdata(), dtype=np.float32)
    A = (np.linalg.inv(src_img.affine) @ tgt_img.affine).astype(np.float32)
    ts = tgt_img.shape[:3]
    ii, jj, kk = np.meshgrid(np.arange(ts[0], dtype=np.float32),
                             np.arange(ts[1], dtype=np.float32),
                             np.arange(ts[2], dtype=np.float32), indexing='ij')
    x = A[0, 0]*ii + A[0, 1]*jj + A[0, 2]*kk + A[0, 3]
    y = A[1, 0]*ii + A[1, 1]*jj + A[1, 2]*kk + A[1, 3]
    z = A[2, 0]*ii + A[2, 1]*jj + A[2, 2]*kk + A[2, 3]
    out = map_coordinates(src, np.stack([x.ravel(), y.ravel(), z.ravel()]),
                          order=order, mode='constant', cval=cval)
    return out.reshape(ts)


def brain_mask(vol, frac=0.12):
    m = vol > frac * np.percentile(vol, 99.5)
    m = binary_closing(m, iterations=2)
    m = binary_fill_holes(m)
    return m


def _savenii(data, ref_img, path, dtype=np.float32):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img = nib.Nifti1Image(np.asarray(data, dtype=dtype), ref_img.affine, ref_img.header)
    img.header.set_data_dtype(dtype)
    nib.save(img, path)


def _load_series(rec, workdir, tag):
    """Load a series as a nibabel image (DICOM -> dcm2niix; NIfTI -> direct)."""
    if rec['kind'] == 'nifti':
        return nib.load(rec['path'])
    return _load(dio.to_nifti(rec['path'], workdir, tag))


# ---------------------------------------------------------------------------
# main entry
# ---------------------------------------------------------------------------
def run(inputs, output, *, trflash_ms=7.0, inv_eff=0.96,
        sa2rage_tr=None, sa2rage_td1=None, sa2rage_td2=None,
        sa2rage_fa=None, sa2rage_nz=None, sa2rage_avgt1=None, b0=None,
        mp2rage_slices=None, mp2rage_tis=None, mp2rage_fa=None,
        b1_map=None, b1_map_type='tfl', b1_ref_angle=80.0,
        subject=None, keep_uncorrected=True, fallback_uncorrected=False,
        denoise_uni=False, extend_fov=False,
        qc=False, work_dir=None, log=print):

    # ---- 1. discover series ------------------------------------------------
    infos = dio.survey(inputs)
    if any(r['kind'] == 'dicom' for r in infos) and not dio.have_dcm2niix():
        raise SystemExit("dcm2niix not found on PATH (required for DICOM inputs).")
    by = {}
    for i in infos:
        by.setdefault(i['klass'], i)
        log(f"  {os.path.basename(i['path'].rstrip('/')):40s} -> {i['klass']:10s} "
            f"[{i['kind']}] (TI={i['ti']*1000:.0f}ms)")
    if 'uni' not in by:
        raise SystemExit("No UNI series found (need the MP2RAGE UNI / UNI-DEN image).")

    # ---- choose the B1 source: --b1-map > SA2RAGE > auto tfl flip-angle map -
    if b1_map:
        b1_mode = 'b1map'
    elif 'sa2rage' in by:
        b1_mode = 'sa2rage'
    elif 'tfl_famap' in by:
        b1_mode = 'b1map'
    else:
        raise SystemExit(
            "No B1 source found. Provide a SA2RAGE series, or a Siemens B1 map "
            "via --b1-map (or include a tfl FLIP-ANGLE MAP in -i). Without a B1 "
            "map only the uncorrected T1 can be computed.")
    log(f"  B1 source: {'SA2RAGE' if b1_mode == 'sa2rage' else 'B1 map'}")
    if extend_fov and b1_mode == 'sa2rage':
        log("  (--b1-extend-fov ignored: it applies to the B1-map source only)")

    sub = subject or dio.subject_label(by['uni'])
    log(f"  subject label: {sub}")
    workdir = work_dir or tempfile.mkdtemp(prefix='mp2rage_')

    # ---- 2. UNI + MP2RAGE parameters --------------------------------------
    uni_img = _load_series(by['uni'], workdir, 'uni')
    uni = uni_img.get_fdata()
    B0 = dio.detect_b0(by, b0)
    log(f"  field strength: {B0:.1f} T ({'override' if b0 else 'header'})")
    MP = dio.build_mp2rage_params(by, uni_img, trflash_ms / 1000.0, inv_eff, b0=B0,
                                  slices=mp2rage_slices, tis=mp2rage_tis, fa=mp2rage_fa)
    log(f"  MP2RAGE: TR={MP['TR']}s TIs={MP['TIs']} FA={MP['FlipDegrees']} "
        f"NZ={MP['NZslices']} TRFLASH={MP['TRFLASH']*1e3:.2f}ms (supplied)")

    # ---- 3. brain mask -----------------------------------------------------
    if 'inv2' in by:
        inv2 = _load_series(by['inv2'], workdir, 'inv2').get_fdata()
        mask = brain_mask(inv2)
    else:
        log("  (no INV2 supplied -> deriving mask from UNI; ventricles may be filled)")
        mask = brain_mask(np.abs(uni - np.median(uni)))

    # ---- 3b. optional UNI background denoising (O'Brien robust combination) -
    uni_den = None
    if denoise_uni:
        if 'inv1' not in by or 'inv2' not in by:
            raise SystemExit(
                "--denoise-uni needs both INV1 and INV2 series (the robust "
                "combination denoises UNI from the two inversion magnitudes).")
        inv1 = _load_series(by['inv1'], workdir, 'inv1').get_fdata()
        uni_den = dn.robust_combination(uni, inv1, inv2)   # inv2 loaded for the mask
        log("  UNI denoised (O'Brien robust combination, mf=6)")

    # ---- 4. uncorrected T1 -------------------------------------------------
    T1u = mp.t1_from_uni(uni, MP['TR'], MP['TIs'], MP['FlipDegrees'],
                         MP['NZslices'], MP['TRFLASH'], inv_eff) * 1000.0
    T1u[~mask] = 0

    # outputs that only exist in one mode
    SA = None            # SA2RAGE parameters (SA2RAGE mode)
    B1c = None           # iteratively refined B1 (SA2RAGE mode)
    B1_tfl = None        # tfl cross-check (SA2RAGE mode, if a tfl map is present)
    b1_prov = None       # B1-map provenance (B1-map mode)

    if b1_mode == 'sa2rage':
        # ---- 5. SA2RAGE ratio -> relative B1 ------------------------------
        sa_img = _load_series(by['sa2rage'], workdir, 'sa2rage')
        sa = sa_img.get_fdata()
        if sa.ndim != 4 or sa.shape[-1] < 2:
            raise SystemExit("SA2RAGE series is not the expected 2-volume (S1,S2) image.")
        S_a, S_b = sa[..., 0], sa[..., 1]

        avgt1 = sa2rage_avgt1 if sa2rage_avgt1 is not None else (1.2 if B0 < 5 else 1.5)
        SA = dio.build_sa2rage_params(by, sa_img, tr=sa2rage_tr, td1=sa2rage_td1,
                                      td2=sa2rage_td2, fa=sa2rage_fa, nz=sa2rage_nz,
                                      average_t1=avgt1)
        log(f"  SA2RAGE: TR={SA['TR']}s TIs={SA['TIs']} FA={SA['FlipDegrees']} "
            f"NZ={SA['NZslices']} TRFLASH={SA['TRFLASH']*1e3:.2f}ms averageT1={avgt1}s")

        B1v, Iv = mp.sa2rage_lookuptable(SA['TR'], SA['TIs'], SA['FlipDegrees'],
                                         SA['NZslices'], SA['TRFLASH'], SA['averageT1'])
        order = np.argsort(Iv)
        Iv_s, B1v_s = Iv[order], B1v[order]

        def ratio_to_b1(num, den):
            with np.errstate(divide='ignore', invalid='ignore'):
                r = num / den
            return r, np.interp(r, Iv_s, B1v_s, left=np.nan, right=np.nan)

        sa_mask = S_b > 0.15 * np.percentile(S_b[S_b > 0], 99)
        cand = {}
        for tag, (n, d) in {'ab': (S_a, S_b), 'ba': (S_b, S_a)}.items():
            _, b1 = ratio_to_b1(n, d)
            cand[tag] = (np.nanmedian(b1[sa_mask]), (n, d))
        best = min(cand, key=lambda k: abs(cand[k][0] - 1.0))
        n_, d_ = cand[best][1]
        ratio_low, b1_low = ratio_to_b1(n_, d_)
        log(f"  SA2RAGE S1/S2 order '{best}', brain B1 median={cand[best][0]:.3f}")

        b1_low_f = np.where(np.isfinite(b1_low), b1_low, np.nanmedian(b1_low[sa_mask]))
        b1_low_f = gaussian_filter(b1_low_f, 1.0)
        B1_out = resample_to(nib.Nifti1Image(b1_low_f.astype(np.float32), sa_img.affine),
                             uni_img, order=1)
        B1_out[~mask] = np.nan

        # ---- 6. B1-corrected T1 (iterative SA2RAGE correction) ------------
        ratio_f = np.where(np.isfinite(ratio_low), ratio_low, np.nanmedian(ratio_low[sa_mask]))
        ratio_f = gaussian_filter(ratio_f, 1.0)
        ratio_mp = resample_to(nib.Nifti1Image(ratio_f.astype(np.float32), sa_img.affine),
                               uni_img, order=1)
        ratio_mp[~mask] = 0

        res = mp.t1b1_correct(uni, ratio_mp, MP, SA, brain=mask.astype(float),
                              inversion_efficiency=inv_eff, n_iter=3)
        T1c, B1c, UNIc = res['T1'], res['B1'], res['MP2RAGEcorr']
        noncoverged = (B1c >= 1.9) | (B1c <= 0.05) | np.isclose(T1c, 4000.0, atol=2.0)

        # ---- 7. optional tfl B1 cross-check -------------------------------
        if 'tfl_famap' in by:
            tfl_img = _load_series(by['tfl_famap'], workdir, 'tfl')
            rel = tfl_img.get_fdata() / 10.0 / 80.0
            B1_tfl = resample_to(nib.Nifti1Image(gaussian_filter(rel.astype(np.float32), 1.0),
                                                 tfl_img.affine), uni_img, order=1)
            B1_tfl[~mask] = np.nan
            both = mask & np.isfinite(B1_out) & np.isfinite(B1_tfl) & (B1_out > 0.2) & (B1_tfl > 0.2)
            if both.sum() > 1000:
                r = float(np.corrcoef(B1_out[both], B1_tfl[both])[0, 1])
                log(f"  SA2RAGE vs tfl B1 spatial correlation r={r:.3f}")

    else:  # ---- B1-map mode (generic Siemens B1 map; e.g. 3T tfl b1map) ----
        if b1_map:
            b1_img = _load_any(b1_map, workdir, 'b1map')
            b1_src = os.path.abspath(b1_map)
        else:                                   # auto-detected tfl flip-angle map
            rec = by['tfl_famap']
            b1_img = _load_series(rec, workdir, 'b1map')
            b1_src = os.path.abspath(rec['path'])
        rel = _b1_to_relative(b1_img.get_fdata(), b1_map_type, b1_ref_angle)
        log(f"  B1 map: {os.path.basename(b1_src)}  type={b1_map_type}"
            + (f" ref={b1_ref_angle:g}deg" if b1_map_type == 'tfl' else ""))

        finite = np.isfinite(rel)
        med = float(np.nanmedian(rel[finite])) if finite.any() else 1.0
        rel_f = gaussian_filter(np.where(finite, rel, med).astype(np.float32), 1.0)
        B1_grid = resample_to(nib.Nifti1Image(rel_f, b1_img.affine), uni_img, order=1)
        if extend_fov:
            # fill brain voxels outside the measured B1-map FOV (NaN after the
            # resample) with a smooth degree-3 polynomial rather than B1=0
            n_out = int((mask & ~np.isfinite(B1_grid)).sum())
            B1_grid = dn.extend_b1_fov(B1_grid, mask)
            log(f"  B1 FOV extension: filled {n_out} out-of-FOV brain voxels "
                f"with a degree-3 polynomial")
        B1_out = B1_grid.copy()
        B1_out[~mask] = np.nan
        mm = mask & np.isfinite(B1_grid) & (B1_grid > 0.1)
        if mm.sum() > 100:
            log(f"  relative B1 in brain: median={np.nanmedian(B1_grid[mm]):.3f} "
                f"p5={np.nanpercentile(B1_grid[mm], 5):.3f} "
                f"p95={np.nanpercentile(B1_grid[mm], 95):.3f}")

        res = mp.t1b1_correct_with_b1map(uni, np.nan_to_num(B1_grid, nan=0.0), MP,
                                         brain=mask.astype(float),
                                         inversion_efficiency=inv_eff)
        T1c, UNIc = res['T1'], res['MP2RAGEcorr']
        noncoverged = np.isclose(T1c, 4000.0, atol=2.0)
        b1_prov = dict(source=b1_src, type=b1_map_type,
                       ref_angle_deg=(b1_ref_angle if b1_map_type == 'tfl' else None))

    # ---- 8. non-converged voxels (mostly CSF/vessels) ---------------------
    if fallback_uncorrected:
        fill = mask & noncoverged
        T1c[fill] = T1u[fill]
        if B1c is not None:
            B1c[fill] = np.nan_to_num(B1_out, nan=0.0)[fill]
        log(f"  fallback: filled {int(fill.sum())} non-converged voxels with uncorrected T1")
    else:
        T1c[noncoverged] = 0
        if B1c is not None:
            B1c[noncoverged] = 0
    T1c[~mask] = 0
    if B1c is not None:
        B1c[~mask] = 0

    # ---- 9. write outputs --------------------------------------------------
    t1dir = os.path.join(output, 't1map')
    b1dir = os.path.join(output, 'b1map')
    t1sub = os.path.join(t1dir, 'derivative_files')
    b1sub = os.path.join(b1dir, 'derivative_files')

    _savenii(np.nan_to_num(T1c), uni_img, os.path.join(t1dir, f'{sub}_T1map.nii.gz'))
    _savenii(np.nan_to_num(B1_out), uni_img, os.path.join(b1dir, f'{sub}_B1map.nii.gz'))
    if uni_den is not None:
        _savenii(uni_den, uni_img, os.path.join(output, f'{sub}_UNI-DEN.nii.gz'))

    if keep_uncorrected:
        _savenii(T1u, uni_img, os.path.join(t1sub, f'{sub}_T1map_uncorrected.nii.gz'))
        _savenii(UNIc, uni_img, os.path.join(t1sub, f'{sub}_UNI_b1corrected.nii.gz'))
    if B1c is not None:
        _savenii(np.nan_to_num(B1c), uni_img, os.path.join(b1sub, f'{sub}_B1map_refined.nii.gz'))
    if B1_tfl is not None:
        _savenii(np.nan_to_num(B1_tfl), uni_img,
                 os.path.join(b1sub, f'{sub}_B1map_tfl_crosscheck.nii.gz'))

    prov = dict(
        subject=sub,
        b1_source=('SA2RAGE' if b1_mode == 'sa2rage' else 'B1 map'),
        inputs={i['klass']: os.path.abspath(i['path']) for i in infos},
        mp2rage={k: v for k, v in MP.items() if not k.startswith('_')},
        inversion_efficiency=inv_eff,
        trflash_supplied_ms=trflash_ms,
        notes=[
            "MP2RAGE TRFLASH (GRE readout TR) is not stored in DICOM; supplied via --trflash.",
        ],
    )
    if SA is not None:
        prov['sa2rage'] = SA
        prov['notes'].append(
            "SA2RAGE TR / 2nd delay / 2nd flip angle are protocol-card values not "
            "reliably in DICOM; header-derived defaults used unless overridden.")
    if b1_prov is not None:
        prov['b1_map'] = b1_prov
    with open(os.path.join(output, f'{sub}_parameters.json'), 'w') as f:
        json.dump(prov, f, indent=2, default=float)

    log(f"\n  T1 map : {os.path.join(t1dir, sub + '_T1map.nii.gz')}")
    log(f"  B1 map : {os.path.join(b1dir, sub + '_B1map.nii.gz')}")

    if qc:
        try:
            from . import qc as _qc
            _qc.make_qc(uni, T1u, T1c, B1_out, B1_tfl, mask,
                        os.path.join(output, 'qc', f'{sub}_qc.png'))
            log(f"  QC     : {os.path.join(output, 'qc', sub + '_qc.png')}")
        except Exception as e:            # QC is non-essential
            log(f"  (QC figure skipped: {e})")

    return dict(subject=sub, t1_corrected=T1c, b1=B1_out, mask=mask, params=prov)
