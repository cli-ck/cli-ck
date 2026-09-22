export type GithubReleaseAsset = {
  name: string;
  browser_download_url: string;
};

export type GithubRelease = {
  tag_name: string;
  body?: string;
  html_url: string;
  draft: boolean;
  assets: GithubReleaseAsset[];
};

export type BetaRelease = {
  version: string;
  body: string;
  releaseUrl: string;
  downloadUrl: string;
};

function parseVersion(version: string): number[] {
  return version
    .replace(/^v/, "")
    .split("-")[0]
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
}

export function isNewer(remote: string, current: string): boolean {
  const remoteParts = parseVersion(remote);
  const currentParts = parseVersion(current);
  const length = Math.max(remoteParts.length, currentParts.length);
  for (let index = 0; index < length; index++) {
    const remotePart = remoteParts[index] ?? 0;
    const currentPart = currentParts[index] ?? 0;
    if (remotePart !== currentPart) return remotePart > currentPart;
  }
  return false;
}

function betaAsset(
  assets: GithubReleaseAsset[],
  platform: string,
  architecture: string,
): GithubReleaseAsset | undefined {
  if (platform === "macos") {
    return assets.find((asset) =>
      architecture === "aarch64"
        ? asset.name.endsWith("_aarch64.dmg")
        : asset.name.endsWith("_x64.dmg"),
    );
  }
  if (platform === "windows") {
    return assets.find((asset) => asset.name.endsWith("_x64-setup.exe"));
  }
  if (platform === "linux") {
    return assets.find((asset) => asset.name.endsWith(".AppImage"));
  }
  return undefined;
}

export function selectBetaRelease(
  releases: GithubRelease[],
  currentVersion: string,
  platform: string,
  architecture: string,
): BetaRelease | null {
  const release = releases.find(
    (candidate) =>
      !candidate.draft &&
      /-beta$/.test(candidate.tag_name) &&
      isNewer(candidate.tag_name, currentVersion),
  );
  if (!release) return null;

  return {
    version: release.tag_name.replace(/^v/, ""),
    body: release.body ?? "",
    releaseUrl: release.html_url,
    downloadUrl:
      betaAsset(release.assets, platform, architecture)?.browser_download_url ??
      release.html_url,
  };
}
