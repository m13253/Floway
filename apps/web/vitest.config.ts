import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // happy-dom provides DOM + EventSource for the dump-subscription
    // composable's tests. Node-env worked while the composable accepted
    // a factory for injection, but that DI surface existed only for the
    // tests — switching env removes the need for it.
    environment: 'happy-dom',
    include: ['src/**/*_test.ts'],
  },
});
