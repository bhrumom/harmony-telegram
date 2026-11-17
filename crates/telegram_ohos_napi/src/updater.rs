//! Portable release updater, SemVer comparator, manifest parser, and SHA-256 package verifier.
//! Supports OpenHarmony `.app`/`.hap` manifests (`latest-ohos.json`), desktop `latest-mac.json`,
//! `file://` local feeds, HTTP feeds, and GitHub Releases API `/releases/latest`.

use std::cmp::Ordering;
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use futures::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const DEFAULT_GITHUB_REPO: &str = "bhrum/gpui-telegram";
pub const DEFAULT_MANIFEST_URL: &str =
    "https://github.com/bhrum/gpui-telegram/releases/latest/download/latest-ohos.json";
pub const DEFAULT_GITHUB_LATEST_API_URL: &str =
    "https://api.github.com/repos/bhrum/gpui-telegram/releases/latest";
pub const CURRENT_APP_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableUpdateInfo {
    pub version: String,
    pub asset_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub release_notes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hap_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlatformAssetEntry {
    #[serde(alias = "url", alias = "asset_url")]
    pub zip_url: String,
    #[serde(default, alias = "sha256", alias = "hap_sha256", alias = "app_sha256")]
    pub zip_sha256: Option<String>,
    #[serde(default, alias = "size", alias = "size_bytes")]
    pub zip_size: Option<u64>,
    #[serde(default)]
    pub hap_url: Option<String>,
    #[serde(default)]
    pub app_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdateReleaseManifest {
    pub version: String,
    #[serde(default)]
    pub tag_name: Option<String>,
    #[serde(default)]
    pub published_at: Option<String>,
    #[serde(default)]
    pub release_notes: Option<String>,
    #[serde(default)]
    pub platforms: HashMap<String, PlatformAssetEntry>,
    #[serde(default, alias = "assetUrl")]
    pub asset_url: Option<String>,
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default, alias = "sizeBytes")]
    pub size_bytes: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedSemver {
    major: u64,
    minor: u64,
    patch: u64,
    prerelease: Option<Vec<PreSegment>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum PreSegment {
    Num(u64),
    Text(String),
}

pub fn normalize_version_string(raw: &str) -> String {
    let mut s = raw.trim();
    for prefix in [
        "ohos-main-v",
        "ohos-main-",
        "macos-main-v",
        "macos-main-",
        "harmony-v",
        "v",
        "V",
    ] {
        if let Some(rest) = s.strip_prefix(prefix) {
            s = rest;
            break;
        }
    }
    if let Some((before_build, _)) = s.split_once('+') {
        s = before_build;
    }
    s.trim().to_string()
}

fn parse_semver(raw: &str) -> Option<ParsedSemver> {
    let norm = normalize_version_string(raw);
    if norm.is_empty() {
        return None;
    }
    let (core, pre_raw) = match norm.split_once('-') {
        Some((c, p)) => (c, Some(p)),
        None => (norm.as_str(), None),
    };
    let mut parts = core.split('.');
    let major = parts.next()?.parse::<u64>().ok()?;
    let minor = parts.next().unwrap_or("0").parse::<u64>().ok()?;
    let patch = parts.next().unwrap_or("0").parse::<u64>().ok()?;
    if parts.next().is_some() {
        return None;
    }
    let prerelease = pre_raw.and_then(|p| {
        let trimmed = p.trim();
        if trimmed.is_empty() {
            return None;
        }
        let segs = trimmed
            .split('.')
            .map(|seg| match seg.parse::<u64>() {
                Ok(n) => PreSegment::Num(n),
                Err(_) => PreSegment::Text(seg.to_ascii_lowercase()),
            })
            .collect();
        Some(segs)
    });
    Some(ParsedSemver {
        major,
        minor,
        patch,
        prerelease,
    })
}

fn compare_prerelease(a: &[PreSegment], b: &[PreSegment]) -> Ordering {
    for (seg_a, seg_b) in a.iter().zip(b.iter()) {
        let ord = match (seg_a, seg_b) {
            (PreSegment::Num(x), PreSegment::Num(y)) => x.cmp(y),
            (PreSegment::Num(_), PreSegment::Text(_)) => Ordering::Less,
            (PreSegment::Text(_), PreSegment::Num(_)) => Ordering::Greater,
            (PreSegment::Text(x), PreSegment::Text(y)) => x.cmp(y),
        };
        if ord != Ordering::Equal {
            return ord;
        }
    }
    a.len().cmp(&b.len())
}

pub fn compare_semver(left: &str, right: &str) -> Ordering {
    match (parse_semver(left), parse_semver(right)) {
        (Some(a), Some(b)) => {
            let core_ord = (a.major, a.minor, a.patch).cmp(&(b.major, b.minor, b.patch));
            if core_ord != Ordering::Equal {
                return core_ord;
            }
            match (&a.prerelease, &b.prerelease) {
                (None, None) => Ordering::Equal,
                (None, Some(_)) => Ordering::Greater,
                (Some(_), None) => Ordering::Less,
                (Some(pa), Some(pb)) => compare_prerelease(pa, pb),
            }
        }
        _ => normalize_version_string(left).cmp(&normalize_version_string(right)),
    }
}

pub fn is_newer_version(current: &str, candidate: &str) -> bool {
    if parse_semver(candidate).is_none() || parse_semver(current).is_none() {
        return false;
    }
    compare_semver(candidate, current) == Ordering::Greater
}

fn preferred_platform_keys() -> &'static [&'static str] {
    if cfg!(target_arch = "aarch64") {
        &[
            "ohos-arm64-v8a",
            "ohos-aarch64",
            "ohos-arm64",
            "harmony-arm64",
            "linux-arm64",
            "darwin-arm64",
        ]
    } else {
        &[
            "ohos-x86_64",
            "harmony-x86_64",
            "linux-x86_64",
            "ohos-arm64-v8a",
            "darwin-arm64",
        ]
    }
}

fn clean_sha256(raw: Option<&str>) -> Result<Option<String>, String> {
    let Some(s) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    let hex = s.strip_prefix("sha256:").unwrap_or(s).trim();
    if hex.len() != 64 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(format!("Invalid SHA-256 hex digest '{s}'"));
    }
    Ok(Some(hex.to_ascii_lowercase()))
}

