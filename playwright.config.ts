import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.OPTIONS_TEST_PORT ?? 3142);
const baseURL = 'http://localhost:' + port;

export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: 'work/playwright-results-' + port,
  fullyParallel: true,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: 0,
  use: {
    baseURL,
    trace: 'retain-on-failure',
    launchOptions: { executablePath: process.env.OPTIONS_TEST_CHROMIUM || undefined },
  },
  webServer: {
    command: 'npm run ' + (process.env.OPTIONS_TEST_PRODUCTION === 'true' ? 'start' : 'dev') + ' -- --hostname 127.0.0.1 --port ' + port,
    url: baseURL + '/api/health',
    timeout: 120000,
    reuseExistingServer: false,
    env: { DEMO_MODE: 'true', OPTIONS_DATA_DIR: 'work/e2e-state-' + port, OPTIONS_BUILD_DIR: process.env.OPTIONS_TEST_PRODUCTION === 'true' ? '.next' : 'work/e2e-next-' + port, APP_BASE_URL: baseURL },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
