//! `neurodesk-compute fetch-example`: downloads a pinned example dataset from
//! the Hugging Face dataset `neurodeskorg/webapps` into a directory the
//! operator then serves as a data root. Every file is fetched at an immutable
//! commit, checked against the SHA-256 pinned here, written to `<file>.part`
//! and renamed into place only when verified. A rerun skips verified files and
//! resumes partial ones with an HTTP range request.

use std::fmt;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use futures_util::StreamExt;

/// Where datasets are downloaded from.
pub const HUGGING_FACE_DATASETS: &str = "https://huggingface.co/datasets";

/// Attempts per file before a network failure is reported.
const ATTEMPTS: u32 = 5;

/// One file of an example.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExampleFile {
    /// Path below the example's directory, `/`-separated.
    pub path: String,
    /// Lowercase hex SHA-256.
    pub sha256: String,
    /// Size in bytes.
    pub bytes: u64,
}

/// A pinned example dataset.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Example {
    /// Name on the command line and directory below `--dest`.
    pub name: String,
    /// Hugging Face dataset, `owner/name`.
    pub repository: String,
    /// The immutable commit.
    pub revision: String,
    /// Directory of the example in the dataset.
    pub prefix: String,
    /// Every file, with its checksum.
    pub files: Vec<ExampleFile>,
    /// What to import once the directory is served as data root `examples`.
    pub usage: String,
}

