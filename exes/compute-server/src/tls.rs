//! Self-signed certificate generation and PEM persistence.

use std::io;
use std::net::IpAddr;
use std::path::{Path, PathBuf};

use rcgen::{CertificateParams, DnType, KeyPair, SanType};

/// PEM file paths of a certificate and its private key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CertFiles {
    /// Certificate chain in PEM.
    pub cert: PathBuf,
    /// Private key in PEM.
    pub key: PathBuf,
}

/// Returns `data_dir/cert.pem` and `data_dir/key.pem`, generating a
/// self-signed certificate for the given names when they do not exist yet.
pub fn load_or_create_self_signed(
    data_dir: &Path,
    dns_names: &[String],
    ips: &[IpAddr],
) -> io::Result<CertFiles> {
    let files = CertFiles {
        cert: data_dir.join("cert.pem"),
        key: data_dir.join("key.pem"),
    };
    if files.cert.is_file() && files.key.is_file() {
        return Ok(files);
    }
    let (cert_pem, key_pem) = generate_self_signed(dns_names, ips)?;
    std::fs::create_dir_all(data_dir)?;
    std::fs::write(&files.cert, cert_pem)?;
    write_private(&files.key, key_pem.as_bytes())?;
    Ok(files)
}

/// Generates a self-signed certificate; returns `(cert_pem, key_pem)`.
pub fn generate_self_signed(dns_names: &[String], ips: &[IpAddr]) -> io::Result<(String, String)> {
    let mut names: Vec<String> = dns_names.to_vec();
    if names.is_empty() {
        names.push("localhost".to_string());
    }
    let mut params = CertificateParams::new(names).map_err(to_io)?;
    for ip in ips {
        params.subject_alt_names.push(SanType::IpAddress(*ip));
    }
    params
        .distinguished_name
        .push(DnType::CommonName, "neurodesk-compute");
    params
        .distinguished_name
        .push(DnType::OrganizationName, "Neurodesk");
    params.not_before = rcgen::date_time_ymd(2026, 1, 1);
    params.not_after = rcgen::date_time_ymd(2046, 1, 1);
    let key = KeyPair::generate().map_err(to_io)?;
    let cert = params.self_signed(&key).map_err(to_io)?;
    Ok((cert.pem(), key.serialize_pem()))
}

/// Writes a file readable only by its owner (on unix).
pub fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    Ok(())
}

fn to_io(error: rcgen::Error) -> io::Error {
    io::Error::other(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generates_and_reuses() {
        let dir = tempfile::tempdir().unwrap();
        let ips = vec!["127.0.0.1".parse().unwrap()];
        let files =
            load_or_create_self_signed(dir.path(), &["localhost".to_string()], &ips).unwrap();
        let first = std::fs::read_to_string(&files.cert).unwrap();
        assert!(first.contains("BEGIN CERTIFICATE"));
        assert!(std::fs::read_to_string(&files.key)
            .unwrap()
            .contains("PRIVATE KEY"));
        let again = load_or_create_self_signed(dir.path(), &[], &[]).unwrap();
        assert_eq!(std::fs::read_to_string(&again.cert).unwrap(), first);
    }
}
