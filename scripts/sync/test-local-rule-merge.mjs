import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve, sep } from 'node:path';
import { build } from 'esbuild';

const output = resolve('../../../.codex/output');
await mkdir(output, { recursive: true });
const folder = await mkdtemp(join(output, 'local-rule-merge-'));
try {
  const bundle = join(folder, 'merge.cjs');
  await build({ entryPoints: ['src/features/sync/localRuleMerge.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: bundle });
  const { localRuleMergeTarget } = createRequire(import.meta.url)(bundle);
  const vault = join(folder, 'vault'); await mkdir(vault);
  const git = async (args, stdin) => execFileSync('git', args, { cwd: vault, encoding: 'utf8', input: stdin, windowsHide: true });
  await git(['init', '-q']);
  await git(['config', 'user.name', 'Test']); await git(['config', 'user.email', 'test@example.invalid']);
  await git(['config', 'commit.gpgsign', 'false']);
  await writeFile(join(vault, 'note.md'), 'local');
  await git(['add', '.']); await git(['commit', '-qm', 'base']);
  const base = (await git(['rev-parse', 'HEAD'])).trim();
  const path = '.obsidian/plugins/simple-one/.gitignore';
  await mkdir(join(vault, '.obsidian/plugins/simple-one'), { recursive: true });
  await writeFile(join(vault, path), 'cloud rules');
  await writeFile(join(vault, 'note.md'), 'cloud note');
  await git(['add', '.']); await git(['commit', '-qm', 'remote']);
  const remote = (await git(['rev-parse', 'HEAD'])).trim();
  await git(['reset', '--hard', base]);
  await mkdir(join(vault, '.obsidian/plugins/simple-one'), { recursive: true });
  await writeFile(join(vault, path), 'local rules');
  const index = await git(['ls-files', '--stage']);
  const target = await localRuleMergeTarget(git, remote, [path]);
  assert.equal(await git(['ls-files', '--stage']), index, 'tree repair leaves real index untouched');
  assert.equal(await readFile(join(vault, path), 'utf8'), 'local rules');
  assert.equal((await git(['rev-parse', `${target}^`])).trim(), remote, 'remote history is retained');
  assert.equal((await git(['ls-tree', '-r', '--name-only', target])).trim(), 'note.md');
  assert.equal(await git(['show', `${target}:note.md`]), 'cloud note');
  assert.equal(await localRuleMergeTarget(git, target, [path]), target, 'repair is idempotent');
  assert.equal(await localRuleMergeTarget(git, remote, []), remote);
  await git(['merge', '--no-edit', target]);
  assert.equal(await readFile(join(vault, path), 'utf8'), 'local rules', 'merging retains untracked local rules');
  assert.equal(await readFile(join(vault, 'note.md'), 'utf8'), 'cloud note');
  console.log('Local rule merge: remote ancestry, index preservation, local rule retention and note update passed');
} finally {
  if (!resolve(folder).startsWith(output + sep)) throw Error('Unsafe fixture cleanup');
  await rm(folder, { recursive: true, force: true });
}
