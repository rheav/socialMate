import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { stripRegionsPlugin } from "./src/build/stripRegions.js";

export default defineConfig({
  // Separate config from vite.config.js, so the build flag is defined here too.
  define: { __PUBLIC__: JSON.stringify(process.env.PUBLIC === "1") },
  plugins: [stripRegionsPlugin(process.env.PUBLIC === "1")],
  test: { environment: "node", include: ["src/**/*.test.js"] },
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
});
