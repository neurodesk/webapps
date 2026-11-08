//! The pinned manifest, and fetching from a local HTTP server: verification,
//! skipping verified files, resuming partial ones and discarding bad bytes.

use std::sync::{Arc, Mutex};

use axum::extract::Request;
use axum::middleware::{self, Next};
use axum::response::Response;

use super::*;

/// `SHA256SUMS` of the pinned revision, as downloaded from it.
const RELION_TUTORIAL_SUMS: &str = include_str!("examples_relion_tutorial.SHA256SUMS");

fn sha256(bytes: &[u8]) -> String {
    hex(ring::digest::digest(&ring::digest::SHA256, bytes).as_ref())
}

#[test]
fn the_relion_tutorial_manifest_is_the_pinned_sha256sums() {
    let example = relion_tutorial();
    assert_eq!(example.revision.len(), 40);
    let sums = example
        .files
        .iter()
        .find(|file| file.path == "SHA256SUMS")
        .unwrap();
    assert_eq!(sha256(RELION_TUTORIAL_SUMS.as_bytes()), sums.sha256);
    assert_eq!(RELION_TUTORIAL_SUMS.len() as u64, sums.bytes);
    let listed: Vec<(String, String)> = RELION_TUTORIAL_SUMS
        .lines()
        .map(|line| {
            let (hash, path) = line.split_once("  ").unwrap();
            (path.to_string(), hash.to_string())
        })
        .collect();
    let pinned: Vec<(String, String)> = example
        .files
        .iter()
        .filter(|file| file.path != "SHA256SUMS" && file.path != "README.md")
        .map(|file| (file.path.clone(), file.sha256.clone()))
        .collect();
    let mut sorted = pinned.clone();
    sorted.sort();
    let mut listed_sorted = listed.clone();
    listed_sorted.sort();
    assert_eq!(
        sorted, listed_sorted,
        "every file of SHA256SUMS is pinned, and only those"
    );
    let movies: Vec<u32> = (21..=31)
        .chain([35, 36, 37, 39, 40])
        .chain(42..=49)
        .collect();
    for number in &movies {
        let path = format!("Movies/20170629_000{number}_frameImage.tiff");
        assert!(example.files.iter().any(|file| file.path == path), "{path}");
    }
    assert_eq!(example.files.len(), movies.len() + 4);
    assert!(example.files.iter().all(|file| file.sha256.len() == 64
        && file
            .sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())));
    assert_eq!(
        example.url(HUGGING_FACE_DATASETS, &example.files[3]),
        "https://huggingface.co/datasets/neurodeskorg/webapps/resolve/607388b20e8c7e0000ec8498d19ac7e3c35d6472/cryo-em/relion-tutorial/Movies/gain.mrc"
    );
    assert!(example.bytes() > 3_000_000_000);
}

/// Requested paths with their `Range` headers.
type Requests = Arc<Mutex<Vec<(String, Option<String>)>>>;

struct Server {
    base: String,
    requests: Requests,
    _dir: tempfile::TempDir,
    files: std::path::PathBuf,
}

async fn record(
    axum::extract::State(requests): axum::extract::State<Requests>,
    request: Request,
    next: Next,
) -> Response {
    let range = request
        .headers()
        .get("range")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    requests
        .lock()
        .unwrap()
        .push((request.uri().path().to_string(), range));
    next.run(request).await
}

async fn serve(example: &Example, contents: &[(&str, Vec<u8>)]) -> Server {
    let dir = tempfile::tempdir().unwrap();
    let files = dir.path().join(&example.prefix);
    for (path, bytes) in contents {
        let target = files.join(path);
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(target, bytes).unwrap();
    }
    let requests = Arc::new(Mutex::new(Vec::new()));
    let mount = format!("/{}/resolve/{}", example.repository, example.revision);
    let app = axum::Router::new()
        .nest_service(&mount, tower_http::services::ServeDir::new(dir.path()))
        .layer(middleware::from_fn_with_state(requests.clone(), record));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await });
    Server {
        base,
        requests,
        _dir: dir,
        files,
    }
}

fn example_of(contents: &[(&str, Vec<u8>)]) -> Example {
    Example {
        name: "tiny".into(),
        repository: "owner/data".into(),
        revision: "0123456789abcdef0123456789abcdef01234567".into(),
        prefix: "examples/tiny".into(),
        files: contents
            .iter()
            .map(|(path, bytes)| ExampleFile {
                path: path.to_string(),
                sha256: sha256(bytes),
                bytes: bytes.len() as u64,
            })
            .collect(),
        usage: String::new(),
    }
}

fn contents() -> Vec<(&'static str, Vec<u8>)> {
    vec![
        ("README.md", b"readme\n".to_vec()),
        (
            "Movies/a.tiff",
            (0..200_000u32).map(|value| value as u8).collect(),
        ),
        ("Movies/b.tiff", vec![7u8; 50_000]),
    ]
}

