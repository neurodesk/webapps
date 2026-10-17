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

/// Drive a future whose host never suspends (the native host blocks inside each call).
pub fn block_on<F: std::future::Future>(f: F) -> F::Output {
    let mut f = std::pin::pin!(f);
    match f
        .as_mut()
        .poll(&mut std::task::Context::from_waker(std::task::Waker::noop()))
    {
        std::task::Poll::Ready(v) => v,
        std::task::Poll::Pending => panic!("host future suspended; use an async executor"),
    }
}
