const fs = require('node:fs');
const path = require('node:path');
const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');
const { execFileSync } = require('node:child_process');

// The tools the macOS installer ships (yt-dlp, ffmpeg, ffprobe, QuickJS),
// assembled by scripts/fetch-tools.mjs. Optional on purpose: without the
// directory `npm run package` still works and the app uses whatever is on PATH,
// which is what a contributor who already has the tools installed wants.
const BUNDLED_TOOLS = path.resolve(__dirname, 'vendor', 'darwin', 'bin');
const bundleTools = process.platform === 'darwin' && fs.existsSync(path.join(BUNDLED_TOOLS, 'versions.json'));

// Developer ID signing + notarization switch on when the credentials are in the
// environment (see the README's "Signing" section) and are otherwise skipped,
// leaving an ad-hoc signed build. NOT exercised yet — there is no Developer ID
// certificate on the machine this was written on.
const SIGN_IDENTITY = process.env.APPLE_SIGNING_IDENTITY;
const notarize = SIGN_IDENTITY && process.env.APPLE_ID && process.env.APPLE_APP_PASSWORD && process.env.APPLE_TEAM_ID;

module.exports = {
  packagerConfig: {
    asar: true,
    // No extension: packager picks icon.icns on macOS (and would pick icon.ico
    // on Windows if one is added). Regenerate with scripts/icon/make-icon.mjs.
    icon: 'assets/icon/icon',
    appBundleId: 'com.theodoreiulian.setengine',
    appCategoryType: 'public.app-category.music',
    appCopyright: `Copyright © ${new Date().getFullYear()} theodoreiulian`,
    // Lands in Contents/Resources/bin. In a universal build both architectures
    // get the same files; @electron/universal sees they are already universal
    // Mach-Os and leaves them alone.
    ...(bundleTools ? { extraResource: [BUNDLED_TOOLS] } : {}),
    ...(SIGN_IDENTITY ? {
      osxSign: {
        identity: SIGN_IDENTITY,
        optionsForFile: () => ({
          hardenedRuntime: true,
          entitlements: path.resolve(__dirname, 'build', 'entitlements.mac.plist'),
        }),
      },
    } : {}),
    ...(notarize ? {
      osxNotarize: {
        appleId: process.env.APPLE_ID,
        appleIdPassword: process.env.APPLE_APP_PASSWORD,
        teamId: process.env.APPLE_TEAM_ID,
      },
    } : {}),
  },
  rebuildConfig: {},
  hooks: {
    // Seal the finished macOS bundle with one ad-hoc signature.
    //
    // Flipping fuses rewrites the Electron binary and so invalidates its
    // signature, and @electron/universal lipo-merges the two architectures
    // without signing the result. An arm64 Mac refuses to launch code with no
    // valid signature at all, so this is what makes the build runnable. (The
    // fuses plugin's own re-sign is switched off below — see there.)
    // Skipped when a real identity is configured (osxSign has already run).
    postPackage: async (_forgeConfig, { platform, outputPaths }) => {
      if (platform !== 'darwin' || SIGN_IDENTITY) return;
      for (const dir of outputPaths) {
        for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.app'))) {
          const app = path.join(dir, name);
          execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
          execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
        }
      }
    },
    // Ship shazamio-core by hand, because nothing else will.
    //
    // The Vite plugin packages only the built bundles and drops node_modules
    // entirely — reasonable, since Vite has already inlined every dependency it
    // can see. shazamio-core is the one it cannot see: signature.js loads it
    // through createRequire *precisely* so Vite leaves it external (its loader
    // does fs.readFileSync(path.join(__dirname, 'shazamio-core_bg.wasm')), which
    // breaks the moment __dirname becomes .vite/build). The two decisions
    // combine badly — the module is external, so it isn't bundled, and
    // node_modules isn't copied, so it isn't shipped either.
    //
    // The failure is quiet and only in packaged builds: `npm start` resolves it
    // from the real node_modules and works, while the .app throws "Couldn't load
    // the Shazam signature module" on the first probe and Set Extraction loses
    // audio recognition altogether. Copying it in before the asar is sealed
    // restores normal resolution (Electron reads the .wasm through asar fine),
    // costs ~3 MB, and needs no change to signature.js.
    packageAfterCopy: async (_forgeConfig, buildPath) => {
      const from = path.resolve(__dirname, 'node_modules', 'shazamio-core');
      const to = path.join(buildPath, 'node_modules', 'shazamio-core');
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.cpSync(from, to, { recursive: true });
    },
  },
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {},
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
    },
    {
      name: '@electron-forge/maker-deb',
      config: {},
    },
    {
      name: '@electron-forge/maker-rpm',
      config: {},
    },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-vite',
      config: {
        // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
        // If you are familiar with Vite configuration, it will look really familiar.
        build: [
          {
            // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
            entry: 'src/main.js',
            config: 'vite.main.config.mjs',
            target: 'main',
          },
          {
            entry: 'src/preload.js',
            config: 'vite.preload.config.mjs',
            target: 'preload',
          },
        ],
        renderer: [
          {
            name: 'main_window',
            config: 'vite.renderer.config.mjs',
          },
        ],
      },
    },
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      // The plugin re-signs ad hoc after flipping fuses, but only for arm64. In
      // a universal build that leaves _CodeSignature files in one half and not
      // the other, and @electron/universal refuses to merge them ("the number of
      // mach-o files is not the same"). The postPackage hook signs the finished
      // bundle instead, for every macOS architecture.
      resetAdHocDarwinSignature: false,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
      // NOTE: This app runs on stock Electron. It previously used the Castlabs
      // fork (electron-releases#…+wvcus) for Widevine DRM, which existed solely
      // to play Spotify inside the embedded browser. The embedded browser was
      // removed in favour of direct URL downloads, so there's no DRM/Widevine
      // requirement anymore — do not reintroduce the fork or a Widevine fuse.
    }),
  ],
};
