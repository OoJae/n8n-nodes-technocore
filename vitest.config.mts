import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: 'unit',
					include: ['tests/unit/**/*.test.ts'],
					testTimeout: 20_000,
				},
			},
			{
				test: {
					name: 'crosscheck',
					include: ['tests/crosscheck/**/*.test.ts'],
					testTimeout: 120_000,
				},
			},
			{
				test: {
					name: 'integration',
					include: ['tests/integration/**/*.test.ts'],
					testTimeout: 180_000,
					hookTimeout: 120_000,
					fileParallelism: false,
				},
			},
			{
				test: {
					// Real n8n; opt-in (npm run test:e2e), needs N8N_E2E_NODE and N8N_E2E_N8N_BIN.
					name: 'e2e',
					include: ['tests/e2e/**/*.test.ts'],
					testTimeout: 300_000,
					hookTimeout: 300_000,
					fileParallelism: false,
				},
			},
		],
	},
});
