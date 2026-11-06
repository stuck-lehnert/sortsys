import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { gaebLicensePlugin } from "./scripts/licensePlugin";
import { fileURLToPath } from "node:url";
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL("index.html", import.meta.url)),
        editor: fileURLToPath(new URL("src/index.ts", import.meta.url)),
        ...(process.env.SORTSYS_BROWSER_FIXTURES === "1"
          ? {
              takeoff: fileURLToPath(
                new URL("scripts/takeoff.fixture.html", import.meta.url),
              ),
            }
          : {}),
      },
      preserveEntrySignatures: "exports-only",
      output: { entryFileNames: "[name].js" },
    },
  },
  plugins: [tailwindcss(), gaebLicensePlugin()],
  resolve: {
    dedupe: [
      "react",
      "react-dom",
      "@heroui/react",
      "react-aria-components",
      "react-aria",
      "react-stately",
    ],
    alias: {
      "@sortsys/react-components": fileURLToPath(
        new URL("../sortsys-react-components/src/index.js", import.meta.url),
      ),
    },
  },
  worker: { format: "es" },
});
