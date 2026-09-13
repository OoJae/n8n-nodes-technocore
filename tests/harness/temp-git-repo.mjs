// A throwaway git repository for tests of repository tooling (never shipped).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Runs `fn(repo)` with a fresh `git init` repository in the temp directory and removes it
 * afterwards. `repo.write(relative, content)` writes a file, `repo.git(...args)` runs git.
 * @template T
 * @param {(repo: { root: string, write: (relative: string, content: string | Buffer) => void, git: (...args: string[]) => Buffer }) => T} fn
 * @returns {T}
 */
export function withTempGitRepo(fn) {
	const root = mkdtempSync(path.join(os.tmpdir(), 'tc-git-'));
	try {
		const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
		git('init', '-q');
		const write = (relative, content) => writeFileSync(path.join(root, relative), content);
		return fn({ root, write, git });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}
