import {defineConfig} from "@playwright/test";
export default defineConfig({
  testDir:"tests/e2e",
  timeout:45_000,
  globalTimeout:180_000,
  retries:1,
  workers:1,
  forbidOnly:true,
  use:{trace:"retain-on-failure"}
});
