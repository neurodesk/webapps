//! Recording gates for the optional Intel arithmetic implementation.
//! Production callers use an explicit arithmetic reference on each analysis.
pub use samsrf_core::arithmetic::intel::*;

#[cfg(target_arch = "wasm32")]
compile_error!("samsrf-mkl-avx512 is a validation crate; use samsrf-core for production");
