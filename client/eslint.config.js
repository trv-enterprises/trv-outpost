import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  // Node config files (vite.config.js, increment-build.js, etc.)
  // run in Node, not the browser. Give them the Node globals so
  // lint doesn't flag __dirname / process / require as undefined.
  {
    files: ['*.config.{js,cjs,mjs}', 'increment-build.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs['recommended-latest'],
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      'no-unused-vars': ['error', {
        varsIgnorePattern: '^(_|[A-Z])',
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      // react-refresh/only-export-components fires on every context
      // file that exports both <Provider> and a useXxx() hook. That's
      // the canonical React pattern for app-wide state and we use it
      // for ~6 contexts. Splitting each into a separate hook file is
      // refactoring busywork. Downgrade to warning so the build
      // doesn't fail; lint-strict still tolerates warnings.
      'react-refresh/only-export-components': 'warn',
    },
  },
])
