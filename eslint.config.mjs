// ESLint config — deliberately small.
//
// This is NOT a style linter: Prettier owns formatting, and `tseslint.configs.recommended` was
// left off on purpose. On a codebase written without it, "recommended" fires mostly on `any` and
// idioms that are fine here, and a gate that cries wolf gets switched off. Every rule below either
// catches a class of bug that has actually shipped, or encodes an invariant that previously lived
// only in a code comment — which is to say, in a place an agent can edit without ever reading.
//
// If a rule here starts producing false positives, fix or delete it. A lint gate that people learn
// to ignore is worse than no gate.
//
// PRETTIER: this config contains ZERO formatting rules, which is why the two cannot clash. That is
// a property to preserve — do not add `tseslint.configs.stylistic`, `recommended`, or any
// whitespace/quote/semicolon rule here. Formatting is Prettier's job, correctness is ESLint's.
// `npm run verify` runs both and is a fixed point; if you change this, re-check that it still is.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['src/web/dist/**', 'node_modules/**', 'demo/**', 'scripts/**', 'eslint.config.mjs'],
  },
  {
    files: ['src/**/*.ts'],
    extends: [tseslint.configs.base],
    languageOptions: {
      parserOptions: { project: ['./tsconfig.json'], tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // This whole codebase is concurrent async loops sharing one state object. An unawaited
      // promise here does not just lose an error — it reorders writes to that shared state.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
      eqeqeq: ['error', 'smart'],
      'no-restricted-syntax': [
        'error',
        {
          // The concurrency bug: replacing a shared array discards whatever another loop pushed
          // onto the old reference. Splice in place instead.
          selector:
            "AssignmentExpression[left.object.name='state'][left.property.name=/^(mappings|peers|contributors)$/]",
          message:
            'Never reassign state.mappings/peers/contributors — mutate in place (splice/push). Concurrent loops hold the old reference, so a reassignment silently discards their writes.',
        },
        {
          // The drift bug: this predicate was inlined in 11 places and the copies diverged.
          selector: "Literal[value=/@(sidecar|immich-shared-albums)\\.local$/]",
          message:
            'Do not inline the bot email domain. Use UTILITY_EMAIL_DOMAIN / isUtilityEmail from config.ts — inlined copies are how the last naming bug happened.',
        },
        {
          // Same class: a wire constant with four inlined copies and an unused export.
          selector: "Property[key.name='protocol'][value.type='Literal']",
          message:
            'Use PROTOCOL_VERSION from types.ts rather than a literal protocol number.',
        },
      ],
    },
  },
  {
    // The panel is a browser Preact app: its own tsconfig gives it DOM types and the JSX
    // transform, which the server deliberately does not have.
    files: ['src/web/ui/**/*.{ts,tsx}'],
    extends: [tseslint.configs.base],
    languageOptions: {
      parserOptions: { project: ['./src/web/ui/tsconfig.json'], tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      eqeqeq: ['error', 'smart'],
    },
  },
  {
    // config.ts and types.ts are where those single sources of truth are declared.
    files: ['src/config.ts', 'src/types.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    // Tests assert on the literals precisely because production code must not inline them.
    // node:test's `test()` returns a promise that is designed to be left unawaited, so the
    // floating-promise rule is pure noise here — the one exemption, and a deliberate one.
    files: ['src/**/*.test.ts'],
    rules: { 'no-restricted-syntax': 'off', '@typescript-eslint/no-floating-promises': 'off' },
  },
);
