import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import tsconfigPaths from "vite-tsconfig-paths";
import { VitePWA } from 'vite-plugin-pwa';

const exceljsBareBrowserBuild = fileURLToPath(
  new URL('./node_modules/exceljs/dist/exceljs.bare.min.js', import.meta.url),
);
const dwgviewerEntry = fileURLToPath(
  new URL('../sortsys-dwgviewer/src/index.ts', import.meta.url),
);
const dwgviewerStyles = fileURLToPath(
  new URL('../sortsys-dwgviewer/src/styles.css', import.meta.url),
);
const webappSource = fileURLToPath(
  new URL('.', import.meta.url),
);
const dwgviewerSource = fileURLToPath(
  new URL('../sortsys-dwgviewer', import.meta.url),
);

export default defineConfig({
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [
      { find: /^exceljs$/, replacement: exceljsBareBrowserBuild },
      { find: /^@sortsys\/dwgviewer$/, replacement: dwgviewerEntry },
      { find: /^@sortsys\/dwgviewer\/styles\.css$/, replacement: dwgviewerStyles },
    ],
  },
  server: {
    fs: {
      allow: [webappSource, dwgviewerSource],
    },
  },
  plugins: [
    reactRouter(), tsconfigPaths(),

    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        globIgnores: [
          '**/exceljs*.js',
          '**/jszip*.js',
          '**/editor.main*.js',
          '**/ts.worker*.js',
          '**/sortsys-dwg-rust*.wasm',
        ],
      },
      manifest: {
        "name": "sortsys",
        "short_name": "sortsys",
        "start_url": "/",
        "icons": [
          {
            "src": "/android-chrome-192x192.png",
            "sizes": "192x192",
            "type": "image/png"
          },
          {
            "src": "/android-chrome-512x512.png",
            "sizes": "512x512",
            "type": "image/png"
          },
          {
            "src": "/icon.svg",
            "sizes": "any",
            "type": "image/svg"
          }
        ],
        "theme_color": "#ffffff",
        "background_color": "#ffffff",
        "display": "standalone"
      },
    }),
  ],
});
