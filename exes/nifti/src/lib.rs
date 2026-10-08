pub mod affine;

/// Converts one unscaled scalar chunk to f64.
pub type ScalarDecoder = fn(&[u8]) -> f64;

/// Raw NIfTI-1 fields, without image acceptance, scaling or geometry policy.
/// Signed dimensions and unmodified f32 values retain malformed header values.
pub struct Nifti1Header {
    pub dim: [i16; 8],
    pub pixdim: [f32; 8],
    pub vox_offset: f32,
    pub scl_slope: f32,
    pub scl_inter: f32,
    pub qform_code: i16,
    pub sform_code: i16,
    pub quaternion: [f32; 3],
    pub qoffset: [f32; 3],
    pub srow: [[f32; 4]; 3],
    pub xyzt_units: u8,
    datatype: i16,
    little_endian: bool,
}

impl Nifti1Header {
    /// Interprets a bounded header without validating or normalizing its fields.
    /// LE sizeof_hdr equal to 348 selects LE; every other value selects BE.
    /// Callers must retain their own file acceptance checks.
    pub fn decode(bytes: &[u8; 348]) -> Self {
        let le = i32::from_le_bytes(bytes[0..4].try_into().unwrap()) == 348;
        let i16at = |o: usize| {
            let b = [bytes[o], bytes[o + 1]];
            if le {
                i16::from_le_bytes(b)
            } else {
                i16::from_be_bytes(b)
            }
        };
        let f32at = |o: usize| {
            let b: [u8; 4] = bytes[o..o + 4].try_into().unwrap();
            if le {
                f32::from_le_bytes(b)
            } else {
                f32::from_be_bytes(b)
            }
        };
        Self {
            dim: std::array::from_fn(|a| i16at(40 + 2 * a)),
            pixdim: std::array::from_fn(|a| f32at(76 + 4 * a)),
            vox_offset: f32at(108),
            scl_slope: f32at(112),
            scl_inter: f32at(116),
            qform_code: i16at(252),
            sform_code: i16at(254),
            quaternion: std::array::from_fn(|a| f32at(256 + 4 * a)),
            qoffset: std::array::from_fn(|a| f32at(268 + 4 * a)),
            srow: std::array::from_fn(|r| std::array::from_fn(|k| f32at(280 + (r * 4 + k) * 4))),
            xyzt_units: bytes[123],
            datatype: i16at(70),
            little_endian: le,
        }
    }

    /// Selects the scalar conversion once, after caller dimension validation.
    /// Each input chunk must have the returned byte width.
    pub fn scalar_decoder(&self) -> Result<(usize, ScalarDecoder), String> {
        let datatype = self.datatype;
        let le = self.little_endian;
        macro_rules! decoder {
            ($t:ty) => {
                if le {
                    |c: &[u8]| <$t>::from_le_bytes(c.try_into().unwrap()) as f64
                } else {
                    |c: &[u8]| <$t>::from_be_bytes(c.try_into().unwrap()) as f64
                }
            };
        }
        let (width, decode): (usize, ScalarDecoder) = match datatype {
            2 => (1, |c| c[0] as f64),
            256 => (1, |c| c[0] as i8 as f64),
            4 => (2, decoder!(i16)),
            512 => (2, decoder!(u16)),
            8 => (4, decoder!(i32)),
            768 => (4, decoder!(u32)),
            16 => (4, decoder!(f32)),
            64 => (8, decoder!(f64)),
            _ => {
                return Err(format!(
                    "Unsupported NIfTI datatype {datatype}. Use a scalar intensity image."
                ))
            }
        };
        Ok((width, decode))
    }
}

#[cfg(test)]
mod tests {
    use super::Nifti1Header;

    fn put16(bytes: &mut [u8; 348], offset: usize, value: i16, le: bool) {
        let raw = if le {
            value.to_le_bytes()
        } else {
            value.to_be_bytes()
        };
        bytes[offset..offset + 2].copy_from_slice(&raw);
    }

    fn put32(bytes: &mut [u8; 348], offset: usize, bits: u32, le: bool) {
        let raw = if le {
            bits.to_le_bytes()
        } else {
            bits.to_be_bytes()
        };
        bytes[offset..offset + 4].copy_from_slice(&raw);
    }

    fn bytes(le: bool, datatype: i16) -> [u8; 348] {
        let mut bytes = [0; 348];
        put32(&mut bytes, 0, 348, le);
        put16(&mut bytes, 70, datatype, le);
        bytes
    }

