use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::time::Duration;

use reqwest::header::{ACCEPT_ENCODING, CONTENT_RANGE, RANGE};
use reqwest::redirect::Policy;
use reqwest::{StatusCode, Url};

use super::Failure;

pub(super) fn signed_url(value: &str) -> Option<Url> {
    let url = Url::parse(value).ok()?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.query().is_some()
    {
        return None;
    }
    Some(url)
}

fn exact_range(value: &str, offset: u64, expected: u64) -> bool {
    let Some((start, tail)) = value
        .strip_prefix("bytes ")
        .and_then(|value| value.split_once('-'))
    else {
        return false;
    };
    let Some((end, total)) = tail.split_once('/') else {
        return false;
    };
    start.parse().ok() == Some(offset)
        && end.parse().ok() == expected.checked_sub(1)
        && total.parse().ok() == Some(expected)
}

pub(super) fn download(
    url: &Url,
    mut file: File,
    expected: u64,
    mut progress: impl FnMut(u64),
) -> Result<File, Failure> {
    let mut offset = file
        .metadata()
        .map_err(|_| Failure::StorageUnavailable)?
        .len();
    if offset > expected {
        file.set_len(0).map_err(|_| Failure::StorageUnavailable)?;
        offset = 0;
    }
    progress(offset);
    if offset < expected {
        let origin = url.origin();
        let github_release = url.host_str() == Some("github.com");
        let client = crate::services::system_proxy::blocking_client_builder()
            .map_err(|_| Failure::DownloadFailed)?
            .https_only(true)
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(30 * 60))
            .redirect(Policy::custom(move |attempt| {
                let url = attempt.url();
                let github_asset = github_release
                    && matches!(
                        url.host_str(),
                        Some(
                            "release-assets.githubusercontent.com"
                                | "objects.githubusercontent.com"
                        )
                    );
                if attempt.previous().len() >= 5
                    || url.scheme() != "https"
                    || url.port().is_some()
                    || !url.username().is_empty()
                    || url.password().is_some()
                    || (url.origin() != origin && !github_asset)
                {
                    attempt.error("file runtime redirect is not allowed")
                } else {
                    attempt.follow()
                }
            }))
            .build()
            .map_err(|_| Failure::DownloadFailed)?;
        let mut request = client.get(url.clone()).header(ACCEPT_ENCODING, "identity");
        if offset != 0 {
            request = request.header(RANGE, format!("bytes={offset}-"));
        }
        let mut response = request.send().map_err(|_| Failure::DownloadFailed)?;
        let valid_partial = offset != 0
            && response.status() == StatusCode::PARTIAL_CONTENT
            && response
                .headers()
                .get(CONTENT_RANGE)
                .and_then(|range| range.to_str().ok())
                .is_some_and(|range| exact_range(range, offset, expected))
            && response
                .content_length()
                .is_none_or(|length| length == expected - offset);
        if offset != 0
            && !valid_partial
            && matches!(
                response.status(),
                StatusCode::PARTIAL_CONTENT | StatusCode::RANGE_NOT_SATISFIABLE
            )
        {
            drop(response);
            response = client
                .get(url.clone())
                .header(ACCEPT_ENCODING, "identity")
                .send()
                .map_err(|_| Failure::DownloadFailed)?;
        }
        match response.status() {
            StatusCode::OK => {
                // A server may ignore the Range request. Replace only the unverified
                // download buffer in that case, and keep any installed generation.
                if response
                    .content_length()
                    .is_some_and(|length| length != expected)
                {
                    return Err(Failure::DownloadFailed);
                }
                file.set_len(0).map_err(|_| Failure::StorageUnavailable)?;
                offset = 0;
                progress(offset);
            }
            StatusCode::PARTIAL_CONTENT if valid_partial => {}
            _ => return Err(Failure::DownloadFailed),
        }
        file.seek(SeekFrom::Start(offset))
            .map_err(|_| Failure::StorageUnavailable)?;
        let mut chunk = vec![0_u8; 128 * 1024];
        loop {
            let count = response
                .read(&mut chunk)
                .map_err(|_| Failure::DownloadFailed)?;
            if count == 0 {
                break;
            }
            offset += count as u64;
            if offset > expected {
                return Err(Failure::DownloadFailed);
            }
            file.write_all(&chunk[..count])
                .map_err(|_| Failure::StorageUnavailable)?;
            progress(offset);
        }
        if offset != expected {
            return Err(Failure::DownloadFailed);
        }
        file.sync_all().map_err(|_| Failure::StorageUnavailable)?;
    }
    file.rewind().map_err(|_| Failure::StorageUnavailable)?;
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_exact_resume_ranges_and_private_credential_free_https_are_allowed() {
        assert!(exact_range("bytes 57-99/100", 57, 100));
        for range in [
            "bytes 0-99/100",
            "bytes 57-98/100",
            "bytes 57-99/101",
            "bytes 57-99/*",
        ] {
            assert!(!exact_range(range, 57, 100));
        }
        assert!(signed_url("https://github.com/team/project/asset.zip").is_some());
        for url in [
            "file:///path.zip",
            "http://github.com/release.zip",
            "https://user:password@github.com/release.zip",
            "https://github.com:123/release.zip",
            "https://github.com/release.zip#fragment",
            "https://github.com/release.zip?token=secret",
        ] {
            assert!(signed_url(url).is_none(), "{url}");
        }
    }
}
