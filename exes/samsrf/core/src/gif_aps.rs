//! Animated-GIF apertures (`MakeApsMat.m`, GIF branch): MATLAB's
//! `imread(file, 'frames', 'all')` returns each frame's palette indices (not colours),
//! which SamSrf divides by 255. Each frame is placed at its offset on a zero canvas of
//! the logical screen size; no disposal compositing, as `imread` does none.

use crate::apertures::Apertures;
use crate::error::{Error, Result};

fn format_error(message: impl Into<String>) -> Error {
    Error::format("GIF", message)
}

/// Pixels of a frame that fall outside the logical screen are dropped.
pub fn read_apertures(bytes: &[u8]) -> Result<Apertures> {
    let mut options = gif::DecodeOptions::new();
    options.set_color_output(gif::ColorOutput::Indexed);
    let mut decoder = options
        .read_info(bytes)
        .map_err(|error| format_error(format!("not a readable GIF: {error}")))?;
    let width = decoder.width() as usize;
    let height = decoder.height() as usize;
    let pixels = width * height;
    let mut data = Vec::new();
    let mut volumes = 0;
    while let Some(frame) = decoder
        .read_next_frame()
        .map_err(|error| format_error(format!("frame {} does not decode: {error}", volumes + 1)))?
    {
        let mut canvas = vec![0.0; pixels];
        let frame_width = frame.width as usize;
        for (y, row) in frame.buffer.chunks_exact(frame_width.max(1)).enumerate() {
            let screen_row = frame.top as usize + y;
            if screen_row >= height {
                break;
            }
            for (x, index) in row.iter().enumerate() {
                let screen_column = frame.left as usize + x;
                if screen_column >= width {
                    break;
                }
                canvas[screen_row + screen_column * height] = *index as f64 / 255.0;
            }
        }
        data.extend(canvas);
        volumes += 1;
    }
    if volumes == 0 {
        return Err(format_error("GIF has no frames"));
    }
    Apertures::from_dense(height, width, volumes, &data, None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::borrow::Cow;

    fn encode(width: u16, height: u16, frames: &[(u16, u16, u16, u16, Vec<u8>)]) -> Vec<u8> {
        let palette: Vec<u8> = (0..=255u8).flat_map(|level| [level, level, level]).collect();
        let mut bytes = Vec::new();
        {
            let mut encoder = gif::Encoder::new(&mut bytes, width, height, &palette).expect("encoder");
            for (left, top, frame_width, frame_height, indices) in frames {
                let frame = gif::Frame {
                    left: *left,
                    top: *top,
                    width: *frame_width,
                    height: *frame_height,
                    buffer: Cow::Borrowed(indices),
                    ..gif::Frame::default()
                };
                encoder.write_frame(&frame).expect("frame");
            }
        }
        bytes
    }

    #[test]
    fn frames_are_palette_indices_over_255_at_their_offsets() {
        // 6 columns x 4 rows; frame 0 fills the screen, frame 1 is a 2 x 1 patch at (row 2, column 3).
        let full: Vec<u8> = (0..24).map(|i| if i == 7 { 255 } else { 0 }).collect();
        let bytes = encode(6, 4, &[(0, 0, 6, 4, full), (3, 2, 2, 1, vec![51, 102])]);
        let apertures = read_apertures(&bytes).expect("valid GIF");
        assert_eq!((apertures.height, apertures.width, apertures.volumes()), (4, 6, 2));
        // Row-major index 7 is row 1, column 1: column-major pixel 1 + 1 * 4.
        assert_eq!(apertures.frames[0].indices, [5]);
        assert_eq!(apertures.frames[0].values, [1.0]);
        assert_eq!(apertures.frames[1].indices, [2 + 3 * 4, 2 + 4 * 4]);
        assert_eq!(apertures.frames[1].values, [51.0 / 255.0, 102.0 / 255.0]);
        assert_eq!(apertures.xy, Apertures::from_dense(4, 6, 1, &[0.0; 24], None).expect("grid").xy);
    }

    #[test]
    fn refuses_garbage_and_odd_screens() {
        assert!(matches!(read_apertures(b"not a gif"), Err(Error::Format { .. })));
        let odd = encode(5, 4, &[(0, 0, 5, 4, vec![0; 20])]);
        assert!(matches!(read_apertures(&odd), Err(Error::Shape(_))));
    }
}