    #[test]
    fn all_raw_header_fields_preserve_bits_in_both_orders() {
        for le in [true, false] {
            let mut bytes = bytes(le, -17);
            let dims = [i16::MIN, -1, 0, 1, 2, 127, 256, i16::MAX];
            for (i, value) in dims.iter().enumerate() {
                put16(&mut bytes, 40 + 2 * i, *value, le);
            }
            let bits = [
                0,
                0x8000_0000,
                0x7f80_0000,
                0xff80_0000,
                0x7fc0_1234,
                0xffc0_5678,
                0xc020_0000,
                1,
            ];
            let offsets: Vec<usize> = (0..8)
                .map(|i| 76 + 4 * i)
                .chain([108, 112, 116])
                .chain((0..6).map(|i| 256 + 4 * i))
                .chain((0..12).map(|i| 280 + 4 * i))
                .collect();
            for (i, offset) in offsets.iter().enumerate() {
                put32(&mut bytes, *offset, bits[i % bits.len()], le);
            }
            put16(&mut bytes, 252, i16::MIN, le);
            put16(&mut bytes, 254, i16::MAX, le);
            bytes[123] = 0xff;
            let header = Nifti1Header::decode(&bytes);
            assert_eq!(header.dim, dims);
            assert_eq!(header.qform_code, i16::MIN);
            assert_eq!(header.sform_code, i16::MAX);
            assert_eq!(header.xyzt_units, 0xff);
            let actual: Vec<u32> = header
                .pixdim
                .iter()
                .copied()
                .chain([header.vox_offset, header.scl_slope, header.scl_inter])
                .chain(header.quaternion)
                .chain(header.qoffset)
                .chain(header.srow.into_iter().flatten())
                .map(f32::to_bits)
                .collect();
            let expected: Vec<u32> = (0..offsets.len()).map(|i| bits[i % bits.len()]).collect();
            assert_eq!(actual, expected);
            assert_eq!(
                header.scalar_decoder().err().unwrap(),
                "Unsupported NIfTI datatype -17. Use a scalar intensity image."
            );
        }
    }

    #[test]
    fn malformed_header_size_still_selects_big_endian() {
        let mut bytes = bytes(false, 4);
        put32(&mut bytes, 0, 12345, false);
        put16(&mut bytes, 42, -256, false);
        let header = Nifti1Header::decode(&bytes);
        assert_eq!(header.dim[1], -256);
        let (width, decode) = header.scalar_decoder().unwrap();
        assert_eq!(width, 2);
        assert_eq!(decode(&(-513i16).to_be_bytes()), -513.0);
    }

    #[test]
    fn all_scalar_types_decode_extrema_and_float_bits_in_both_orders() {
        for le in [true, false] {
            macro_rules! check {
                ($code:expr, $t:ty, $values:expr) => {{
                    let header = Nifti1Header::decode(&bytes(le, $code));
                    let (width, decode) = header.scalar_decoder().unwrap();
                    assert_eq!(width, std::mem::size_of::<$t>());
                    for value in $values {
                        let raw = if le {
                            value.to_le_bytes()
                        } else {
                            value.to_be_bytes()
                        };
                        assert_eq!(decode(&raw).to_bits(), (value as f64).to_bits());
                    }
                }};
            }
            check!(2, u8, [0u8, 1, u8::MAX]);
            check!(256, i8, [i8::MIN, -1, 0, i8::MAX]);
            check!(4, i16, [i16::MIN, -1, 0, i16::MAX]);
            check!(512, u16, [0u16, 1, u16::MAX]);
            check!(8, i32, [i32::MIN, -1, 0, i32::MAX]);
            check!(768, u32, [0u32, 1, u32::MAX]);
            check!(
                16,
                f32,
                [
                    0.0f32,
                    -0.0,
                    f32::MIN,
                    f32::MAX,
                    f32::INFINITY,
                    f32::NEG_INFINITY,
                    f32::from_bits(0x7fc0_1234)
                ]
            );
            check!(
                64,
                f64,
                [
                    0.0f64,
                    -0.0,
                    1.0000000000000002,
                    f64::MIN,
                    f64::MAX,
                    f64::INFINITY,
                    f64::NEG_INFINITY,
                    f64::from_bits(0x7ff8_0000_0000_1234)
                ]
            );
        }
    }
}
