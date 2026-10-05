import {defineConfig} from "vitest/config";

export default defineConfig({
  test:{
    environment:"jsdom",
    restoreMocks:true,
    // jsdom page tests import and render whole pages; give slow, loaded machines room.
    testTimeout:20_000,
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
