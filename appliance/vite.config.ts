import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const applianceRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: applianceRoot,
  plugins: [react()],
  publicDir: resolve(applianceRoot, "../public"),
  server: {
    fs: {
      allow: [resolve(applianceRoot, "..")],
    },
  },
  build: {
    outDir: resolve(applianceRoot, "../dist-appliance"),
    emptyOutDir: true,
  },
});
