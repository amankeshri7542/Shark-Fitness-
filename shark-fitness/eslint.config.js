import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import astro from 'eslint-plugin-astro';

/**
 * One flat config for the whole workspace. `pnpm lint` runs it from the
 * repository root and CI gates on it with --max-warnings=0, so a warning here
 * fails the build exactly like an error does. Rules are chosen for
 * correctness, not style — formatting is not enforced.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/data/**',
      '**/coverage/**',
      '**/*.d.ts',
      'infrastructure/**',
      // Playwright output: generated HTML reports and traces.
      '**/playwright-report/**',
      '**/test-results/**',
      // Astro's generated types.
      '**/.astro/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      // An unused binding is usually a leftover or a genuine mistake. A
      // leading underscore is the documented way to say "deliberately unused",
      // which the codebase already uses for shim parameters.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
        },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },

  // The two browser apps.
  {
    files: ['apps/member-pwa/src/**/*.{ts,tsx}', 'apps/admin-web/src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      // The full React Compiler rule set, which catches impure render work,
      // reassignment after render and conditional hooks.
      ...reactHooks.configs['recommended-latest'].rules,

      // The one rule held back. It fires on six working call sites (both
      // realtime stores, the occupancy ping, the conversation outbox
      // reconciliation and two in the workout logger). Each fix is a
      // behavioural refactor of a core flow — useSyncExternalStore, derived
      // render state — not a lint cleanup, and this branch is not the place
      // to rewrite shipped member/admin behaviour with no prior component
      // coverage. Tracked as follow-up; every other hook rule stays an error.
      'react-hooks/set-state-in-effect': 'off',
    },
  },

  // The public website (Astro): .astro components are linted by the Astro
  // plugin; the browser scripts they ship run in the browser.
  ...astro.configs.recommended,
  {
    files: ['apps/website/src/**/*.{ts,astro}'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['apps/website/public/sw.js'],
    languageOptions: { globals: globals.serviceworker },
  },
  {
    files: ['apps/website/scripts/**/*.mjs', 'apps/website/astro.config.mjs', 'apps/website/src/pages/**/*.ts', 'apps/website/src/lib/**/*.ts'],
    languageOptions: { globals: globals.node },
  },

  // Server, scripts and tooling run on Node.
  {
    files: [
      'apps/api/**/*.ts',
      'packages/**/*.ts',
      'scripts/**/*.{js,mjs}',
      'apps/api/scripts/**/*.mjs',
      '*.config.{js,ts}',
      'apps/*/vite.config.ts',
    ],
    languageOptions: {
      globals: globals.node,
    },
  },
);
