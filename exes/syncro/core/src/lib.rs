//! SYNcro's pipeline, shared by the native command line (`cli`) and the web app (`wasm`): the core decides every
//! tool step and its argv; the host runs them (processes natively, worker drivers in the browser).

pub mod geometry;
pub mod pipeline;
pub mod volume;
