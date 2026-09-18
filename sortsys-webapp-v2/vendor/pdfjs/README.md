# PDF.js viewer

`viewer.zip` is Mozilla's official legacy viewer distribution, pinned to the
same version as the `pdfjs-dist` dependency. The legacy build supports browsers
that do not yet implement newer JavaScript APIs.

The Vite plugin verifies its SHA-256 checksum, serves the files during
development, and emits them into the production build. It excludes source maps,
debugging tools and the example PDF. Viewer assets are loaded when a PDF is
opened, not precached by the application's service worker.

To update PDF.js, update the dependency and lockfile, replace `viewer.zip` with
the matching official legacy release, and update `release.json` using the
checksum published by GitHub. Builds reject a version mismatch or invalid
checksum. No download is needed during development or builds.

The archive includes Mozilla's Apache-2.0 license and the separate notices
for fonts, CMaps, color profiles and codecs. They are also included in the
served viewer files.

Upstream: [mozilla/pdf.js](https://github.com/mozilla/pdf.js).
