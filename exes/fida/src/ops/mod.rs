//! FID-A processingTools.
//!
//! Each function names the FID-A function it ports and takes the same
//! arguments (indices are 0-based where FID-A's are 1-based, except the
//! coil-combination `point`, which keeps FID-A's 1-based meaning). Where
//! FID-A would stop to ask the user something, the argument is required
//! instead; where it prints a warning and returns its input, so do these.

pub mod align;
pub mod averaging;
pub mod basic;
pub mod coils;
pub mod editing;
pub mod ecc;
pub mod linalg;
pub mod nlinfit;
pub mod pipeline;
pub mod quality;
pub mod subspecs;
pub mod util;
pub mod water;

pub use align::{op_align_averages, op_align_averages_fd, op_align_isis, op_align_mp_subspecs, op_freq_align_averages, AlignTo, Alignment};
pub use averaging::{op_averaging, op_median, op_rmbadaverages, op_rmworstaverage, op_takeaverages, Domain, RmBad};
pub use basic::{op_addphase, op_amp_scale, op_autophase, op_complex_conj, op_filter, op_freqrange, op_freqshift, op_leftshift, op_ppmref, op_timerange, op_zeropad};
pub use coils::{op_addrcvrs, op_alignrcvrs, op_combine_rcvrs, op_getcoilcombos, AddRcvrs, CoilCombos, CoilMode, CombineRcvrs};
pub use ecc::op_ecc;
pub use quality::{op_get_lw, op_get_snr, op_lorentz, Snr};
pub use subspecs::{op_combinesubspecs, op_four_step_combine, op_takesubspec, CombineMode};
pub use water::{op_hsvd_fit, op_remove_water, Hsvd, HsvdComponents};
