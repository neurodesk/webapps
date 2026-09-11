//! Slab parallelism. Every reduction is accumulated per z slab and merged in
//! slab order, so results do not depend on the thread count.
#[cfg(feature = "parallel")]
use rayon::prelude::*;

/// Applies `f` to every slab index and returns the results in order.
pub fn map_z<R: Send>(nz: usize, f: impl Fn(usize) -> R + Sync + Send) -> Vec<R> {
    #[cfg(feature = "parallel")]
    {
        (0..nz).into_par_iter().map(f).collect()
    }
    #[cfg(not(feature = "parallel"))]
    {
        (0..nz).map(f).collect()
    }
}

/// Splits `data` into `nz` equal slabs and applies `f(z, slab)` to each.
pub fn for_each_z<T: Send>(data: &mut [T], nz: usize, f: impl Fn(usize, &mut [T]) + Sync + Send) {
    let slab = data.len() / nz.max(1);
    if slab == 0 {
        return;
    }
    #[cfg(feature = "parallel")]
    {
        data.par_chunks_mut(slab)
            .enumerate()
            .for_each(|(z, chunk)| f(z, chunk));
    }
    #[cfg(not(feature = "parallel"))]
    {
        data.chunks_mut(slab)
            .enumerate()
            .for_each(|(z, chunk)| f(z, chunk));
    }
}

/// Limits the worker thread count; must run before any parallel work. A
/// no-op without the `parallel` feature.
pub fn set_threads(threads: usize) -> crate::Result<()> {
    #[cfg(feature = "parallel")]
    {
        rayon::ThreadPoolBuilder::new()
            .num_threads(threads)
            .build_global()
            .map_err(|e| crate::Error(format!("cannot set -threads: {e}")))
    }
    #[cfg(not(feature = "parallel"))]
    {
        let _ = threads;
        Ok(())
    }
}
