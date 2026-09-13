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
		],
	},
});
