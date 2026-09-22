declare const __SORTSYS_REVISION__: string;

export const BUILD_REVISION = __SORTSYS_REVISION__;
export const BUILD_REVISION_SHORT = BUILD_REVISION.slice(0, 10);
export const SORTSYS_LICENSE = "AGPL-3.0-only";

export const BUILD_REVISION_URL = /^[0-9a-f]{10,40}$/i.test(BUILD_REVISION)
  ? `https://github.com/stuck-lehnert/sortsys/tree/${BUILD_REVISION}`
  : null;
