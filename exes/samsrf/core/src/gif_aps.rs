//! Animated-GIF apertures (`MakeApsMat.m`, GIF branch): MATLAB's
//! `imread(file, 'frames', 'all')` returns each frame's palette indices (not colours),
//! which SamSrf divides by 255. Each frame is placed at its offset on a zero canvas of
//! the logical screen size; no disposal compositing, as `imread` does none.

use crate::apertures::Apertures;
use crate::error::Result;

pub fn read_apertures(bytes: &[u8]) -> Result<Apertures> {
    let _ = bytes;
    Err(crate::Error::NotImplemented("gif_aps::read_apertures"))
}
