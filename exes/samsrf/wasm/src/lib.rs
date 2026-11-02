//! wasm-bindgen surface of samsrf-core. packages/samsrf/src wraps these exports;
//! see packages/samsrf/README.md for the JavaScript API.

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
