"""Command-line interface for the Easy-MP2RAGE-T1-Map pipeline."""
from __future__ import annotations
import argparse
import sys

from .pipeline import run


def build_parser():
    p = argparse.ArgumentParser(
        prog='easy-mp2rage-t1map',
        description="B1-corrected T1 mapping from MP2RAGE, at 3T and 7T. The B1 "
                    "source is either a SA2RAGE scan or a generic Siemens B1 map "
                    "(--b1-map, e.g. a tfl B1 map at 3T). Point at the DICOM folders "
                    "or dcm2niix NIfTIs in any order; series roles (INV1/INV2/UNI/"
                    "SA2RAGE/tfl-B1) and sequence timing are inferred from the headers.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter)

    p.add_argument('-i', '--inputs', nargs='+', required=True, metavar='INPUT',
                   help="DICOM series folders OR dcm2niix NIfTI files (.nii/.nii.gz "
                        "with their .json sidecars), in any order. Must include the "
                        "MP2RAGE UNI plus a B1 source (SA2RAGE, or a tfl FLIP-ANGLE "
                        "MAP, or supply one via --b1-map). INV1/INV2 are used if "
                        "present. (NIfTI mode needs INV1+INV2 to read the two "
                        "inversion times/flip angles unless --mp2rage-tis/-fa given.)")
    p.add_argument('-o', '--output', required=True, metavar='DIR',
                   help="Output directory (t1map/ and b1map/ are written inside).")
    p.add_argument('-s', '--subject', default=None,
                   help="Subject label for file names (default: from DICOM PatientID).")

    g = p.add_argument_group('MP2RAGE')
    g.add_argument('--trflash', type=float, default=7.0, metavar='MS',
                   help="MP2RAGE GRE readout TR (echo spacing) in ms. NOT stored in "
                        "DICOM; confirm from the protocol printout. +/-1 ms ~ +/-40 ms T1.")
    g.add_argument('--inv-eff', type=float, default=0.96,
                   help="Adiabatic inversion efficiency (valid at 3T and 7T).")
    g.add_argument('--b0', type=float, default=None, metavar='TESLA',
                   help="Field strength (default: auto-detect from header). Sets the "
                        "3T vs 7T default for the SA2RAGE average-T1.")
    g.add_argument('--mp2rage-tis', type=float, nargs=2, default=None, metavar=('TI1', 'TI2'),
                   help="MP2RAGE inversion times in s (NIfTI mode override; "
                        "default: read from INV1/INV2 headers).")
    g.add_argument('--mp2rage-fa', type=float, nargs=2, default=None, metavar=('A1', 'A2'),
                   help="MP2RAGE readout flip angles in deg (NIfTI mode override).")
    g.add_argument('--mp2rage-slices', type=int, default=None, metavar='N',
                   help="MP2RAGE slices-per-slab (override; default from header/geometry).")

    gb = p.add_argument_group('B1 source (generic B1 map; alternative to SA2RAGE)')
    gb.add_argument('--b1-map', default=None, metavar='PATH',
                    help="Use this Siemens B1 map (DICOM folder or NIfTI, no sidecar "
                         "needed) as the B1 source instead of SA2RAGE. For 3T MP2RAGE "
                         "acquired without a SA2RAGE scan. If omitted and no SA2RAGE is "
                         "present, a tfl FLIP-ANGLE MAP passed in -i is used automatically.")
    gb.add_argument('--b1-map-type', choices=['tfl', 'percent', 'relative'], default='tfl',
                    help="How the B1 map encodes B1. tfl: Siemens tfl FLIP-ANGLE MAP "
                         "(stored = achieved flip x10). percent: %% of nominal (100 = "
                         "nominal). relative: already relative (1.0 = nominal).")
    gb.add_argument('--b1-ref-angle', type=float, default=80.0, metavar='DEG',
                    help="Nominal prep flip angle for --b1-map-type tfl "
                         "(Siemens tfl b1map default 80).")
    gb.add_argument('--b1-extend-fov', action='store_true',
                    help="Fill brain voxels that fell outside the measured B1-map "
                         "FOV with a smooth degree-3 polynomial fit (clamped to "
                         "0.35..1.7) instead of leaving them uncorrected. B1-map "
                         "source only; ignored with SA2RAGE.")

    g2 = p.add_argument_group('SA2RAGE (defaults from header where possible)')
    g2.add_argument('--sa2rage-tr', type=float, default=None, metavar='S',
                    help="SA2RAGE outer TR in s (default 2.4).")
    g2.add_argument('--sa2rage-td1', type=float, default=None, metavar='S',
                    help="SA2RAGE 1st delay in s (default: alTI[0] from header).")
    g2.add_argument('--sa2rage-td2', type=float, default=None, metavar='S',
                    help="SA2RAGE 2nd delay in s (default 1.5).")
    g2.add_argument('--sa2rage-fa', type=float, nargs=2, default=None, metavar=('A1', 'A2'),
                    help="SA2RAGE two flip angles in deg (default: header FA for both).")
    g2.add_argument('--sa2rage-avgt1', type=float, default=None, metavar='S',
                    help="Average brain T1 assumed for the SA2RAGE B1 lookup "
                         "(default: 1.2 s at <=3T, 1.5 s at 7T).")

    g3 = p.add_argument_group('output')
    g3.add_argument('--denoise-uni', action='store_true',
                    help="Also write a background-denoised UNI (<sub>_UNI-DEN.nii.gz) "
                         "via the O'Brien robust combination. Needs INV1 and INV2.")
    g3.add_argument('--no-uncorrected', action='store_true',
                    help="Do not write the uncorrected T1 / corrected-UNI derivative files.")
    g3.add_argument('--fallback-uncorrected', action='store_true',
                    help="Where the B1 fit does not converge (mostly CSF/ventricles/"
                         "vessels), fill with the uncorrected T1 instead of leaving 0 "
                         "-> gap-free corrected map. Default: leave those voxels as 0.")
    g3.add_argument('--qc', action='store_true',
                    help="Write a QC montage PNG.")
    g3.add_argument('--work-dir', default=None,
                    help="Directory for intermediate NIfTI conversions "
                         "(default: system temp).")
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    run(args.inputs, args.output,
        trflash_ms=args.trflash, inv_eff=args.inv_eff,
        sa2rage_tr=args.sa2rage_tr, sa2rage_td1=args.sa2rage_td1,
        sa2rage_td2=args.sa2rage_td2, sa2rage_fa=args.sa2rage_fa,
        sa2rage_avgt1=args.sa2rage_avgt1, b0=args.b0,
        mp2rage_slices=args.mp2rage_slices, mp2rage_tis=args.mp2rage_tis,
        mp2rage_fa=args.mp2rage_fa,
        b1_map=args.b1_map, b1_map_type=args.b1_map_type,
        b1_ref_angle=args.b1_ref_angle,
        subject=args.subject, keep_uncorrected=not args.no_uncorrected,
        fallback_uncorrected=args.fallback_uncorrected,
        denoise_uni=args.denoise_uni, extend_fov=args.b1_extend_fov,
        qc=args.qc, work_dir=args.work_dir)
    return 0


if __name__ == '__main__':
    sys.exit(main())
