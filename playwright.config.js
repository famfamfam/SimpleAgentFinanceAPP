import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  use: {
    baseURL: process.env.TEST_URL || "http://localhost:18080",
    headless: true,
    viewport: { width: 393, height: 852 },
    hasTouch: true,
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
  reporter: [["list"]],
  outputDir: "test-results",
});
