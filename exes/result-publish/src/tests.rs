use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

struct Directory(PathBuf);

impl Directory {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!(
            "native-publish-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }

    fn assert_no_temporaries(&self) {
        for entry in fs::read_dir(&self.0).unwrap() {
            let path = entry.unwrap().path();
            assert_ne!(path.extension(), Some(std::ffi::OsStr::new("partial")));
        }
    }
}

impl Drop for Directory {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn publishes_exact_bytes_and_cleans_temporaries() {
    for force in [false, true] {
        let dir = Directory::new();
        let image = dir.path("image.nii.gz");
        let report = dir.path("image.json");
        publish(
            &[
                (image.as_path(), vec![0, 1, 128, 255]),
                (report.as_path(), b"{}\n".to_vec()),
            ],
            force,
        )
        .unwrap();
        assert_eq!(fs::read(image).unwrap(), [0, 1, 128, 255]);
        assert_eq!(fs::read(report).unwrap(), b"{}\n");
        dir.assert_no_temporaries();
    }
}

#[test]
fn partial_write_errors_clean_first_and_later_staged_files() {
    for force in [false, true] {
        for failed_write in [0, 1] {
            let dir = Directory::new();
            let first = dir.path("first");
            let second = dir.path("second");
            let files = [
                (first.as_path(), vec![1; 128]),
                (second.as_path(), vec![2; 128]),
            ];
            let mut writes = 0;
            let error = publish_with(&files, force, |file, data| {
                let current = writes;
                writes += 1;
                if current == failed_write {
                    file.write_all(&data[..64])?;
                    assert_eq!(file.metadata()?.len(), 64);
                    return Err(io::Error::other("injected staging write failure"));
                }
                file.write_all(data)
            })
            .unwrap_err();
            assert!(error.contains("injected staging write failure"), "{error}");
            assert!(!first.exists());
            assert!(!second.exists());
            assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 0);
        }
    }
}

#[test]
fn staging_write_errors_preserve_existing_destinations_even_with_force() {
    for force in [false, true] {
        let dir = Directory::new();
        let first = dir.path("first");
        let second = dir.path("second");
        fs::write(&first, b"original first").unwrap();
        fs::write(&second, b"original second").unwrap();
        let mut writes = 0;
        let result = publish_with(
            &[
                (first.as_path(), vec![1; 128]),
                (second.as_path(), vec![2; 128]),
            ],
            force,
            |file, data| {
                writes += 1;
                if writes == 2 {
                    file.write_all(&data[..64])?;
                    return Err(io::Error::other("injected staging write failure"));
                }
                file.write_all(data)
            },
        );
        assert!(result.is_err());
        assert_eq!(fs::read(first).unwrap(), b"original first");
        assert_eq!(fs::read(second).unwrap(), b"original second");
        dir.assert_no_temporaries();
    }
}

#[test]
fn temporary_collisions_preserve_unowned_files_and_clean_owned_files() {
    for force in [false, true] {
        for collision in [0, 1] {
            let dir = Directory::new();
            let first = dir.path("first");
            let second = dir.path("second");
            let files = [(first.as_path(), vec![1]), (second.as_path(), vec![2])];
            let existing = temporary_path(files[collision].0);
            fs::write(&existing, b"unowned temporary").unwrap();
            assert!(publish(&files, force).is_err());
            assert_eq!(fs::read(existing).unwrap(), b"unowned temporary");
            assert!(!first.exists());
            assert!(!second.exists());
            assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 1);
        }
    }
}

#[test]
fn non_force_publication_failure_rolls_back_only_new_destinations() {
    let dir = Directory::new();
    let first = dir.path("first");
    let second = dir.path("second");
    fs::write(&second, b"existing destination").unwrap();
    assert!(publish(
        &[(first.as_path(), vec![1]), (second.as_path(), vec![2])],
        false,
    )
    .is_err());
    assert!(!first.exists());
    assert_eq!(fs::read(second).unwrap(), b"existing destination");
    dir.assert_no_temporaries();
}

