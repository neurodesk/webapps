use super::*;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);

struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        loop {
            let path = std::env::temp_dir().join(format!(
                "native-publication-contract-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            match fs::create_dir(&path) {
                Ok(()) => return Self(path),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => panic!("{e}"),
            }
        }
    }

    fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn temp(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(format!(".{}.partial", std::process::id()));
    PathBuf::from(name)
}

#[test]
fn publishes_exact_bytes_and_cleans_temporaries() {
    let scratch = Scratch::new();
    let image = scratch.path("image");
    let report = scratch.path("report");
    publish(
        &[(&image, vec![0, 255, 42]), (&report, b"json\n".to_vec())],
        false,
    )
    .unwrap();
    assert_eq!(fs::read(&image).unwrap(), [0, 255, 42]);
    assert_eq!(fs::read(&report).unwrap(), b"json\n");
    assert!(!temp(&image).exists());
    assert!(!temp(&report).exists());
}

#[test]
fn refuses_existing_destination_without_clobbering() {
    let scratch = Scratch::new();
    let image = scratch.path("image");
    fs::write(&image, b"original").unwrap();
    assert!(publish(&[(&image, b"new".to_vec())], false).is_err());
    assert_eq!(fs::read(&image).unwrap(), b"original");
    assert!(!temp(&image).exists());
}

#[test]
fn later_collision_rolls_back_new_destinations() {
    let scratch = Scratch::new();
    let image = scratch.path("image");
    let report = scratch.path("report");
    fs::write(&report, b"original").unwrap();
    assert!(publish(&[(&image, vec![1]), (&report, vec![2])], false).is_err());
    assert!(!image.exists());
    assert_eq!(fs::read(&report).unwrap(), b"original");
    assert!(!temp(&image).exists());
    assert!(!temp(&report).exists());
}

#[test]
fn force_replaces_existing_destination() {
    let scratch = Scratch::new();
    let image = scratch.path("image");
    fs::write(&image, b"original").unwrap();
    publish(&[(&image, b"new".to_vec())], true).unwrap();
    assert_eq!(fs::read(&image).unwrap(), b"new");
    assert!(!temp(&image).exists());
}

#[test]
fn force_later_failure_retains_earlier_replacement() {
    let scratch = Scratch::new();
    let image = scratch.path("image");
    let report = scratch.path("report");
    fs::write(&image, b"original").unwrap();
    fs::create_dir(&report).unwrap();
    assert!(publish(&[(&image, b"new".to_vec()), (&report, vec![2])], true).is_err());
    assert_eq!(fs::read(&image).unwrap(), b"new");
    assert!(report.is_dir());
    assert!(!temp(&image).exists());
    assert!(!temp(&report).exists());
}

#[test]
fn force_publication_order_is_supplied_by_caller() {
    let scratch = Scratch::new();
    let image = scratch.path("image");
    let report = scratch.path("report");
    fs::create_dir(&image).unwrap();
    assert!(publish(&[(&report, b"json".to_vec()), (&image, vec![2])], true).is_err());
    assert_eq!(fs::read(&report).unwrap(), b"json");
    assert!(image.is_dir());
    assert!(!temp(&image).exists());
    assert!(!temp(&report).exists());
}

#[test]
fn staging_failure_publishes_nothing_and_cleans_owned_files() {
    let scratch = Scratch::new();
    let image = scratch.path("created/image");
    let blocked = scratch.path("blocked");
    fs::write(&blocked, b"parent is a file").unwrap();
    let report = blocked.join("report");
    assert!(publish(&[(&image, vec![1]), (&report, vec![2])], true).is_err());
    assert!(!image.exists());
    assert!(!temp(&image).exists());
    assert!(image.parent().unwrap().is_dir());
    assert_eq!(fs::read(&blocked).unwrap(), b"parent is a file");
}

#[test]
fn failed_open_preserves_preexisting_temporary() {
    let scratch = Scratch::new();
    let image = scratch.path("image");
    let report = scratch.path("report");
    fs::write(temp(&report), b"someone else's temporary").unwrap();
    assert!(publish(&[(&image, vec![1]), (&report, vec![2])], false).is_err());
    assert!(!image.exists());
    assert!(!report.exists());
    assert!(!temp(&image).exists());
    assert_eq!(
        fs::read(temp(&report)).unwrap(),
        b"someone else's temporary"
    );
}

#[test]
fn empty_batch_succeeds() {
    publish(&[], false).unwrap();
    publish(&[], true).unwrap();
}

#[test]
fn failed_writes_clean_created_temporaries_before_publication() {
    for failing_write in [1, 2] {
        for force in [false, true] {
            let scratch = Scratch::new();
            let image = scratch.path("image");
            let report = scratch.path("report");
            if force {
                fs::write(&image, b"original image").unwrap();
                fs::write(&report, b"original report").unwrap();
            }
            let mut calls = 0;
            let error = publish_with_writer(
                &[
                    (&image, b"new image".to_vec()),
                    (&report, b"new report".to_vec()),
                ],
                force,
                |file, data| {
                    calls += 1;
                    if calls == failing_write {
                        file.write_all(b"prefix")?;
                        return Err(io::Error::other("injected write failure"));
                    }
                    file.write_all(data)
                },
            )
            .unwrap_err();
            let failed = if failing_write == 1 { &image } else { &report };
            assert_eq!(
                error,
                format!(
                    "Cannot write {}: injected write failure",
                    temp(failed).display()
                )
            );
            assert_eq!(calls, failing_write);
            assert!(!temp(&image).exists());
            assert!(!temp(&report).exists());
            if force {
                assert_eq!(fs::read(&image).unwrap(), b"original image");
                assert_eq!(fs::read(&report).unwrap(), b"original report");
            } else {
                assert!(!image.exists());
                assert!(!report.exists());
            }
        }
    }
}

