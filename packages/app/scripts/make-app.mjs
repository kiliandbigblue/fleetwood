/**
 * Build Fleetwood.app from the local Electron bundle.
 *
 * Why not @electron/packager or electron-builder: both extract the Electron zip
 * with extract-zip, which silently fails on this machine — it produces a 14MB
 * "dist" containing only a licence file and exits 0. (The same failure blocks
 * `electron`'s own postinstall; see the README.) Since node_modules already holds
 * a correctly extracted Electron.app, assembling the bundle directly is both
 * fewer moving parts and immune to that bug.
 *
 * An Electron app bundle is just Electron.app with the executable renamed, the
 * Info.plist rewritten, and your code dropped into Contents/Resources/app.
 */
import { createRequire } from 'node:module';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';

const APP_ROOT = join(import.meta.dirname, '..');
const OUT_DIR = join(APP_ROOT, 'release');
const APP_NAME = 'Fleetwood';
const BUNDLE_ID = 'dev.kiliand.fleetwood';
const APP_PATH = join(OUT_DIR, `${APP_NAME}.app`);

const require = createRequire(import.meta.url);
const electronDist = join(dirname(require.resolve('electron')), 'dist');
const sourceApp = join(electronDist, 'Electron.app');

if (!existsSync(join(sourceApp, 'Contents', 'MacOS', 'Electron'))) {
  console.error(`No usable Electron at ${sourceApp}`);
  console.error('Extract it manually (extract-zip is broken here):');
  console.error('  ZIP=$(find ~/Library/Caches/electron -name "*.zip" -type f | head -1)');
  console.error(`  rm -rf "${electronDist}" && mkdir -p "${electronDist}" && unzip -q "$ZIP" -d "${electronDist}"`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(APP_ROOT, 'package.json'), 'utf8'));

if (!existsSync(join(APP_ROOT, 'dist', 'main', 'index.cjs'))) {
  console.error('dist/main/index.cjs missing — run `pnpm build` first.');
  process.exit(1);
}

console.log(`Copying Electron from ${sourceApp}`);
rmSync(APP_PATH, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });
// verbatimSymlinks keeps the framework symlinks intact; dereferencing them
// doubles the size and breaks code signing.
cpSync(sourceApp, APP_PATH, { recursive: true, verbatimSymlinks: true });

const contents = join(APP_PATH, 'Contents');
const resources = join(contents, 'Resources');

// Rename the executable to the product name — this is what shows in the menu bar
// and in Activity Monitor.
const oldBinary = join(contents, 'MacOS', 'Electron');
const newBinary = join(contents, 'MacOS', APP_NAME);
cpSync(oldBinary, newBinary);
rmSync(oldBinary, { force: true });
execFileSync('chmod', ['+x', newBinary]);

// Electron loads default_app.asar when no app is present; ours must win.
rmSync(join(resources, 'default_app.asar'), { force: true });

// Ship the code unpacked rather than as an asar: the hook scripts have to be
// real, executable files on disk, and there is nothing here worth hiding.
const appDir = join(resources, 'app');
rmSync(appDir, { recursive: true, force: true });
mkdirSync(appDir, { recursive: true });
cpSync(join(APP_ROOT, 'dist'), join(appDir, 'dist'), { recursive: true });
writeFileSync(
  join(appDir, 'package.json'),
  `${JSON.stringify(
    {
      name: pkg.name,
      productName: APP_NAME,
      version: pkg.version,
      description: pkg.description,
      // Dependencies are bundled into dist by esbuild, so none are declared.
      main: 'dist/main/index.cjs',
    },
    null,
    2,
  )}\n`,
);
execFileSync('chmod', ['-R', '+x', join(appDir, 'dist', 'hooks')]);

// Icon
const icns = join(APP_ROOT, 'build', 'icon.icns');
if (existsSync(icns)) {
  cpSync(icns, join(resources, 'fleetwood.icns'));
  rmSync(join(resources, 'electron.icns'), { force: true });
}

const plist = join(contents, 'Info.plist');
const setPlist = (key, value, type = 'string') => {
  try {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist], { stdio: 'pipe' });
  } catch {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} ${type} ${value}`, plist], { stdio: 'pipe' });
  }
};

setPlist('CFBundleName', APP_NAME);
setPlist('CFBundleDisplayName', APP_NAME);
setPlist('CFBundleExecutable', APP_NAME);
setPlist('CFBundleIdentifier', BUNDLE_ID);
setPlist('CFBundleIconFile', 'fleetwood');
setPlist('CFBundleShortVersionString', pkg.version);
setPlist('CFBundleVersion', pkg.version);
setPlist('LSApplicationCategoryType', 'public.app-category.developer-tools');
// Nothing here needs to talk to the network directly.
setPlist('NSHumanReadableCopyright', `'${APP_NAME}'`);

// Re-sign: on Apple silicon a modified bundle will not launch without a valid
// signature, and ad-hoc (`-`) is enough for something built and run locally.
console.log('Signing ad-hoc');
execFileSync('codesign', ['--force', '--deep', '--sign', '-', APP_PATH], { stdio: 'inherit' });
execFileSync('codesign', ['--verify', '--deep', '--strict', APP_PATH], { stdio: 'inherit' });

console.log(`\nBuilt ${APP_PATH}`);
