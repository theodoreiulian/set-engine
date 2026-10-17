import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  define: {
    // The release manifest this build checks for updates (src/main/app-updater.js).
    // .github/workflows/release.yml sets it; everywhere else it is empty, which
    // turns updating off — a local `npm run install-app` snapshot must not
    // replace itself with whatever master last released.
    SETENGINE_UPDATE_FEED: JSON.stringify(process.env.SETENGINE_UPDATE_FEED || ''),
  },
});