#[tokio::test]
async fn fetches_verifies_skips_and_resumes() {
    let contents = contents();
    let example = example_of(&contents);
    let server = serve(&example, &contents).await;
    let dest = tempfile::tempdir().unwrap();
    let mut events = Vec::new();
    let root = fetch(&example, dest.path(), &server.base, &mut |event| {
        events.push(event)
    })
    .await
    .unwrap();
    assert_eq!(root, dest.path().join("tiny"));
    for (path, bytes) in &contents {
        assert_eq!(&std::fs::read(root.join(path)).unwrap(), bytes, "{path}");
        assert!(!root.join(format!("{path}.part")).exists());
    }
    assert_eq!(server.requests.lock().unwrap().len(), 3);

    server.requests.lock().unwrap().clear();
    events.clear();
    fetch(&example, dest.path(), &server.base, &mut |event| {
        events.push(event)
    })
    .await
    .unwrap();
    assert!(
        server.requests.lock().unwrap().is_empty(),
        "verified files are not fetched again"
    );
    assert!(events
        .iter()
        .all(|event| matches!(event, Progress::Verified { .. })));

    // A corrupted file is fetched again; a partial download resumes.
    std::fs::write(root.join("Movies/b.tiff"), vec![8u8; 50_000]).unwrap();
    std::fs::remove_file(root.join("Movies/a.tiff")).unwrap();
    std::fs::write(root.join("Movies/a.tiff.part"), &contents[1].1[..120_000]).unwrap();
    server.requests.lock().unwrap().clear();
    fetch(&example, dest.path(), &server.base, &mut |_| {})
        .await
        .unwrap();
    for (path, bytes) in &contents {
        assert_eq!(&std::fs::read(root.join(path)).unwrap(), bytes, "{path}");
    }
    let requests = server.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 2);
    assert!(requests
        .iter()
        .any(|(path, range)| path.ends_with("/Movies/a.tiff")
            && range.as_deref() == Some("bytes=120000-")));
    assert!(requests
        .iter()
        .any(|(path, range)| path.ends_with("/Movies/b.tiff") && range.is_none()));
}

#[tokio::test]
async fn a_corrupt_partial_file_starts_again() {
    let contents = contents();
    let example = example_of(&contents);
    let server = serve(&example, &contents).await;
    let dest = tempfile::tempdir().unwrap();
    let root = dest.path().join("tiny");
    std::fs::create_dir_all(root.join("Movies")).unwrap();
    std::fs::write(root.join("Movies/b.tiff.part"), vec![9u8; 10_000]).unwrap();
    fetch(&example, dest.path(), &server.base, &mut |_| {})
        .await
        .unwrap();
    assert_eq!(
        std::fs::read(root.join("Movies/b.tiff")).unwrap(),
        contents[2].1
    );
}

#[tokio::test]
async fn bytes_that_do_not_match_the_pin_are_discarded() {
    let contents = contents();
    let mut example = example_of(&contents);
    example.files[2].sha256 = "0".repeat(64);
    let server = serve(&example, &contents).await;
    let dest = tempfile::tempdir().unwrap();
    let error = fetch(&example, dest.path(), &server.base, &mut |_| {})
        .await
        .unwrap_err();
    assert!(
        matches!(error, FetchError::Checksum { ref path, .. } if path == "Movies/b.tiff"),
        "{error}"
    );
    let root = dest.path().join("tiny");
    assert!(!root.join("Movies/b.tiff").exists());
    assert!(!root.join("Movies/b.tiff.part").exists());
    assert!(
        root.join("Movies/a.tiff").exists(),
        "files before the failure stay verified"
    );

    std::fs::remove_file(server.files.join("README.md")).unwrap();
    let missing = fetch(
        &example_of(&contents),
        tempfile::tempdir().unwrap().path(),
        &server.base,
        &mut |_| {},
    )
    .await
    .unwrap_err();
    assert!(missing.to_string().contains("HTTP 404"), "{missing}");
}

#[test]
fn sizes() {
    assert_eq!(size(978), "978 B");
    assert_eq!(size(56_956_944), "57.0 MB");
    assert_eq!(size(3_234_567_890), "3.2 GB");
}

#[test]
fn the_relion_image_is_pinned_at_a_commit() {
    let image = relion_image();
    assert!(
        image.revision.len() == 40 && image.revision.bytes().all(|byte| byte.is_ascii_hexdigit())
    );
    let [file] = image.files.as_slice() else {
        panic!("one image file");
    };
    assert_eq!(file.sha256, RELION_IMAGE_SHA256);
    assert!(file.sha256.len() == 64 && file.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()));
    assert!(file.bytes > 1 << 30);
    assert_eq!(
        image.url(HUGGING_FACE_DATASETS, file),
        format!(
            "https://huggingface.co/datasets/neurodeskorg/webapps/resolve/{}/cryo-em/relion-image/relion_5.1.1.sif",
            image.revision
        )
    );
    assert_eq!(images(), vec![image]);
}
