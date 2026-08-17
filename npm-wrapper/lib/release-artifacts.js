"use strict";

const PRODUCT = "cli-ck";
const REPO = "cli-ck/cli-ck";

function artifactName({ platform, arch, version }) {
  if (platform === "darwin") {
    return arch === "arm64"
      ? `${PRODUCT}_${version}_aarch64.app.tar.gz`
      : `${PRODUCT}_${version}_x64.app.tar.gz`;
  }
  if (platform === "linux") return `${PRODUCT}_linux_x64.zip`;
  if (platform === "win32") return `${PRODUCT}_windows_x64.zip`;
  return "";
}

function binaryRelPath(platform) {
  if (platform === "darwin") return `${PRODUCT}.app/Contents/MacOS/${PRODUCT}`;
  if (platform === "linux") return PRODUCT;
  if (platform === "win32") return `${PRODUCT}.exe`;
  return "";
}

function downloadUrl({ repo, version, artifact }) {
  return `https://github.com/${repo}/releases/download/v${version}/${artifact}`;
}

module.exports = {
  PRODUCT,
  REPO,
  artifactName,
  binaryRelPath,
  downloadUrl,
};
