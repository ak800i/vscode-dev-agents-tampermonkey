const path = require('node:path');
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: path.join(__dirname, 'tests'),
  fullyParallel: true,
  workers: 2,
  timeout: 20_000,
  webServer: {
    command: 'node tests\\server.js',
    url: 'http://127.0.0.1:31137/agents',
    reuseExistingServer: false,
  },
  use: {
    baseURL: 'http://127.0.0.1:31137',
    viewport: { width: 390, height: 844 },
    headless: true,
  },
  projects: [
    { name: 'firefox', timeout: 60_000, use: { browserName: 'firefox' } },
    { name: 'chromium', use: { browserName: 'chromium', hasTouch: true } },
  ],
});
