import { isEmbeddedMobileRuntime, openEmbeddedExternalUrl } from "./mobileRuntime";

const RELEASE_API = "https://api.github.com/repos/USA-Zero/ZeroAgent/releases/latest";
const ANDROID_APK_SUFFIX = "Android-arm64.apk";

export const MOBILE_UPDATE_CHECK_EVENT = "zeroagent:mobile-update-check";
export const MOBILE_APP_VERSION = __ZEROAGENT_APP_VERSION__;

type GithubReleaseAsset = {
  name?: string;
  browser_download_url?: string;
};

type GithubRelease = {
  tag_name?: string;
  name?: string;
  body?: string;
  html_url?: string;
  assets?: GithubReleaseAsset[];
};

export type MobileAppUpdate = {
  currentVersion: string;
  version: string;
  title: string;
  notes: string;
  apkUrl: string;
  releaseUrl: string;
};

function versionParts(value: string) {
  const normalized = value.trim().replace(/^v/i, "").split("-", 1)[0];
  return normalized.split(".").map((part) => Number.parseInt(part, 10) || 0);
}

export function compareAppVersions(left: string, right: string) {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export async function checkMobileAppUpdate(): Promise<MobileAppUpdate | null> {
  if (!isEmbeddedMobileRuntime()) return null;
  const response = await fetch(RELEASE_API, {
    cache: "no-store",
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok) {
    throw new Error(`检查更新失败 (${response.status})`);
  }
  const release = (await response.json()) as GithubRelease;
  const version = release.tag_name?.trim().replace(/^v/i, "") ?? "";
  if (!version || compareAppVersions(version, MOBILE_APP_VERSION) <= 0) return null;
  const asset = release.assets?.find(
    (candidate) =>
      candidate.name?.endsWith(ANDROID_APK_SUFFIX) &&
      candidate.browser_download_url?.startsWith("https://github.com/"),
  );
  if (!asset?.browser_download_url) {
    throw new Error("新版本尚未提供 Android arm64 安装包");
  }
  return {
    currentVersion: MOBILE_APP_VERSION,
    version,
    title: release.name?.trim() || `ZeroAgent v${version}`,
    notes: release.body?.trim() || "本次更新包含稳定性与体验改进。",
    apkUrl: asset.browser_download_url,
    releaseUrl: release.html_url?.trim() || asset.browser_download_url,
  };
}

export function requestMobileAppUpdateCheck() {
  if (!isEmbeddedMobileRuntime()) return;
  window.dispatchEvent(new Event(MOBILE_UPDATE_CHECK_EVENT));
}

export async function downloadMobileAppUpdate(update: MobileAppUpdate) {
  await openEmbeddedExternalUrl(update.apkUrl);
}
