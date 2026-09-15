// eslint.config.mjs
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
      parserOptions: {
        project: true,
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: ['.json']
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['**/*.config.mjs', 'eslint.config.mjs', 'esbuild.config.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    ignores: ['node_modules/', 'main.js'],
  }
);