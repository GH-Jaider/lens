//! Phones only hand their camera to HTTPS pages, so Lens makes its own
//! certificate. It is kept on disk per address: the phone then remembers that
//! its owner accepted it, and the warning shows only the first time.
use std::{fs, net::IpAddr, path::Path, time::Duration as StdDuration};

use rcgen::{CertificateParams, ExtendedKeyUsagePurpose, KeyPair, KeyUsagePurpose, SanType};
use time::{Duration, OffsetDateTime};

/// Phones refuse certificates that last much longer than two years.
const VALID_DAYS: i64 = 800;
const RENEW_AFTER: StdDuration = StdDuration::from_secs(700 * 24 * 60 * 60);

/// The certificate and key (both PEM) for this address.
pub fn cert_for(dir: &Path, ip: IpAddr) -> Result<(Vec<u8>, Vec<u8>), String> {
    let cert_path = dir.join(format!("cert-{ip}.pem"));
    let key_path = dir.join(format!("key-{ip}.pem"));
    let fresh = fs::metadata(&cert_path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|at| at.elapsed().ok())
        .is_some_and(|age| age < RENEW_AFTER);
    if fresh {
        if let (Ok(cert), Ok(key)) = (fs::read(&cert_path), fs::read(&key_path)) {
            return Ok((cert, key));
        }
    }

    let fail = |error: rcgen::Error| error.to_string();
    let mut params = CertificateParams::new(vec!["localhost".to_string()]).map_err(fail)?;
    params.subject_alt_names.push(SanType::IpAddress(ip));
    params.distinguished_name.push(rcgen::DnType::CommonName, "Lens");
    params.not_before = OffsetDateTime::now_utc() - Duration::days(1);
    params.not_after = OffsetDateTime::now_utc() + Duration::days(VALID_DAYS);
    params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
    params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    let key = KeyPair::generate().map_err(fail)?;
    let cert = params.self_signed(&key).map_err(fail)?;
    let (cert, key) = (cert.pem().into_bytes(), key.serialize_pem().into_bytes());

    // Not being able to save it only means the phone warns again next time.
    let _ = fs::create_dir_all(dir);
    let _ = fs::write(&cert_path, &cert);
    let _ = fs::write(&key_path, &key);
    Ok((cert, key))
}
