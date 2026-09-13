// File access for repository-level tests (never shipped).
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { PACKAGE_ROOT } from './python.mjs';

export function readRepoFile(relative) {
	return readFileSync(path.join(PACKAGE_ROOT, relative), 'utf8');
}

export function exampleWorkflows() {
	const dir = path.join(PACKAGE_ROOT, 'examples', 'workflows');
	return readdirSync(dir)
		.filter((name) => name.endsWith('.json'))
		.map((name) => ({ name, text: readFileSync(path.join(dir, name), 'utf8') }));
}
