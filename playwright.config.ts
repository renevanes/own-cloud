import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "test/browser", workers: 1, fullyParallel: false, timeout: 30_000,
  use: { baseURL: "http://127.0.0.1:4137", browserName: "chromium", headless: true },
  webServer: { command: "npx tsx test/browser/server.ts", url: "http://127.0.0.1:4137/healthz", reuseExistingServer: false, timeout: 30_000 },
});
