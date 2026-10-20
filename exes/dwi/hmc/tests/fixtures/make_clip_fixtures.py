"""Make clip.json, the interim oracle for `dwi_hmc::clip`, by running NiFreeze's own advanced_clip.

The fixture is committed, so `cargo test` needs no Python. Rerun only to remake it:

    python -m venv venv-nifreeze
    venv-nifreeze/bin/pip install \
        "nifreeze @ git+https://github.com/nipreps/nifreeze@3bcfb00df1e008b4dfeb59c0d63717c335ba0d1e" \
        scipy==1.18.1
    venv-nifreeze/bin/python make_clip_fixtures.py

Recorded with NiFreeze 3bcfb00df1e008b4dfeb59c0d63717c335ba0d1e, NumPy 2.3.5, SciPy 1.18.1,
scikit-image 0.26.0 and Python 3.12.3 (the script refuses other versions). The volumes are
synthetic and small; every float input is a multiple of 1/64, so it is exact in float32 and
float64 and its JSON text is short. Arrays are flattened in C order with `shape` slowest first.

Cases (each runs `advanced_clip` with its defaults, as `registration/ants.py:_to_nifti` does):

- `float64`: `inplace=True` twice on the same float64 array, as the trivial model's `bzero` is
  clipped on two registrations. `first` and `second` are the array after each call; the
  script checks the second call changes it. `copy_int16` is `inplace=False` on the input.
- `float32`: `inplace=True` on a float32 array (computed in float32).
- `int16`: `inplace=True` must leave the int16 array unchanged and return None;
  `copy_int16` is `inplace=False`, the float32 computation the in-place call throws away.
- `ties`: a float64 map whose clipped range is 0-510, so odd values scale to k + 0.5 and
  `np.round` rounds them half to even. The script checks at least one tie goes down.

`thresholds` are the two `np.percentile` results NiFreeze computed, recorded by wrapping
`np.percentile` (a_min, a_max) for each call, as `float()` of them.
"""

import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
COMMIT = "3bcfb00df1e008b4dfeb59c0d63717c335ba0d1e"
VERSIONS = {"numpy": "2.3.5", "scipy": "1.18.1", "skimage": "0.26.0"}


def versions():
    import importlib.metadata as md

    import scipy
    import skimage

    found = {"numpy": np.__version__, "scipy": scipy.__version__, "skimage": skimage.__version__}
    if found != VERSIONS:
        sys.exit(f"expected {VERSIONS}, found {found}")
    direct = json.loads(md.distribution("nifreeze").read_text("direct_url.json"))
    commit = direct["vcs_info"]["commit_id"]
    if commit != COMMIT:
        sys.exit(f"expected NiFreeze {COMMIT}, found {commit}")
    return {"nifreeze": commit, **found, "python": sys.version.split()[0]}


class Recorder:
    """Wraps np.percentile so each advanced_clip call's thresholds can be recorded."""

    def __init__(self):
        self.calls = []
        self.original = np.percentile

    def __enter__(self):
        def percentile(*args, **kwargs):
            result = self.original(*args, **kwargs)
            self.calls.append(float(result))
            return result

        np.percentile = percentile
        return self

    def __exit__(self, *exc):
        np.percentile = self.original

    def take(self):
        assert len(self.calls) == 2, self.calls
        out, self.calls = self.calls, []
        return out


def clip_in_place(data, recorder):
    from nifreeze.data.filtering import advanced_clip

    assert advanced_clip(data, inplace=True) is None
    return recorder.take()


def clip_copy(data, recorder):
    from nifreeze.data.filtering import advanced_clip

    out = advanced_clip(data)
    assert out.dtype == np.int16
    return out, recorder.take()


def as_ints(array):
    flat = array.ravel()
    assert np.array_equal(flat, np.round(flat)), "the map is integer-valued"
    return [int(v) for v in flat]


def as_floats(array):
    return [float(v) for v in array.ravel()]


def volume(rng, shape):
    """Smooth background, bright block, noise, negative voxels and a few hot outliers."""
    z, y, x = np.indices(shape)
    data = 200.0 + 40.0 * np.sin(x / 2.0) + 25.0 * y + rng.normal(0.0, 30.0, shape)
    data[: shape[0] // 3] -= 260.0  # partly negative slab
    data[tuple(rng.integers(0, s, 4) for s in shape)] = 5000.0
    return np.round(data * 64.0) / 64.0


def main():
    tools = versions()
    cases = {}
    with Recorder() as rec:
        # Seed 1 is one where the second clip changes the map (many seeds do not).
        shape = (10, 9, 4)
        source = volume(np.random.default_rng(1), shape)
        bzero = source.copy()
        first_thresholds = clip_in_place(bzero, rec)
        first = bzero.copy()
        second_thresholds = clip_in_place(bzero, rec)
        assert not np.array_equal(first, bzero), "the second clip must change the map"
        copy, copy_thresholds = clip_copy(source, rec)
        cases["float64"] = {
            "shape": shape,
            "input": as_floats(source),
            "first": as_ints(first),
            "first_thresholds": first_thresholds,
            "second": as_ints(bzero),
            "second_thresholds": second_thresholds,
            "copy_int16": as_ints(copy),
            "copy_thresholds": copy_thresholds,
        }

        shape = (5, 6, 7)
        source = volume(np.random.default_rng(2), shape).astype(np.float32)
        data = source.copy()
        thresholds = clip_in_place(data, rec)
        assert data.dtype == np.float32
        cases["float32"] = {
            "shape": shape,
            "input": as_floats(source),
            "first": as_ints(data),
            "first_thresholds": thresholds,
        }

        shape = (6, 7, 2)
        source = np.round(volume(np.random.default_rng(3), shape)).astype(np.int16)
        data = source.copy()
        thresholds = clip_in_place(data, rec)
        assert np.array_equal(data, source), "integer input is not written in place"
        copy, copy_thresholds = clip_copy(source, rec)
        assert copy_thresholds == thresholds
        cases["int16"] = {
            "shape": shape,
            "input": [int(v) for v in source.ravel()],
            "copy_int16": as_ints(copy),
            "copy_thresholds": copy_thresholds,
        }

        shape = (12, 6, 4)
        rng = np.random.default_rng(4)
        source = np.zeros(shape)
        source[9:] = 510.0
        source[6:9] = rng.integers(0, 256, (3,) + shape[1:]) * 2 + 1  # odd: 255 x / 510 = k + 0.5
        data = source.copy()
        thresholds = clip_in_place(data, rec)
        assert thresholds == [0.0, 510.0], thresholds
        exact = 255.0 * (source / 510.0)
        ties = exact == np.floor(exact) + 0.5
        assert (data[ties] < exact[ties]).any(), "a tie rounds down to even"
        cases["ties"] = {
            "shape": shape,
            "input": as_floats(source),
            "first": as_ints(data),
            "first_thresholds": thresholds,
        }

    for case in cases.values():
        case["shape"] = list(case["shape"])
    out = {"tools": tools, "cases": cases}
    with open(os.path.join(HERE, "clip.json"), "w") as f:
        json.dump(out, f, separators=(",", ":"))
        f.write("\n")


if __name__ == "__main__":
    main()
