import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir:'tests/e2e',timeout:90000,expect:{timeout:15000},fullyParallel:false,workers:1,
  reporter:[['list'],['html',{outputFolder:'playwright-report',open:'never'}],['json',{outputFile:'artifacts/e2e-results.json'}]],
  use:{baseURL:'http://localhost:8091',actionTimeout:15000,trace:'retain-on-failure',screenshot:'only-on-failure',video:{mode:'on',size:{width:1440,height:1000}}},
  projects:[{name:'chromium',use:{...devices['Desktop Chrome']}}],
  webServer:{command:'pnpm exec tsx ops/test-server.ts',url:'http://localhost:8091/api/health/live',reuseExistingServer:process.env.MOST_E2E_REUSE_SERVER==='true',timeout:600000,stdout:'pipe',stderr:'pipe'},
});