const RELION_TUTORIAL_FILES: [(&str, &str, u64); 28] = [
    (
        "README.md",
        "a58e0b402f9e1788fc81efb2817d8df7b97c0323df8a6b9e11369df73f17eb2e",
        978,
    ),
    (
        "SHA256SUMS",
        "123d411889e6259ec176942ada14c49b0bd43fddd371b944a76e5aed888367da",
        2657,
    ),
    (
        "Movies/NOTES",
        "6ed4c3984f437545fc22da9f0c82f9637ad2ec53a1916d9fcfdc4ec1a76811e7",
        220,
    ),
    (
        "Movies/gain.mrc",
        "8919cdc7bf0f481cdb3dd5bcb20d83c29e0263b2fcc78b212c74b33a81b1acd1",
        56956944,
    ),
    (
        "Movies/20170629_00021_frameImage.tiff",
        "df298b1b7741b1e5c9ec3b3e4514745a405d38b997b77a920f9f6b1bf30b99c0",
        126550106,
    ),
    (
        "Movies/20170629_00022_frameImage.tiff",
        "cc55f13d606463acbad23a4d42f2e48e60ee9cd783eeca0f1957a103b748ac47",
        129567782,
    ),
    (
        "Movies/20170629_00023_frameImage.tiff",
        "87c2640f5c2200c2f8e62e7dd50f4aa2d694fac2238743560b7c705fb0e61f3f",
        131245904,
    ),
    (
        "Movies/20170629_00024_frameImage.tiff",
        "70e075416ee6b682600277b21bf626c51f2c0b98f0f23dafe6a3478ea1766595",
        131735614,
    ),
    (
        "Movies/20170629_00025_frameImage.tiff",
        "798cf7b0cd24aef070d69525543214bdd60a3900667d7d3a32dfe3bffe9fce1a",
        130134480,
    ),
    (
        "Movies/20170629_00026_frameImage.tiff",
        "f989391b9d0e3e3b927a8de59d60179ade0b7ae5075ce7c3a9a5002ae2254ae3",
        132754590,
    ),
    (
        "Movies/20170629_00027_frameImage.tiff",
        "adb4fbf597ca78387b22c4a2452c7351499f7b78fb2da67bc5fdd52e4bc58a39",
        133754728,
    ),
    (
        "Movies/20170629_00028_frameImage.tiff",
        "b990365a74752daecbf437aab4b6b235197bf9932f18541246ed1e72ea629e2c",
        133960502,
    ),
    (
        "Movies/20170629_00029_frameImage.tiff",
        "91a985fddf18a7388740d601d6909c6de3a28c7df98d2d263126c8dd90e9f234",
        131961632,
    ),
    (
        "Movies/20170629_00030_frameImage.tiff",
        "878ad41ae6ff95d902fe1c996ad2703285d538b610d3f108433a272d627c8e59",
        131259748,
    ),
    (
        "Movies/20170629_00031_frameImage.tiff",
        "fa2699a1203a2ee278a5973e10105ea3e56b18a1c1d5ee153482767cb7e71d8d",
        132157138,
    ),
    (
        "Movies/20170629_00035_frameImage.tiff",
        "407f435a5dec04e5425feb7ef34d014b047765a9fa07d25093035245fa56253c",
        134600552,
    ),
    (
        "Movies/20170629_00036_frameImage.tiff",
        "ed1dbbbf81cb83d232f442e6f00c0391780022d2231800f595248fa97bf677b0",
        134642532,
    ),
    (
        "Movies/20170629_00037_frameImage.tiff",
        "b90176a79afed2857c180bf272637b7b6e187e52202d8e132beff68a683a01b6",
        134726088,
    ),
    (
        "Movies/20170629_00039_frameImage.tiff",
        "c3e474564505dfe3095b08f0e1ae70b331387cdb66c3251637d879a461cc317c",
        134190674,
    ),
    (
        "Movies/20170629_00040_frameImage.tiff",
        "08d2b7f3d4375f73deb67e2131d92cb2d707fee7866f9dffba133f570fd4771a",
        134017162,
    ),
    (
        "Movies/20170629_00042_frameImage.tiff",
        "5acc8ae812df2cd5925f15db8dd6dd2db65b88df96402eb1eb04182970135083",
        132281636,
    ),
    (
        "Movies/20170629_00043_frameImage.tiff",
        "5e89d7afe604533ac1b264de77b1a7cefcc91ecaf1ba8175a08ffd7651abdc61",
        131963598,
    ),
    (
        "Movies/20170629_00044_frameImage.tiff",
        "e5476b46c5de02caddd446f20e6ddd81311dff3264ad173439da0200eb6271dc",
        134677684,
    ),
    (
        "Movies/20170629_00045_frameImage.tiff",
        "c0cab09118639dd3d38e39442df465fa7a352029a217184738747afb2cd4bc7a",
        134666858,
    ),
    (
        "Movies/20170629_00046_frameImage.tiff",
        "61094383ce6750976275b13227033dcdb154c8214ef3db402aa6440a505ad377",
        134394390,
    ),
    (
        "Movies/20170629_00047_frameImage.tiff",
        "4ebadc647bf112242e17d975e65a67aaaeaf8296f71cb99d10ca790a92a06192",
        134471280,
    ),
    (
        "Movies/20170629_00048_frameImage.tiff",
        "05348afd74991a20e09d10667268ab496b3a614a891a8f9954fce212f418d955",
        134412868,
    ),
    (
        "Movies/20170629_00049_frameImage.tiff",
        "78d0d2c96c03d13a97d12da7e7ae5e8878abea057a728b4fea239d0642090faf",
        134103752,
    ),
];

/// The 24 movies and gain reference of RELION's single-particle tutorial
/// (EMPIAR-10204 subset, CC0), as the Cryo-EM app's example uses them.
pub fn relion_tutorial() -> Example {
    Example {
        name: "relion-tutorial".into(),
        repository: "neurodeskorg/webapps".into(),
        revision: "607388b20e8c7e0000ec8498d19ac7e3c35d6472".into(),
        prefix: "cryo-em/relion-tutorial".into(),
        files: RELION_TUTORIAL_FILES
            .iter()
            .map(|(path, sha256, bytes)| ExampleFile {
                path: path.to_string(),
                sha256: sha256.to_string(),
                bytes: *bytes,
            })
            .collect(),
        usage: "import root \"examples\", path \"relion-tutorial/Movies\", pattern \"*.tiff\" \
                (0.885 Å/pixel, 200 kV, Cs 1.4 mm, 1.277 e/Å² per frame); \
                gain reference root \"examples\", path \"relion-tutorial/Movies/gain.mrc\""
            .into(),
    }
}

/// Every example `fetch-example` knows.
pub fn examples() -> Vec<Example> {
    vec![relion_tutorial()]
}

