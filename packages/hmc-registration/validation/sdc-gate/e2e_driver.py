"""End-to-end SyN-SDC run on the 1.2 mm grid from the kept EPI reference (#462 precision test).

    python -I e2e_driver.py --zoom MM --epi-ref KEPT_EPI_REF SDC_DRIVER_PY <sdc_driver.py arguments>

This runs the pinned sdc/reference/scripts/sdc_driver.py unchanged, with --grid 2mm, as the
pinned grid-q68/scripts/sdc_driver_grid.py does: node `regrid_anat` gets zooms (MM, MM, MM).
One more change: sub-workflow `epi_reference_wf` is replaced by an identity node that gives
KEPT_EPI_REF, its output in the pinned runs (`epi_ref_file`, the file `clip_bg_noise` writes).
It depends only on the mean b0: the 12 full-brain runs of sdc/reference/ (0.8 mm and 2 mm grids,
float and double, every seed and prior) wrote the same bytes. That sub-workflow is the only user
of FreeSurfer's lta_convert. Every node from `deob_epi` and
`epi2anat` on runs as in the reference.
"""

import importlib.util
import json
import sys
from pathlib import Path


def main():
    argv = sys.argv[1:]
    if len(argv) < 5 or argv[0] != "--zoom" or argv[2] != "--epi-ref":
        sys.exit(__doc__)
    zoom = float(argv[1])
    epi_ref = str(Path(argv[3]).absolute())
    driver_path = Path(argv[4]).absolute()
    rest = argv[5:]
    if "--grid" not in rest or rest[rest.index("--grid") + 1] != "2mm":
        sys.exit("pass --grid 2mm: the debug path is the one that regrids the anat")

    from nipype.interfaces import utility as niu
    from nipype.pipeline import engine as pe
    from sdcflows.workflows.fit import syn

    original = syn.init_syn_preprocessing_wf

    def patched(*args, **kwargs):
        wf = original(*args, **kwargs)
        wf.get_node("regrid_anat").inputs.zooms = (zoom, zoom, zoom)
        epi_wf = wf.get_node("epi_reference_wf")
        deob = wf.get_node("deob_epi")
        wf.remove_nodes([epi_wf])
        kept = pe.Node(
            niu.IdentityInterface(fields=["epi_ref_file"]), name="epi_reference_kept"
        )
        kept.inputs.epi_ref_file = epi_ref
        wf.connect(kept, "epi_ref_file", deob, "in_file")
        return wf

    syn.init_syn_preprocessing_wf = patched

    workdir = Path(rest[rest.index("--workdir") + 1]).absolute()
    workdir.mkdir(parents=True, exist_ok=True)
    (workdir / "grid-record.json").write_text(
        json.dumps(
            {
                "zoom_mm": zoom,
                "epi_ref": epi_ref,
                "driver": str(driver_path),
                "driver_argv": rest,
            },
            indent=2,
        )
        + "\n"
    )
    spec = importlib.util.spec_from_file_location("sdc_driver", driver_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    sys.argv = [str(driver_path), *rest]
    mod.main()


if __name__ == "__main__":
    main()
