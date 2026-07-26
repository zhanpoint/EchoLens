import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      DOUYIN_ACCOUNT_SERVICES_ENABLED: "true",
    },
    exclude: ["**/node_modules/**", "**/.next/**", "**/dist/**"],
    include: ["src/test/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
