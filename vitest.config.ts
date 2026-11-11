import { defineConfig } from "vitest/config"

// Vitest discovers its config only through a default export.
export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "scripts/**/*.test.ts"],
  },
})
