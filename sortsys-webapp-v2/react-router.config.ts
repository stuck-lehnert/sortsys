import { resolve } from "node:path";
import type { Config } from "@react-router/dev/config";
import { buildServiceWorker } from "./scripts/buildServiceWorker.ts";

export default {
  ssr: false,

  async buildEnd({ viteConfig }) {
    // React Router writes the rendered shell after the Vite build hooks.
    const outDir = viteConfig.environments.client.build.outDir;
    await buildServiceWorker(resolve(viteConfig.root, outDir));
  },
} satisfies Config;
