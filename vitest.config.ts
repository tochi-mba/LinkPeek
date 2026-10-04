import {defineConfig} from "vitest/config";

export default defineConfig({
  test:{
    environment:"jsdom",
    restoreMocks:true,
    clearMocks:true,
    mockReset:true,
    coverage:{
      provider:"v8",
      enabled:false,
      include:["src/**/*.ts"],
      reporter:["text","json"]
    }
  }
});
