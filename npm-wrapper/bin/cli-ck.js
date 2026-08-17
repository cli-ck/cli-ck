#!/usr/bin/env node

/*
 * cli-ck cross-platform launcher / installer.
 *
 * cli-ck is not code-signed or notarized yet (no paid Apple / Windows certificates
 * during the test phase). Browser-downloaded installers therefore get blocked by
 * Gatekeeper ("cli-ck is damaged") on macOS and SmartScreen on Windows, because the
 * browser tags them with a quarantine flag / Mark-of-the-Web.
 *
 * This launcher sidesteps that entirely: it fetches the release archive over
 * plain HTTPS (Node, not a browser), which never applies those tags. It then
 * installs cli-ck where the OS expects an app to live so it shows up like a normal
 * installed application, and launches it detached so it does not hold the
 * terminal hostage.
 *
 *   cli-ck            download (first run), install, and launch
 *   cli-ck install    download and install only (no launch)
 *   cli-ck uninstall  remove the installed app and cached binaries
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync, execSync } = require('child_process');
const https = require('https');

const VERSION = require('../package.json').version;
const {
  PRODUCT,
  REPO,
  artifactName: resolveArtifactName,
  binaryRelPath: resolveBinaryRelPath,
  downloadUrl,
} = require('../lib/release-artifacts');

const homeDir = os.homedir();
const installDir = path.join(homeDir, `.${PRODUCT}`);
const binDir = path.join(installDir, 'bin', VERSION);

const platform = os.platform();
const arch = os.arch();
const binaryRelPath = resolveBinaryRelPath(platform);
const artifactName = resolveArtifactName({ platform, arch, version: VERSION });

if (!binaryRelPath || !artifactName) {
  console.error(`Unsupported platform: ${platform}`);
  process.exit(1);
}

const binaryPath = path.join(binDir, binaryRelPath);

const argv = process.argv.slice(2);
const subcommand = argv[0];

if (subcommand === 'uninstall') {
  uninstall();
} else if (subcommand === 'install') {
  ensureBinary(() => {
    const target = installDesktop();
    warnLeftoverOz();
    console.log(`\ncli-ck installed: ${target}`);
    console.log('Launch it from your applications menu, or run `cli-ck`.');
    console.log('Remove it any time with `cli-ck uninstall`.');
  });
} else {
  ensureBinary((downloaded) => {
    // Reuse an existing install unless we just pulled a new version.
    const existing = installedTarget();
    const target = !downloaded && existing ? existing : installDesktop();
    warnLeftoverOz();
    launch(target, argv);
  });
}

function warnLeftoverOz() {
  if (platform !== 'darwin') return;
  const leftover = '/Applications/Oz.app';
  if (fs.existsSync(leftover)) {
    console.warn(
      `Note: ${leftover} is still installed from @codecollab.co/oz. Quit that app and delete it so Settings → About is not the old Oz build.`,
    );
  }
}

// ------------------------------------------------------------------ download

function ensureBinary(done) {
  if (fs.existsSync(binaryPath)) {
    done(false);
  } else {
    downloadAndExtract(() => done(true));
  }
}

function downloadAndExtract(done) {
  console.log(`cli-ck v${VERSION} is not downloaded yet. Fetching for ${platform}-${arch}...`);
  fs.mkdirSync(binDir, { recursive: true });

  const url = downloadUrl({ repo: REPO, version: VERSION, artifact: artifactName });
  const archivePath = path.join(binDir, artifactName);
  const file = fs.createWriteStream(archivePath);

  function get(u) {
    https.get(u, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        get(response.headers.location);
        return;
      }
      if (response.statusCode !== 200) {
        console.error(`Failed to download ${artifactName}: HTTP ${response.statusCode}`);
        console.error(`URL: ${url}`);
        console.error(
          'A matching cli-ck GitHub release asset is required. v0.2.5 shipped Oz-branded files, so npm cannot install cli-ck until a newer tagged release publishes cli-ck_* artifacts.',
        );
        process.exit(1);
      }

      const total = parseInt(response.headers['content-length'], 10) || 0;
      let received = 0;
      response.on('data', (chunk) => {
        received += chunk.length;
        if (total > 0) {
          process.stdout.write(`\rDownloading: ${((received / total) * 100).toFixed(1)}%`);
        } else {
          process.stdout.write(`\rDownloading: ${(received / 1024 / 1024).toFixed(2)} MB`);
        }
      });

      response.pipe(file);

      file.on('finish', () => {
        file.close(() => {
          console.log('\nDownload complete. Extracting...');
          try {
            extract(archivePath);
            fs.unlinkSync(archivePath);
            if (platform !== 'win32') {
              fs.chmodSync(binaryPath, 0o755);
            }
            done();
          } catch (err) {
            console.error('Failed to extract files:', err.message);
            process.exit(1);
          }
        });
      });
    }).on('error', (err) => {
      try { fs.unlinkSync(archivePath); } catch {}
      console.error('Download error:', err.message);
      process.exit(1);
    });
  }

  get(url);
}

function extract(archivePath) {
  if (platform === 'darwin') {
    execSync(`tar -xzf "${archivePath}" -C "${binDir}"`);
  } else if (platform === 'linux') {
    execSync(`unzip -o "${archivePath}" -d "${binDir}"`);
  } else if (platform === 'win32') {
    execSync(`powershell -NoProfile -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${binDir}' -Force"`);
  }
}

// ------------------------------------------------------------------- install

function installDesktop() {
  if (platform === 'darwin') return installMac();
  if (platform === 'win32') return installWindows();
  if (platform === 'linux') return installLinux();
  return binaryPath;
}

function installedTarget() {
  if (platform === 'darwin') {
    const inApps = `/Applications/${PRODUCT}.app`;
    const inHome = path.join(homeDir, 'Applications', `${PRODUCT}.app`);
    if (fs.existsSync(inApps)) return inApps;
    if (fs.existsSync(inHome)) return inHome;
    return null;
  }
  if (platform === 'win32') {
    return fs.existsSync(startMenuShortcut()) ? binaryPath : null;
  }
  if (platform === 'linux') {
    return fs.existsSync(linuxDesktopFile()) ? binaryPath : null;
  }
  return binaryPath;
}

// macOS: copy the .app into /Applications (or ~/Applications) so it appears as
// an installed app, strip the quarantine flag, and repair the ad-hoc signature
// if extraction invalidated it (that broken signature is the "damaged" cause).
function installMac() {
  const source = path.join(binDir, `${PRODUCT}.app`);
  if (!fs.existsSync(source)) {
    const leftoverOz = path.join(binDir, 'Oz.app');
    if (fs.existsSync(leftoverOz)) {
      console.error('Downloaded archive still contains Oz.app, not cli-ck.app.');
      console.error('The GitHub release for this version was built before the rename.');
      process.exit(1);
    }
    console.error(`Expected ${source} after extract, but it is missing.`);
    process.exit(1);
  }
  sanitizeMacApp(source);

  const candidates = [
    `/Applications/${PRODUCT}.app`,
    path.join(homeDir, 'Applications', `${PRODUCT}.app`),
  ];

  for (const dest of candidates) {
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.rmSync(dest, { recursive: true, force: true });
      // ditto preserves the bundle structure and code signature; cp/tar can strip it.
      const res = spawnSync('ditto', [source, dest]);
      if (res.status !== 0) throw new Error('ditto failed');
      sanitizeMacApp(dest);
      return dest;
    } catch {
      // try the next location (e.g. /Applications not writable -> ~/Applications)
    }
  }

  // Could not install anywhere writable; run it in place instead.
  return source;
}

function sanitizeMacApp(app) {
  if (!fs.existsSync(app)) return;
  // Remove com.apple.quarantine so Gatekeeper stops blocking the unsigned app.
  spawnSync('xattr', ['-cr', app]);
  // If the ad-hoc signature is missing/broken, re-apply it. arm64 macOS refuses
  // to launch code with an invalid signature and reports it as "damaged".
  const verify = spawnSync('codesign', ['--verify', '--deep', app]);
  if (verify.status !== 0) {
    spawnSync('codesign', ['--force', '--deep', '--sign', '-', app]);
  }
}

function startMenuShortcut() {
  const appData = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'cli-ck.lnk');
}

// Windows: clear any Mark-of-the-Web and drop a Start Menu shortcut so cli-ck is
// discoverable like an installed app.
function installWindows() {
  try {
    spawnSync('powershell', ['-NoProfile', '-Command',
      `Unblock-File -Path '${binaryPath}'`]);
  } catch {}
  try {
    const lnk = startMenuShortcut();
    fs.mkdirSync(path.dirname(lnk), { recursive: true });
    const ps =
      `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${lnk}');` +
      `$s.TargetPath='${binaryPath}';` +
      `$s.WorkingDirectory='${binDir}';` +
      `$s.Description='cli-ck';$s.Save()`;
    spawnSync('powershell', ['-NoProfile', '-Command', ps]);
  } catch {}
  return binaryPath;
}

function linuxDesktopFile() {
  return path.join(homeDir, '.local', 'share', 'applications', 'cli-ck.desktop');
}

// Linux: write a .desktop entry so cli-ck shows up in the application menu.
function installLinux() {
  try {
    const desktopFile = linuxDesktopFile();
    fs.mkdirSync(path.dirname(desktopFile), { recursive: true });
    const entry = [
      '[Desktop Entry]',
      'Type=Application',
      'Name=cli-ck',
      'Comment=AI-native terminal',
      `Exec="${binaryPath}"`,
      'Terminal=false',
      'Categories=Development;Utility;',
    ].join('\n') + '\n';
    fs.writeFileSync(desktopFile, entry);
  } catch {}
  return binaryPath;
}

// -------------------------------------------------------------------- launch

function launch(target, args) {
  if (platform === 'darwin') {
    // `open` hands off to LaunchServices: the app detaches from the terminal,
    // shows in the Dock, and the shell prompt returns immediately.
    const openArgs = [target];
    if (args.length) openArgs.push('--args', ...args);
    const child = spawn('open', openArgs, { detached: true, stdio: 'ignore' });
    child.on('error', (err) => {
      console.error('Failed to launch cli-ck:', err.message);
      process.exit(1);
    });
    child.unref();
    return;
  }

  const child = spawn(target, args, { detached: true, stdio: 'ignore' });
  child.on('error', (err) => {
    console.error('Failed to launch cli-ck:', err.message);
    process.exit(1);
  });
  child.unref();
}

// ----------------------------------------------------------------- uninstall

function uninstall() {
  const removed = [];
  const tryRm = (p) => {
    try {
      if (p && fs.existsSync(p)) {
        fs.rmSync(p, { recursive: true, force: true });
        removed.push(p);
      }
    } catch {}
  };

  if (platform === 'darwin') {
    tryRm(`/Applications/${PRODUCT}.app`);
    tryRm(path.join(homeDir, 'Applications', `${PRODUCT}.app`));
  } else if (platform === 'win32') {
    tryRm(startMenuShortcut());
  } else if (platform === 'linux') {
    tryRm(linuxDesktopFile());
  }
  tryRm(installDir);

  console.log(removed.length
    ? `Removed:\n  ${removed.join('\n  ')}`
    : 'Nothing to remove.');
}
