// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'public/bundle.js*', 'data/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        // Type-aware linting scoped to the two project tsconfigs (backend + frontend).
        project: ['./tsconfig.json', './frontend/tsconfig.json'],
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'warn',
      'no-console': 'off',
    },
  },
  {
    files: ['test/**/*.ts', '*.config.ts', '*.config.mjs', 'esbuild.config.mjs'],
    languageOptions: {
      parserOptions: {
        project: null,
      },
    },
  },
  {
    files: ['esbuild.config.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
      },
    },
  },
);