pub fn parse_release_manifest(json_str: &str) -> Result<AvailableUpdateInfo, String> {
    let manifest: UpdateReleaseManifest =
        serde_json::from_str(json_str).map_err(|e| format!("Invalid manifest JSON: {e}"))?;
    let version = normalize_version_string(&manifest.version);
    if parse_semver(&version).is_none() {
        return Err(format!(
            "Manifest version '{}' is not valid SemVer",
            manifest.version
        ));
    }

    if manifest.platforms.is_empty() {
        let direct_url = manifest
            .asset_url
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "Manifest has no platform assets or asset_url".to_string())?;
        let sha256 = clean_sha256(manifest.sha256.as_deref())?;
        return Ok(AvailableUpdateInfo {
            version,
            asset_url: direct_url.to_string(),
            sha256,
            size_bytes: manifest.size_bytes,
            release_notes: manifest.release_notes,
            hap_url: None,
            app_url: None,
        });
    }

    let mut chosen: Option<&PlatformAssetEntry> = None;
    for key in preferred_platform_keys() {
        if let Some(entry) = manifest.platforms.get(*key) {
            chosen = Some(entry);
            break;
        }
    }
    if chosen.is_none() {
        chosen = manifest.platforms.values().next();
    }
    let entry = chosen.ok_or_else(|| "Manifest has no platform assets".to_string())?;
    if entry.zip_url.trim().is_empty() {
        return Err("Manifest asset URL is empty".to_string());
    }
    let sha256 = clean_sha256(entry.zip_sha256.as_deref())?;

    Ok(AvailableUpdateInfo {
        version,
        asset_url: entry.zip_url.trim().to_string(),
        sha256,
        size_bytes: entry.zip_size,
        release_notes: manifest.release_notes,
        hap_url: entry.hap_url.clone(),
        app_url: entry.app_url.clone(),
    })
}

#[derive(Debug, Deserialize)]
struct GitHubReleaseDto {
    #[serde(default)]
    tag_name: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    assets: Vec<GitHubAssetDto>,
}

#[derive(Debug, Deserialize)]
struct GitHubAssetDto {
    name: String,
    browser_download_url: String,
    #[serde(default)]
    size: Option<u64>,
    #[serde(default)]
    digest: Option<String>,
}

