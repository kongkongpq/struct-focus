import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    test: {
      name: "framework",
      include: ["packages/framework/tests/**/*.test.ts"],
      globals: true,
    },
    resolve: {
      alias: {
        "@struct/framework": new URL("./packages/framework/src/index.ts", import.meta.url).pathname,
      },
    },
  },
  {
    test: {
      name: "memory",
      include: ["packages/memory/tests/**/*.test.ts"],
      globals: true,
    },
    resolve: {
      alias: {
        "@struct/framework": new URL("./packages/framework/src/index.ts", import.meta.url).pathname,
        "@struct/memory": new URL("./packages/memory/src/index.ts", import.meta.url).pathname,
      },
    },
  },
  {
    test: {
      name: "harness",
      include: ["packages/harness/tests/**/*.test.ts"],
      globals: true,
    },
    resolve: {
      alias: {
        "@struct/framework": new URL("./packages/framework/src/index.ts", import.meta.url).pathname,
        "@struct/harness": new URL("./packages/harness/src/index.ts", import.meta.url).pathname,
      },
    },
  },
  {
    test: {
      name: "context",
      include: ["packages/context/tests/**/*.test.ts"],
      globals: true,
    },
    resolve: {
      alias: {
        "@struct/framework": new URL("./packages/framework/src/index.ts", import.meta.url).pathname,
        "@struct/context": new URL("./packages/context/src/index.ts", import.meta.url).pathname,
      },
    },
  },
  {
    test: {
      name: "agent",
      include: ["packages/agent/tests/**/*.test.ts"],
      globals: true,
    },
    resolve: {
      alias: {
        "@struct/framework": new URL("./packages/framework/src/index.ts", import.meta.url).pathname,
        "@struct/memory": new URL("./packages/memory/src/index.ts", import.meta.url).pathname,
        "@struct/harness": new URL("./packages/harness/src/index.ts", import.meta.url).pathname,
        "@struct/context": new URL("./packages/context/src/index.ts", import.meta.url).pathname,
        "struct-agent": new URL("./packages/agent/src/index.ts", import.meta.url).pathname,
      },
    },
  },
]);
