import { isEmbeddedMobileRuntime, openEmbeddedExternalUrl } from "./mobileRuntime";

const RELEASE_API = "https://api.github.com/repos/USA0-Zero/ZeroAgent/releases/latest";
const PREVIEW_RELEASE_API = "https://api.github.com/repos/USA0-Zero/ZeroAgent/releases?per_page=20";
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
  draft?: boolean;
  prerelease?: boolean;
};

export type MobileAppUpdate = {
  currentVersion: string;
  version: string;
  title: string;
  notes: string;
  apkUrl: string;
  releaseUrl: string;
};

type AppVersion = { core: [string, string, string]; prerelease: string[] };

function parseAppVersion(value: string): AppVersion | null {
  const match =
    /^(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(?:\.(0|[1-9]\d*))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      value.trim().replace(/^v/i, ""),
    );
  if (!match) return null;
  const [, major, minor, patch, prereleaseText] = match;
  if (!major) return null;
  const prerelease = prereleaseText?.split(".") ?? [];
  if (prerelease.some((part) => /^0\d+$/.test(part))) return null;
  return { core: [major, minor ?? "0", patch ?? "0"], prerelease };
}

function compareVersionIdentifiers(left: string, right: string) {
  if (left === right) return 0;
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric && left.length !== right.length) {
    return Math.sign(left.length - right.length);
  }
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left < right ? -1 : 1;
}

export function compareAppVersions(left: string, right: string) {
  const leftVersion = parseAppVersion(left);
  const rightVersion = parseAppVersion(right);
  if (!leftVersion || !rightVersion) throw new Error("应用版本号无效");
  for (let index = 0; index < 3; index += 1) {
    const difference = compareVersionIdentifiers(leftVersion.core[index], rightVersion.core[index]);
    if (difference !== 0) return difference;
  }
  if (!leftVersion.prerelease.length || !rightVersion.prerelease.length) {
    return Number(!leftVersion.prerelease.length) - Number(!rightVersion.prerelease.length);
  }
  const length = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftVersion.prerelease[index];
    const rightPart = rightVersion.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    const difference = compareVersionIdentifiers(leftPart, rightPart);
    if (difference !== 0) return difference;
  }
  return 0;
}

export async function checkMobileAppUpdate(): Promise<MobileAppUpdate | null> {
  if (!isEmbeddedMobileRuntime()) return null;
  const currentVersion = parseAppVersion(MOBILE_APP_VERSION);
  if (!currentVersion) throw new Error("当前应用版本号无效");
  const includePrerelease = currentVersion.prerelease.length > 0;
  const response = await fetch(includePrerelease ? PREVIEW_RELEASE_API : RELEASE_API, {
    cache: "no-store",
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok) {
    throw new Error(`检查更新失败 (${response.status})`);
  }
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object" || Array.isArray(payload) !== includePrerelease) {
    throw new Error("发布版本信息无效");
  }
  const releases = (includePrerelease ? payload : [payload]) as GithubRelease[];
  let hasValidVersion = false;
  let next: { release: GithubRelease; version: string } | undefined;
  for (const release of releases) {
    const version =
      typeof release?.tag_name === "string" ? release.tag_name.trim().replace(/^v/i, "") : "";
    const parsed = parseAppVersion(version);
    if (!parsed) continue;
    hasValidVersion = true;
    if (release.draft || (!includePrerelease && (release.prerelease || parsed.prerelease.length)))
      continue;
    if (compareAppVersions(version, MOBILE_APP_VERSION) <= 0) continue;
    if (!next || compareAppVersions(version, next.version) > 0) next = { release, version };
  }
  if (releases.length && !hasValidVersion) throw new Error("发布版本信息无效");
  if (!next) return null;
  const { release, version } = next;
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
