import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['plugins/severally/dist/', '.work/', '.claude/', 'node_modules/'] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.node } },
    // A leading underscore marks a name kept on purpose (a skipped
    // destructured field, a rest sibling's omitted key).
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true, varsIgnorePattern: '^_' }],
    },
  },
];
