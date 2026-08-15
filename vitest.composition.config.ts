import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/loader.composition.ts'],
  },
})
