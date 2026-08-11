import js from '@eslint/js';

/**
 * The plugin ships as plain browser scripts loaded by Super Productivity's
 * renderer — no bundler, no module system. So: script sourceType, browser
 * globals, plus SP's injected `PluginAPI`.
 *
 * Note that the inline <script> in index.html is not covered here (ESLint
 * only parses JS files); Prettier does format it. Keep logic in plugin.js
 * where it can be linted.
 */
export default [
  {
    ignores: ['node_modules/**', '*.zip'],
  },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        // Injected by the Super Productivity plugin host.
        PluginAPI: 'readonly',
        // Browser environment.
        window: 'readonly',
        document: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        URLSearchParams: 'readonly',
        AbortController: 'readonly',
        localStorage: 'readonly',
        navigator: 'readonly',
      },
    },
    rules: {
      // Catch the mistakes that actually bite in this codebase.
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-implicit-globals': 'error',
      'no-throw-literal': 'error',
      'require-atomic-updates': 'off',
      curly: ['error', 'multi-line'],
      // Unused args are often there for signature clarity; allow a leading _.
      'no-unused-vars': [
        'error',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // Formatting is Prettier's job, not ESLint's.
    },
  },
];