#[test]
fn first_open_collision_preserves_stale_temporary() {
    let scratch = Scratch::new();
    let path = scratch.path("image");
    fs::write(temp(&path), b"stale").unwrap();
    let error = publish(&[(&path, vec![1])], true).unwrap_err();
    assert!(error.starts_with(&format!("Cannot write {}: ", temp(&path).display())));
    assert_eq!(fs::read(temp(&path)).unwrap(), b"stale");
    assert!(!path.exists());
}

#[test]
fn duplicate_destination_refuses_staging_and_cleans_owned_temporary() {
    let scratch = Scratch::new();
    let path = scratch.path("image");
    let error = publish(&[(&path, vec![1]), (&path, vec![2])], false).unwrap_err();
    assert!(error.starts_with(&format!("Cannot write {}: ", temp(&path).display())));
    assert!(!path.exists());
    assert!(!temp(&path).exists());
}

#[test]
fn stages_every_file_before_any_destination_is_published() {
    let scratch = Scratch::new();
    let image = scratch.path("image");
    let report = scratch.path("report");
    let mut calls = 0;
    publish_with_writer(
        &[(&image, vec![1]), (&report, vec![2])],
        false,
        |file, data| {
            calls += 1;
            assert!(!image.exists());
            assert!(!report.exists());
            if calls == 2 {
                assert_eq!(fs::read(temp(&image)).unwrap(), [1]);
            }
            file.write_all(data)
        },
    )
    .unwrap();
    assert_eq!(calls, 2);
    assert_eq!(fs::read(&image).unwrap(), [1]);
    assert_eq!(fs::read(&report).unwrap(), [2]);
    assert!(!temp(&image).exists());
    assert!(!temp(&report).exists());
}

#[test]
fn destination_created_during_staging_is_preserved_and_prior_link_is_rolled_back() {
    let scratch = Scratch::new();
    let first = scratch.path("report");
    let second = scratch.path("image");
    let mut calls = 0;
    let error = publish_with_writer(
        &[(&first, vec![1]), (&second, vec![2])],
        false,
        |file, data| {
            calls += 1;
            if calls == 2 {
                fs::write(&second, b"racing destination")?;
            }
            file.write_all(data)
        },
    )
    .unwrap_err();
    assert!(error.starts_with(&format!("Cannot write {}: ", second.display())));
    assert!(!first.exists());
    assert_eq!(fs::read(&second).unwrap(), b"racing destination");
    assert!(!temp(&first).exists());
    assert!(!temp(&second).exists());
}

#[test]
fn parent_failure_keeps_bare_error_category() {
    let scratch = Scratch::new();
    let blocked = scratch.path("blocked");
    fs::write(&blocked, b"file").unwrap();
    let path = blocked.join("image");
    let expected = fs::create_dir_all(&blocked).unwrap_err().to_string();
    assert_eq!(publish(&[(&path, vec![1])], false).unwrap_err(), expected);
    assert_eq!(fs::read(&blocked).unwrap(), b"file");
}

#[cfg(unix)]
#[test]
fn native_non_unicode_paths_publish_and_preserve_colliding_native_temporaries() {
    use std::ffi::OsString;
    use std::os::unix::ffi::OsStringExt;
    let scratch = Scratch::new();
    let path = scratch.0.join(OsString::from_vec(b"image-\xff".to_vec()));
    let mut native_temp = path.as_os_str().to_owned();
    native_temp.push(format!(".{}.partial", std::process::id()));
    let native_temp = PathBuf::from(native_temp);
    assert_eq!(temp(&path), native_temp);
    let mut calls = 0;
    publish_with_writer(&[(&path, vec![0, 255])], false, |file, data| {
        calls += 1;
        assert!(native_temp.is_file());
        file.write_all(data)
    })
    .unwrap();
    assert_eq!(calls, 1);
    assert_eq!(fs::read(&path).unwrap(), [0, 255]);
    assert!(!native_temp.exists());
    fs::write(&native_temp, b"stale native temporary").unwrap();
    let error = publish(&[(&path, vec![2])], true).unwrap_err();
    assert!(error.starts_with(&format!("Cannot write {}: ", native_temp.display())));
    assert_eq!(fs::read(&native_temp).unwrap(), b"stale native temporary");
    assert_eq!(fs::read(&path).unwrap(), [0, 255]);
    assert_eq!(fs::read_dir(&scratch.0).unwrap().count(), 2);
}

#[test]
fn force_replaces_every_existing_file_in_a_successful_batch() {
    let scratch = Scratch::new();
    let first = scratch.path("report");
    let second = scratch.path("image");
    fs::write(&first, b"old report").unwrap();
    fs::write(&second, b"old image").unwrap();
    publish(
        &[
            (&first, b"new report".to_vec()),
            (&second, b"new image".to_vec()),
        ],
        true,
    )
    .unwrap();
    assert_eq!(fs::read(&first).unwrap(), b"new report");
    assert_eq!(fs::read(&second).unwrap(), b"new image");
    assert!(!temp(&first).exists());
    assert!(!temp(&second).exists());
}
