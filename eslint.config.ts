import { defineConfig, globalIgnores } from 'eslint/config'
import tseslint from 'typescript-eslint'

// Flat ESLint config for a TypeScript library (no Vue SFCs): typescript-eslint's recommended
// rules — the same TypeScript rule set the Vue repos get via @vue/eslint-config-typescript,
// without that preset's Vue-only dependencies.
export default defineConfig(
  // Generated or third-party output is not linted: the declarations, coverage reports and declaration files.
  globalIgnores(['**/dist/**', '**/coverage/**', '**/*.d.ts']),
  {
    // The TypeScript rule set, applied to every TypeScript file.
    name: 'access-gate-client/typescript',
    files: ['**/*.{ts,mts,tsx}'],
    extends: [tseslint.configs.recommended],
  },

  {
    // Repository-specific adjustments to that set.
    name: 'access-gate-client/overrides',
    files: ['**/*.{ts,mts,tsx}'],
    rules: {
      // Underscore-prefixed args/vars are an intentional "unused" marker; rest-sibling
      // destructuring (`const { a, ...rest } = x`) is a legitimate key-omission pattern.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
)
