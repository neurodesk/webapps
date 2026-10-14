// SynthSeg pre/post-processing for the browser: the native CLI's modules compiled to wasm32, so the
// browser result is bit-identical to `exes/synthseg`. No wasm-bindgen; ../src/wasm.js drives this
// C ABI over the exported `memory`. Inference itself happens in JS (WebGPU / onnxruntime).
#[path = "../../../../exes/synthseg/src/nifti.rs"]
mod nifti;
#[path = "../../../../exes/synthseg/src/post.rs"]
mod post;
#[path = "../../../../exes/synthseg/src/volume.rs"]
mod volume;

use std::cell::RefCell;
use std::io::Write;

thread_local!(static ERROR: RefCell<String> = const { RefCell::new(String::new()) });

pub struct Segmenter {
    prep: volume::Prepared,
    padded: [u32; 3],
    input_dims: [u32; 3],
    output_dims: [u32; 3],
    flipped: Vec<f32>,
    scratch: Vec<f32>,
    posteriors: Vec<f32>,
    output: Vec<u8>,
    volumes: [f64; post::N],
}

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut bytes = Vec::<u8>::with_capacity(len);
    let ptr = bytes.as_mut_ptr();
    std::mem::forget(bytes);
    ptr
}

/// # Safety
/// `ptr`/`len` must come from a matching `alloc`.
#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, 0, len));
}

#[no_mangle]
pub extern "C" fn seg_error_ptr() -> *const u8 {
    ERROR.with(|e| e.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn seg_error_len() -> u32 {
    ERROR.with(|e| e.borrow().len() as u32)
}

/// # Safety
/// `ptr`/`len` must describe a readable NIfTI byte range.
#[no_mangle]
pub unsafe extern "C" fn seg_new(ptr: *const u8, len: usize, ct: u32) -> *mut Segmenter {
    seg_new_at_resolution(ptr, len, ct, 1.0)
}

/// # Safety
/// `ptr`/`len` must describe a readable NIfTI byte range.
#[no_mangle]
pub unsafe extern "C" fn seg_new_at_resolution(
    ptr: *const u8,
    len: usize,
    ct: u32,
    voxel_size_mm: f64,
) -> *mut Segmenter {
    let read = nifti::read(std::slice::from_raw_parts(ptr, len));
    match read.and_then(|v| {
        let prep = if voxel_size_mm == 1.0 {
            volume::prepare(&v, ct != 0)
        } else {
            volume::prepare_at_resolution(&v, ct != 0, voxel_size_mm)
        };
        prep.map(|p| (v.dims, p))
    }) {
        Ok((dims, prep)) => Box::into_raw(Box::new(Segmenter {
            padded: prep.padded.map(|d| d as u32),
            input_dims: dims.map(|d| d as u32),
            output_dims: prep.dims.map(|d| d as u32),
            prep,
            flipped: Vec::new(),
            scratch: Vec::new(),
            posteriors: Vec::new(),
            output: Vec::new(),
            volumes: [0.0; post::N],
        })),
        Err(message) => {
            ERROR.with(|e| *e.borrow_mut() = message);
            std::ptr::null_mut()
        }
    }
}

macro_rules! accessors {
    ($($name:ident($s:ident) -> $ty:ty $body:block)*) => {$(
        /// # Safety
        /// `seg` must be a live pointer from `seg_new`.
        #[no_mangle]
        pub unsafe extern "C" fn $name(seg: *mut Segmenter) -> $ty {
            let $s = &mut *seg;
            $body
        }
    )*};
}

accessors! {
    seg_padded(s) -> *const u32 { s.padded.as_ptr() }
    seg_input_dims(s) -> *const u32 { s.input_dims.as_ptr() }
    seg_output_dims(s) -> *const u32 { s.output_dims.as_ptr() }
    seg_affine(s) -> *const f64 { s.prep.affine[0].as_ptr() }
    seg_input(s) -> *const f32 { s.prep.input.as_ptr() }
    seg_labels_len(s) -> u32 { s.output.len() as u32 }
    // mri_synthseg --vol columns after `seg_labels`: total intracranial, then LABELS[1..], in mm³.
    seg_volumes(s) -> *const f64 { s.volumes.as_ptr() }
    seg_flipped_input(s) -> *const f32 {
        if s.flipped.is_empty() {
            s.flipped = volume::flip_x(&s.prep.input, &s.prep.padded);
        }
        s.flipped.as_ptr()
    }
    seg_scratch(s) -> *mut f32 {
        if s.scratch.is_empty() {
            s.scratch = vec![0f32; post::N * nifti::product(&s.prep.padded)];
        }
        s.scratch.as_mut_ptr()
    }
}

/// Blur the posteriors JS copied into the scratch buffer, then keep or average them.
///
/// # Safety
/// `seg` must be a live pointer from `seg_new`.
#[no_mangle]
pub unsafe extern "C" fn seg_accumulate(seg: *mut Segmenter, flipped: u32) {
    let s = &mut *seg;
    post::blur(&mut s.scratch, &s.prep.padded, 1);
    if flipped == 0 {
        s.posteriors = std::mem::take(&mut s.scratch);
    } else {
        post::average_flipped(&mut s.posteriors, &s.scratch, &s.prep.padded);
        s.scratch = Vec::new();
    }
}

/// # Safety
/// `seg` must be a live pointer from `seg_new`.
#[no_mangle]
pub unsafe extern "C" fn seg_labels(seg: *mut Segmenter, fast: u32) -> *const u8 {
    let s = &mut *seg;
    // Postprocessing peaks around another copy of the posteriors, so release what it no longer needs.
    s.scratch = Vec::new();
    s.flipped = Vec::new();
    let segmentation = post::segment(std::mem::take(&mut s.posteriors), &s.prep, fast != 0);
    s.volumes = segmentation.volumes_mm3;
    let image = nifti::write(&volume::restore(&segmentation.labels, &s.prep));
    drop(segmentation);
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    gz.write_all(&image).expect("gzip into a Vec cannot fail");
    s.output = gz.finish().expect("gzip into a Vec cannot fail");
    s.output.as_ptr()
}

/// # Safety
/// `seg` must be a live pointer from `seg_new` and is invalid afterwards.
#[no_mangle]
pub unsafe extern "C" fn seg_free(seg: *mut Segmenter) {
    drop(Box::from_raw(seg));
}
