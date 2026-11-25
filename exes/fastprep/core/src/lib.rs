//! fastprep orchestration core: BIDS decisions, tool commands, reports. No processes, no voxels.
#![allow(clippy::cloned_ref_to_slice_refs)] // `&[out.clone()]` reads better than slice::from_ref at 40 call sites

pub mod bids;
pub mod host;
pub mod nifti;
pub mod pipeline;
pub mod py;
pub mod report;
pub mod run;
pub mod stages;

pub use neurodesk_pipeline_host::block_on;
