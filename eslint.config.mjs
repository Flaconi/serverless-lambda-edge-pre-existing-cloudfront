import importPlugin from 'eslint-plugin-import'
import prettier from 'eslint-plugin-prettier/recommended'
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript'
import tsESLint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'
import globals from 'globals'
export default defineConfig([
  importPlugin.flatConfigs.recommended,
  prettier,
  tsESLint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.node
      },
      ecmaVersion: 2017,
      sourceType: 'module',
      parserOptions: {}
    },
    settings: {
      'import/resolver': {
        typescript: createTypeScriptImportResolver({
          project: './tsconfig.json'
        })
      }
    },
    rules: {
      'array-bracket-spacing': [
        'error',
        'never',
        {
          objectsInArrays: false,
          arraysInArrays: false
        }
      ],

      'arrow-parens': ['error', 'always'],
      'comma-dangle': ['error', 'never'],
      'func-names': 'off',
      'no-use-before-define': 'off',
      'prefer-destructuring': 'off',
      'no-console': 'error',
      'no-shadow': 'error',
      'no-undef': 'error',
      'object-curly-newline': 'off',
      'no-unused-vars': 'error',
      semi: 'off',
      'object-shorthand': 'off',
      'prettier/prettier': 'error',
      'prefer-const': 'error'
    }
  },
  globalIgnores(['dist/', '.yarn/'])
])
