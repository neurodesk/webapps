"""mp2rage_t1 -- B1-corrected T1 mapping from MP2RAGE (3T / 7T).

B1 from a SA2RAGE scan or from a generic Siemens B1 map. A Python port of the
T1-mapping parts of J. P. Marques'
MP2RAGE-related-scripts (https://github.com/JosePMarques/MP2RAGE-related-scripts).
"""
from .model import (mprage_signal, mp2rage_lookuptable, t1_from_uni,
                    sa2rage_lookuptable, t1b1_correct, t1b1_correct_with_b1map)

__version__ = "0.1.0"
__all__ = ["mprage_signal", "mp2rage_lookuptable", "t1_from_uni",
           "sa2rage_lookuptable", "t1b1_correct", "t1b1_correct_with_b1map", "run"]


def run(*args, **kwargs):
    from .pipeline import run as _run
    return _run(*args, **kwargs)