impl Example {
    /// The download URL of one file at the pinned commit.
    pub fn url(&self, base: &str, file: &ExampleFile) -> String {
        format!(
            "{}/{}/resolve/{}/{}/{}",
            base.trim_end_matches('/'),
            self.repository,
            self.revision,
            self.prefix,
            file.path
        )
    }

    /// The total size of the example.
    pub fn bytes(&self) -> u64 {
        self.files.iter().map(|file| file.bytes).sum()
    }
}

/// Why a fetch failed.
#[derive(Debug)]
pub enum FetchError {
    /// Reading or writing the destination failed.
    Io(PathBuf, std::io::Error),
    /// The server could not be reached or answered with an error.
    Http(String),
    /// A downloaded file is not the pinned one; the partial file is removed.
    Checksum {
        path: String,
        expected: String,
        actual: String,
    },
}

impl fmt::Display for FetchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FetchError::Io(path, error) => write!(f, "{}: {error}", path.display()),
            FetchError::Http(message) => f.write_str(message),
            FetchError::Checksum {
                path,
                expected,
                actual,
            } => write!(
                f,
                "{path}: SHA-256 {actual} does not match the pinned {expected}; the download was discarded"
            ),
        }
    }
}

impl std::error::Error for FetchError {}

/// What happened to one file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Progress {
    /// The file was already present and verified.
    Verified { path: String },
    /// A download starts, from `offset` when it resumes a partial file.
    Downloading {
        path: String,
        offset: u64,
        bytes: u64,
    },
    /// A download attempt failed and will be retried.
    Retrying { path: String, error: String },
    /// The file was downloaded and verified.
    Done { path: String },
}

fn io_error(path: &Path) -> impl FnOnce(std::io::Error) -> FetchError + '_ {
    move |error| FetchError::Io(path.to_path_buf(), error)
}

fn hex(digest: &[u8]) -> String {
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The SHA-256 of a file's first `limit` bytes, or of all of it.
fn digest_file(path: &Path, limit: Option<u64>) -> std::io::Result<(ring::digest::Context, u64)> {
    let file = std::fs::File::open(path)?;
    let mut reader: Box<dyn Read> = match limit {
        Some(limit) => Box::new(file.take(limit)),
        None => Box::new(file),
    };
    let mut context = ring::digest::Context::new(&ring::digest::SHA256);
    let mut buffer = vec![0u8; 1 << 20];
    let mut total = 0;
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            return Ok((context, total));
        }
        context.update(&buffer[..read]);
        total += read as u64;
    }
}

/// Whether `path` holds exactly the pinned file.
pub fn verified(path: &Path, file: &ExampleFile) -> bool {
    match std::fs::metadata(path) {
        Ok(metadata) if metadata.is_file() && metadata.len() == file.bytes => {}
        _ => return false,
    }
    digest_file(path, None)
        .map(|(context, _)| hex(context.finish().as_ref()) == file.sha256)
        .unwrap_or(false)
}

fn sync_directory(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    std::fs::File::open(path)?.sync_all()?;
    let _ = path;
    Ok(())
}

enum Attempt {
    Complete,
    Retry(String),
}

