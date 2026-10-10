import globals from "globals";

// Apply correctness checks across live code; introduce style rules separately from functional repairs.
const correctnessRules = {
  "no-undef": "error",
  "no-unreachable": "error",
  "no-dupe-args": "error",
  "no-dupe-class-members": "error",
  "no-dupe-keys": "error",
  "no-constant-binary-expression": "error",
  "no-self-assign": "error",
  "no-unexpected-multiline": "error",
  "no-unsafe-finally": "error",
  "no-unsafe-negation": "error",
  "no-invalid-regexp": "error",
  "constructor-super": "error",
  "valid-typeof": "error",
};

export default [
  { ignores: ["**/node_modules/**", "**/__mocks__/**", "dist/**", "**/*.test.js", "**/*.test.jsx", "**/*.test.mjs", "**/*.node-test.js", "**/importTestSupport.js", "functions/testSupport/**"] },
  {
    files: ["src/**/*.{js,jsx}"],
    languageOptions: { ecmaVersion: "latest", sourceType: "module", globals: globals.browser, parserOptions: { ecmaFeatures: { jsx: true } } },
    rules: correctnessRules,
  },
  {
    files: ["functions/**/*.{js,mjs}", "scripts/**/*.{js,mjs}", "src/babel.config.js"],
    languageOptions: { ecmaVersion: "latest", globals: globals.node },
    rules: correctnessRules,
  },
  { files: ["src/babel.config.js"], languageOptions: { sourceType: "commonjs" } },
];
