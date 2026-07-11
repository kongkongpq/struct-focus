import tseslint from "@typescript-eslint/eslint-plugin";

export default [
  {
    ignores: [
      "dist/",
      "node_modules/",
      "coverage/",
      "**/*.js",
      "**/*.mjs",
      "**/*.cjs",
      "**/*.config.*",
    ],
  },
  ...tseslint.configs["flat/recommended"],
  {
    files: ["**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      // TS 自身已完成未定义变量检查，关闭基线的 no-undef 以免误报 node 全局
      "no-undef": "off",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-non-null-assertion": "warn",
      "no-console": "off",
      "prefer-const": "error",
      "no-duplicate-imports": "error",
    },
  },
];