/// Downloads `example` into `<dest>/<name>/` from `base` (normally
/// [`HUGGING_FACE_DATASETS`]) and returns that directory.
pub async fn fetch(
    example: &Example,
    dest: &Path,
    base: &str,
    report: &mut (dyn FnMut(Progress) + Send),
) -> Result<PathBuf, FetchError> {
    let root = dest.join(&example.name);
    std::fs::create_dir_all(&root).map_err(io_error(&root))?;
    let client = reqwest::Client::builder()
        .user_agent(concat!("neurodesk-compute/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(30))
        .read_timeout(Duration::from_secs(120))
        .build()
        .map_err(|error| FetchError::Http(error.to_string()))?;
    for file in &example.files {
        let target = root.join(&file.path);
        if verified(&target, file) {
            report(Progress::Verified {
                path: file.path.clone(),
            });
            continue;
        }
        let parent = target.parent().unwrap_or(&root).to_path_buf();
        std::fs::create_dir_all(&parent).map_err(io_error(&parent))?;
        let name = target
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let part = parent.join(format!("{name}.part"));
        let url = example.url(base, file);
        let mut attempt = 0;
        loop {
            attempt += 1;
            match download(&client, &url, &part, file, report).await? {
                Attempt::Complete => break,
                Attempt::Retry(error) if attempt < ATTEMPTS => {
                    report(Progress::Retrying {
                        path: file.path.clone(),
                        error,
                    });
                    tokio::time::sleep(Duration::from_secs(u64::from(attempt) * 2)).await;
                }
                Attempt::Retry(error) => {
                    return Err(FetchError::Http(format!(
                        "{}: {error} (gave up after {ATTEMPTS} attempts; rerun to resume)",
                        file.path
                    )))
                }
            }
        }
        std::fs::rename(&part, &target).map_err(io_error(&target))?;
        sync_directory(&parent).map_err(io_error(&parent))?;
        report(Progress::Done {
            path: file.path.clone(),
        });
    }
    Ok(root)
}

/// One attempt: resumes `part` when it holds a prefix of the file, verifies
/// the result and leaves `part` complete, or asks for a retry. A checksum
/// mismatch removes `part` and fails.
async fn download(
    client: &reqwest::Client,
    url: &str,
    part: &Path,
    file: &ExampleFile,
    report: &mut (dyn FnMut(Progress) + Send),
) -> Result<Attempt, FetchError> {
    let existing = std::fs::metadata(part)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    let offset = if existing > file.bytes { 0 } else { existing };
    let mut fresh = offset == 0;
    let (mut context, mut written) = if offset > 0 {
        digest_file(part, Some(offset)).map_err(io_error(part))?
    } else {
        (ring::digest::Context::new(&ring::digest::SHA256), 0)
    };
    if offset < file.bytes {
        report(Progress::Downloading {
            path: file.path.clone(),
            offset,
            bytes: file.bytes,
        });
        let mut request = client.get(url);
        if offset > 0 {
            request = request.header(reqwest::header::RANGE, format!("bytes={offset}-"));
        }
        let response = match request.send().await {
            Ok(response) => response,
            Err(error) => return Ok(Attempt::Retry(error.to_string())),
        };
        let status = response.status();
        let resumed = status == reqwest::StatusCode::PARTIAL_CONTENT && offset > 0;
        if !resumed && status != reqwest::StatusCode::OK {
            let message = format!("{url}: HTTP {status}");
            if status.is_server_error() || status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                return Ok(Attempt::Retry(message));
            }
            return Err(FetchError::Http(message));
        }
        let mut output = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .append(resumed)
            .truncate(!resumed)
            .open(part)
            .map_err(io_error(part))?;
        if !resumed {
            context = ring::digest::Context::new(&ring::digest::SHA256);
            written = 0;
            fresh = true;
        }
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = match chunk {
                Ok(chunk) => chunk,
                Err(error) => {
                    output.sync_all().map_err(io_error(part))?;
                    return Ok(Attempt::Retry(error.to_string()));
                }
            };
            written += chunk.len() as u64;
            if written > file.bytes {
                drop(output);
                let _ = std::fs::remove_file(part);
                return Err(FetchError::Http(format!(
                    "{}: the server sent more than the pinned {} bytes",
                    file.path, file.bytes
                )));
            }
            context.update(&chunk);
            output.write_all(&chunk).map_err(io_error(part))?;
        }
        output.sync_all().map_err(io_error(part))?;
        if written < file.bytes {
            return Ok(Attempt::Retry(format!(
                "the transfer ended after {written} of {} bytes",
                file.bytes
            )));
        }
    }
    let actual = hex(context.finish().as_ref());
    if actual != file.sha256 {
        let _ = std::fs::remove_file(part);
        if !fresh {
            return Ok(Attempt::Retry(format!(
                "the resumed file does not match its SHA-256; starting {} again",
                file.path
            )));
        }
        return Err(FetchError::Checksum {
            path: file.path.clone(),
            expected: file.sha256.clone(),
            actual,
        });
    }
    Ok(Attempt::Complete)
}

/// Human-readable size.
pub fn size(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["B", "KB", "MB", "GB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1000.0 && unit < UNITS.len() - 1 {
        value /= 1000.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

#[cfg(test)]
#[path = "examples_tests.rs"]
mod tests;
