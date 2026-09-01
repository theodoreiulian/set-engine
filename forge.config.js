const fs = require('node:fs');
const path = require('node:path');
const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');

module.exports = {
  packagerConfig: {
    asar: true,
  },
  rebuildConfig: {},
  hooks: {
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