pub fn parse_github_release_json(json_str: &str) -> Result<AvailableUpdateInfo, String> {
    let dto: GitHubReleaseDto =
        serde_json::from_str(json_str).map_err(|e| format!("Invalid GitHub release JSON: {e}"))?;
    let raw_ver = if !dto.tag_name.trim().is_empty() {
        dto.tag_name.as_str()
    } else {
        dto.name.as_deref().unwrap_or("")
    };
    let version = normalize_version_string(raw_ver);
    if parse_semver(&version).is_none() {
        return Err(format!("GitHub release tag '{raw_ver}' is not valid SemVer"));
    }

    let best = dto
        .assets
        .iter()
        .find(|a| {
            let l = a.name.to_ascii_lowercase();
            l.ends_with(".app")
                || l.ends_with(".hap")
                || l.ends_with(".zip")
                || l.ends_with(".tar.gz")
        })
        .ok_or_else(|| "No installable .app/.hap/.zip/.tar.gz asset in release".to_string())?;

    let sha256 = clean_sha256(best.digest.as_deref())?;
    Ok(AvailableUpdateInfo {
        version,
        asset_url: best.browser_download_url.clone(),
        sha256,
        size_bytes: best.size,
        release_notes: dto.body.filter(|b| !b.trim().is_empty()),
        hap_url: dto
            .assets
            .iter()
            .find(|a| a.name.to_ascii_lowercase().ends_with(".hap"))
            .map(|a| a.browser_download_url.clone()),
        app_url: dto
            .assets
            .iter()
            .find(|a| a.name.to_ascii_lowercase().ends_with(".app"))
            .map(|a| a.browser_download_url.clone()),
    })
}

pub fn parse_any_release_payload(body: &str) -> Result<AvailableUpdateInfo, String> {
    let probe: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("Malformed release JSON: {e}"))?;
    if probe.get("platforms").is_some() || probe.get("version").is_some() {
        return parse_release_manifest(body);
    }
    parse_github_release_json(body)
}

pub fn file_url_to_path(url: &str) -> Option<PathBuf> {
    let rest = url.strip_prefix("file://")?;
    let clean = rest.strip_prefix("localhost").unwrap_or(rest);
    Some(PathBuf::from(clean))
}

fn build_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(format!("HarmonyTelegram/{CURRENT_APP_VERSION}"))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Failed to construct updater HTTP client: {e}"))
}

pub struct ReleaseUpdater;

impl ReleaseUpdater {
    pub async fn check_for_updates(
        feed_override: Option<&str>,
        current_version: &str,
    ) -> Result<(AvailableUpdateInfo, bool), String> {
        if parse_semver(current_version).is_none() {
            return Err(format!(
                "Current version '{current_version}' is not valid SemVer"
            ));
        }
        let trimmed = feed_override.map(str::trim).filter(|s| !s.is_empty());
        let info = if let Some(custom_url) = trimmed {
            if let Some(local_path) = file_url_to_path(custom_url) {
                let body = fs::read_to_string(&local_path).map_err(|e| {
                    format!(
                        "Failed reading local update manifest {}: {e}",
                        local_path.display()
                    )
                })?;
                parse_any_release_payload(&body)?
            } else if Path::new(custom_url).is_file() {
                let body = fs::read_to_string(custom_url)
                    .map_err(|e| format!("Failed reading update manifest {custom_url}: {e}"))?;
                parse_any_release_payload(&body)?
            } else {
                let client = build_http_client()?;
                let resp = client
                    .get(custom_url)
                    .send()
                    .await
                    .map_err(|e| format!("Update check HTTP request failed: {e}"))?;
                if !resp.status().is_success() {
                    return Err(format!("Update feed returned HTTP {}", resp.status()));
                }
                let body = resp
                    .text()
                    .await
                    .map_err(|e| format!("Failed reading update feed body: {e}"))?;
                parse_any_release_payload(&body)?
            }
        } else {
            let client = build_http_client()?;
            let resp = client
                .get(DEFAULT_MANIFEST_URL)
                .send()
                .await
                .map_err(|e| format!("Default manifest check failed: {e}"))?;
            if resp.status().is_success() {
                let body = resp.text().await.map_err(|e| e.to_string())?;
                parse_release_manifest(&body)?
            } else {
                let gh = client
                    .get(DEFAULT_GITHUB_LATEST_API_URL)
                    .header("Accept", "application/vnd.github+json")
                    .send()
                    .await
                    .map_err(|e| format!("GitHub release check failed: {e}"))?;
                if !gh.status().is_success() {
                    return Err(format!("GitHub releases returned HTTP {}", gh.status()));
                }
                let body = gh.text().await.map_err(|e| e.to_string())?;
                parse_github_release_json(&body)?
            }
        };

        let update_available = is_newer_version(current_version, &info.version);
        Ok((info, update_available))
    }

