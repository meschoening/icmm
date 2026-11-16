import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const { version } = JSON.parse(readFileSync(new URL("package.json", import.meta.url), "utf8")) as {
  version: string;
};

// These .ts suites exercise the browser or Tauri's window-backed IPC mocks. Other .ts suites
// test models and calculations; they need neither jsdom nor the React test setup.
const browserTests = [
  "src/theme.test.ts",
  "src/connection/useNow.test.ts",
  "src/wire/api.test.ts",
  "src/shell/systemMenus.test.ts",
];

// The hang detector, and the suite's one clock: no test fails for being slow (ADR-0022), so a test
// that runs this long has hung. `ICMM_TEST_HANG_S=5` shortens it for a run you expect to fail.
const HANG_MS = Number(process.env.ICMM_TEST_HANG_S ?? 600) * 1000;

export default defineConfig({
  plugins: [react()],
  // The app's version, which `tests/test_manifests.py` keeps equal across its manifests.
  define: { __APP_VERSION__: JSON.stringify(version) },
  clearScreen: false,
  // Tauri's devUrl points here.
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  // The oldest WebView ICMM supports: Safari 16.4 on macOS 13.3.
  build: { target: "safari16.4" },
  test: {
    // CI's runners share their machine with each other and with desktop apps.
    maxWorkers: process.env.CI ? 2 : undefined,
    testTimeout: HANG_MS,
    hookTimeout: HANG_MS,
    // For Testing Library's waits (`src/test-setup.ts`).
    env: { ICMM_TEST_HANG_MS: String(HANG_MS) },
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.ts"],
          exclude: browserTests,
        },
      },
      {
        extends: true,
        test: {
          name: "dom",
          environment: "jsdom",
          include: ["src/**/*.test.tsx", ...browserTests],
          setupFiles: ["src/test-setup.ts"],
        },
      },
    ],
    // The app's own sheets, which `src/styles/styles.test.tsx` reads as text; other CSS stays empty.
    css: { include: [/\/src\/styles\/[^/]+\.css/] },
  },
});
