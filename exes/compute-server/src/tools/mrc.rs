//! MRC uploads (gain references, masks): only the map magic is checked.

/// Byte offset of the `MAP ` magic in an MRC2014 header.
pub const MAGIC_OFFSET: usize = 208;

/// How many leading bytes of an upload are kept for validation.
pub const HEADER_LEN: usize = 1024;

/// Whether `header` carries `MAP ` at byte 208.
pub fn has_map_magic(header: &[u8]) -> bool {
    header.get(MAGIC_OFFSET..MAGIC_OFFSET + 4) == Some(b"MAP ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_the_map_magic() {
        let mut header = vec![0u8; HEADER_LEN];
        assert!(!has_map_magic(&header));
        header[MAGIC_OFFSET..MAGIC_OFFSET + 4].copy_from_slice(b"MAP ");
        assert!(has_map_magic(&header));
        assert!(!has_map_magic(&header[..210]));
    }
}