    pub async fn download_and_verify_asset(
        info: &AvailableUpdateInfo,
        staging_dir: &Path,
    ) -> Result<(PathBuf, String, u64), String> {
        fs::create_dir_all(staging_dir)
            .map_err(|e| format!("Failed creating staging dir {}: {e}", staging_dir.display()))?;
        let filename = info
            .asset_url
            .rsplit('/')
            .next()
            .filter(|s| !s.is_empty())
            .unwrap_or("update_bundle.bin");
        let dest = staging_dir.join(format!("staged_{}_{}", info.version, filename));

        let mut hasher = Sha256::new();
        let size_bytes: u64;

        if let Some(src_path) = file_url_to_path(&info.asset_url) {
            let bytes = fs::read(&src_path).map_err(|e| {
                format!(
                    "Failed reading local update asset {}: {e}",
                    src_path.display()
                )
            })?;
            hasher.update(&bytes);
            size_bytes = bytes.len() as u64;
            fs::write(&dest, &bytes).map_err(|e| format!("Failed writing staged asset: {e}"))?;
        } else if Path::new(&info.asset_url).is_file() {
            let bytes = fs::read(&info.asset_url)
                .map_err(|e| format!("Failed reading asset {}: {e}", info.asset_url))?;
            hasher.update(&bytes);
            size_bytes = bytes.len() as u64;
            fs::write(&dest, &bytes).map_err(|e| format!("Failed writing staged asset: {e}"))?;
        } else {
            let client = build_http_client()?;
            let resp = client
                .get(&info.asset_url)
                .send()
                .await
                .map_err(|e| format!("Asset download failed: {e}"))?;
            if !resp.status().is_success() {
                return Err(format!("Asset download returned HTTP {}", resp.status()));
            }
            let mut file = fs::File::create(&dest)
                .map_err(|e| format!("Failed creating staged file: {e}"))?;
            let mut stream = resp.bytes_stream();
            let mut total = 0u64;
            while let Some(chunk) = stream.next().await {
                let bytes = chunk.map_err(|e| format!("Download stream error: {e}"))?;
                file.write_all(&bytes)
                    .map_err(|e| format!("Disk write error: {e}"))?;
                hasher.update(&bytes);
                total = total.saturating_add(bytes.len() as u64);
            }
            file.sync_all().map_err(|e| e.to_string())?;
            size_bytes = total;
        }

        let actual_sha = format!("{:x}", hasher.finalize());
        if let Some(ref expected) = info.sha256 {
            if !actual_sha.eq_ignore_ascii_case(expected) {
                let _ = fs::remove_file(&dest);
                return Err(format!(
                    "SHA-256 verification failed: expected {expected}, actual {actual_sha}"
                ));
            }
        }
        Ok((dest, actual_sha, size_bytes))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semver_ordering_and_manifest_validation() {
        assert!(is_newer_version("1.2.0", "1.2.1"));
        assert!(is_newer_version("1.2.0-beta.1", "1.2.0"));
        assert!(!is_newer_version("1.2.0", "1.2.0"));
        assert!(!is_newer_version("1.2.0", "1.1.9"));

        let manifest = r#"{
            "version": "v1.3.0",
            "release_notes": "HarmonyOS NEXT release",
            "platforms": {
                "ohos-arm64-v8a": {
                    "zip_url": "https://example.com/harmony-telegram-1.3.0.app",
                    "zip_sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
                    "zip_size": 1024
                }
            }
        }"#;
        let parsed = parse_release_manifest(manifest).expect("valid manifest");
        assert_eq!(parsed.version, "1.3.0");
        assert!(is_newer_version("1.2.0", &parsed.version));
    }
}
