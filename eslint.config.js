// Flat config (CommonJS: package.json has "type": "commonjs").
// Untyped presets only; the React-Compiler rules of react-hooks 7 stay off.
const { defineConfig, globalIgnores } = require('eslint/config')
const tseslint = require('typescript-eslint')
const reactHooks = require('eslint-plugin-react-hooks')

module.exports = defineConfig([
  globalIgnores([
    'out/**',
    'dist/**',
    'release/**',
    'coverage/**',
    'docs/**',
    'resources/**',
    'native/**',
    '.harness/**'
  ]),
  {
    linterOptions: { reportUnusedDisableDirectives: 'warn' }
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [tseslint.configs.recommended],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }
      ]
    }
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // Changing dependency arrays changes runtime behaviour, so this one only warns.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn'
    }
  }
])
