#!/usr/bin/env python3
"""Write LCModel .BASIS files from FID-A simulations.

    python3 make_basis.py <simulation dir> <output dir> [set id ...]

<simulation dir>/<set id>/<metabolite>.{json,bin} are FID-A structures
exported by simulate_library.m and simulate_mega.m (via
fida/validation/export_fida.m). For each
set in library.json (or each set named) this writes <output dir>/<set id>.basis.

Conventions, taken from LCModel.f (MYBASI) and FID-A (io_writelcm):
* LCModel's time-domain data are the complex conjugate of FID-A's `fids`,
  so each simulated FID is conjugated first, as io_writelcm does for .RAW.
* A basis spectrum is LCModel's CFFT of that FID: the forward transform
  (exp(-i 2 pi j k / N)) divided by sqrt(N), in natural (unshifted) order.
  MYBASI inverts it with CFFTIN.
* FID-A simulates with 0 Hz at 4.65 ppm, LCModel's default PPMCEN.
* Amplitudes are FID-A's proton-weighted signals, so concentrations are in
  consistent units; LCModel's water scaling normalises by the basis Cr
  3.027 ppm singlet (WSMET/N1HMET), not by the absolute basis amplitude.
"""
import json
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent


def load(stem):
    header = json.loads(Path(f"{stem}.json").read_text())
    raw = np.fromfile(f"{stem}.bin", dtype="<f8")
    fid = raw[0::2] + 1j * raw[1::2]
    return header, fid


def fortran_e13_5(x):
    s = f"{x:.5E}"
    mant, exp = s.split("E")
    e = int(exp)
    s = f"{mant}E{'-' if e < 0 else '+'}{abs(e):02d}"
    if len(s) > 13:
        raise ValueError(f"{x} does not fit E13.5")
    return s.rjust(13)


def write_basis(set_def, metabolites, sim_dir, out_path):
    lines = []
    first = None
    spectra = []
    for name in metabolites:
        header, fid = load(sim_dir / set_def["id"] / name)
        if first is None:
            first = header
        n = fid.size
        spec = np.fft.fft(np.conj(fid)) / np.sqrt(n)
        spectra.append((name, spec))
    hzpppm = first["txfrq"] / 1e6
    n = spectra[0][1].size
    fwhmba = set_def["linewidth_Hz"] / hzpppm
    seq = set_def["sequence"]
    lines.append(" $SEQPAR")
    lines.append(f" FWHMBA = {fwhmba:.6f},")
    lines.append(f" HZPPPM = {hzpppm:.6f},")
    lines.append(f" ECHOT = {set_def['te_ms']:.2f},")
    lines.append(f" SEQ = '{seq}' $END")
    lines.append(" $BASIS1")
    edit = f" {set_def['edit']}" if set_def.get("edit") else ""
    lines.append(f" IDBASI = 'FID-A {set_def['id']}{edit}',")
    lines.append(" FMTBAS = '(6E13.5)',")
    lines.append(f" BADELT = {first['dwelltime']:.8e},")
    lines.append(f" NDATAB = {n} $END")
    for name, spec in spectra:
        lines.append(" $BASIS")
        lines.append(f" ID = '{name}',")
        lines.append(f" METABO = '{name}',")
        lines.append(" CONC = 1.,")
        lines.append(" TRAMP = 1.,")
        lines.append(" VOLUME = 1.,")
        lines.append(" ISHIFT = 0 $END")
        flat = np.empty(2 * n)
        flat[0::2] = spec.real
        flat[1::2] = spec.imag
        for k in range(0, flat.size, 6):
            lines.append("".join(fortran_e13_5(v) for v in flat[k:k + 6]))
    out_path.write_text("\n".join(lines) + "\n")


def main():
    sim_dir = Path(sys.argv[1])
    out_dir = Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)
    only = set(sys.argv[3:])
    lib = json.loads((HERE / "library.json").read_text())
    for set_def in lib["sets"] + lib.get("mega", []):
        if only and set_def["id"] not in only:
            continue
        out = out_dir / f"{set_def['id']}.basis"
        write_basis(set_def, set_def.get("metabolites", lib["metabolites"]), sim_dir, out)
        print(out, out.stat().st_size)


if __name__ == "__main__":
    main()
