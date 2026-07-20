import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    test: {
      name: "context",
      include: ["packages/context/tests/**/*.test.ts"],
      globals: true,
    },
    resolve: {
      alias: {
        "@structfocus/context": new URL("./packages/context/src/index.ts", import.meta.url).pathname,
      },
    },
  },
  {
    test: {
      name: "mcp",
      include: ["packages/mcp/tests/**/*.test.ts"],
      globals: true,
    },
    resolve: {
      alias: {
        "@structfocus/context": new URL("./packages/context/src/index.ts", import.meta.url).pathname,
      },
    },
  },
]);