#[test]
fn force_failure_retains_earlier_replacements_in_the_callers_order() {
    // SynthSR publishes image then JSON; SynthSeg publishes JSON then image.
    for names in [["image.nii", "image.json"], ["image.json", "image.nii"]] {
        let dir = Directory::new();
        let first = dir.path(names[0]);
        let second = dir.path(names[1]);
        fs::write(&first, b"original first").unwrap();
        fs::create_dir(&second).unwrap();
        let sentinel = second.join("keep");
        fs::write(&sentinel, b"existing second").unwrap();
        assert!(publish(
            &[
                (first.as_path(), b"replacement".to_vec()),
                (second.as_path(), b"cannot replace a directory".to_vec()),
            ],
            true,
        )
        .is_err());
        assert_eq!(fs::read(first).unwrap(), b"replacement");
        assert_eq!(fs::read(sentinel).unwrap(), b"existing second");
        dir.assert_no_temporaries();
    }
}

#[test]
fn force_success_replaces_existing_destinations() {
    let dir = Directory::new();
    let path = dir.path("result");
    fs::write(&path, b"original").unwrap();
    publish(&[(path.as_path(), b"replacement".to_vec())], true).unwrap();
    assert_eq!(fs::read(path).unwrap(), b"replacement");
    dir.assert_no_temporaries();
}

#[test]
fn creates_parent_directories_and_accepts_an_empty_batch() {
    let dir = Directory::new();
    let path = dir.path("nested/result");
    publish(&[(path.as_path(), Vec::new())], false).unwrap();
    assert_eq!(fs::read(path).unwrap(), b"");
    publish(&[], false).unwrap();
    publish(&[], true).unwrap();
}

#[test]
fn failed_parent_creation_cleans_earlier_staging() {
    let dir = Directory::new();
    let first = dir.path("first");
    let parent = dir.path("not-a-directory");
    fs::write(&parent, b"keep").unwrap();
    let second = parent.join("second");
    assert!(publish(
        &[(first.as_path(), vec![1]), (second.as_path(), vec![2])],
        false,
    )
    .is_err());
    assert!(!first.exists());
    assert_eq!(fs::read(parent).unwrap(), b"keep");
    dir.assert_no_temporaries();
}

#[test]
fn preserves_unicode_paths() {
    let dir = Directory::new();
    let path = dir.path("résultat-脑.nii");
    publish(&[(path.as_path(), vec![42])], false).unwrap();
    assert_eq!(fs::read(path).unwrap(), [42]);
    dir.assert_no_temporaries();
}

#[cfg(unix)]
#[test]
fn temporary_names_preserve_non_utf8_path_bytes() {
    use std::os::unix::ffi::{OsStrExt, OsStringExt};
    let path = PathBuf::from(std::ffi::OsString::from_vec(
        b"native-\xff/result-\xfe.nii".to_vec(),
    ));
    let mut expected = path.as_os_str().as_bytes().to_vec();
    expected.extend_from_slice(format!(".{}.partial", std::process::id()).as_bytes());
    assert_eq!(temporary_path(&path).as_os_str().as_bytes(), expected);
}

#[cfg(unix)]
#[test]
fn non_utf8_publication_matches_filesystem_support() {
    use std::os::unix::ffi::OsStringExt;
    let dir = Directory::new();
    let parent = dir
        .0
        .join(std::ffi::OsString::from_vec(b"native-\xff".to_vec()));
    let path = parent.join(std::ffi::OsString::from_vec(b"result-\xfe.nii".to_vec()));
    // Linux filesystems accept these bytes; macOS APFS rejects them with EILSEQ.
    // Compare with the filesystem itself instead of assuming every Unix accepts
    // a non-UTF-8 directory name. A rejection must propagate without staging.
    match fs::create_dir(&parent) {
        Ok(()) => {
            publish(&[(path.as_path(), vec![42])], false).unwrap();
            assert_eq!(fs::read(&path).unwrap(), [42]);
            assert_eq!(fs::read_dir(parent).unwrap().count(), 1);
        }
        Err(error) => {
            assert_eq!(
                publish(&[(path.as_path(), vec![42])], false).unwrap_err(),
                error.to_string()
            );
            assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 0);
        }
    }
}
