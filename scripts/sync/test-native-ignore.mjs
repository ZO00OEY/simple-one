import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve, sep } from 'node:path';
import { build } from 'esbuild';

const output = resolve('../../../.codex/output');
await mkdir(output, { recursive: true });
const folder = await mkdtemp(join(output, 'native-ignore-'));
try {
  const bundle = join(folder, 'native.cjs');
  await build({ entryPoints: ['src/features/sync/nativeIgnore.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: bundle });
  globalThis.window ??= globalThis;
  globalThis.require ??= createRequire(import.meta.url);
  const { inspectIgnoreTracking, applyIgnoreTracking, preserveRootIgnore } = createRequire(import.meta.url)(bundle);
  const vault = join(folder, 'vault');
  await mkdir(vault);
  const calls = [];
  const git = async args => {
    calls.push(args);
    return execFileSync('git', args, { cwd: vault, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  };
  const adapter = {
    exists: async path => { try { await access(join(vault, path)); return true; } catch { return false; } },
    read: async path => readFile(join(vault, path), 'utf8'),
    write: async (path, text) => { await mkdir(join(vault, path, '..'), { recursive: true }); await writeFile(join(vault, path), text); },
    remove: async path => rm(join(vault, path))
  };
  await git(['init', '--quiet']);
  await adapter.write('.gitignore', 'private/\n');
  await adapter.write('private/old.txt', 'keep local');
  await adapter.write('ordinary.md', 'original');
  await git(['add', '-f', '--', '.gitignore', 'private/old.txt', 'ordinary.md']);
  await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
  await adapter.write('private/deleted.txt', 'already removed');
  await git(['add', '-f', '--', 'private/deleted.txt']);
  await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'deleted fixture']);
  await adapter.remove('private/deleted.txt');
  await adapter.write('ordinary.md', 'unrelated staged edit');
  await git(['add', '--', 'ordinary.md']);
  await adapter.write('new.md', 'new allowed note');
  const stagedBefore = await git(['rev-parse', ':ordinary.md']);
  const plan = await inspectIgnoreTracking(adapter, '.obsidian', git);
  assert.deepEqual(plan.paths, ['.gitignore', 'private/old.txt']);
  assert.deepEqual(plan.addPaths, ['new.md']);
  await adapter.write('private/old.txt', 'user staged edit');
  await git(['add', '-f', '--', 'private/old.txt']);
  await assert.rejects(applyIgnoreTracking(adapter, '.obsidian', git, plan), /已有暂存改动/);
  assert.equal(await adapter.read('.gitignore'), plan.originalIgnore, 'conflicting staged changes stop before rewriting rules');
  await git(['reset', '-q', 'HEAD', '--', 'private/old.txt']);
  await adapter.write('private/old.txt', 'keep local');
  const start = calls.length;
  await applyIgnoreTracking(adapter, '.obsidian', git, plan);
  assert.equal(await git(['ls-files', '--', '.gitignore', 'private/old.txt']), '');
  assert.equal((await git(['ls-files', '--', 'new.md'])).trim(), 'new.md');
  assert.equal(await adapter.read('private/old.txt'), 'keep local');
  assert((await git(['ls-files', '--deleted', '--', 'private/deleted.txt'])).includes('private/deleted.txt'), 'ordinary deletion remains for normal sync');
  assert.equal(await git(['rev-parse', ':ordinary.md']), stagedBefore, 'unrelated staged edit survives repair');
  assert(!calls.slice(start).some(args => args[0] === 'rm' && args.includes('.')), 'repair never resets the whole index');
  assert(!calls.some(args => ['push', 'fetch', 'merge'].includes(args[0])));
  const localRules = await adapter.read('.gitignore');
  await assert.rejects(preserveRootIgnore(adapter, git, async () => {
    await adapter.write('.gitignore', 'cloud overwrite\n');
    throw new Error('fixture merge failure');
  }), /fixture merge failure/);
  assert.equal(await adapter.read('.gitignore'), localRules, 'failed merge restores local rules');
  await preserveRootIgnore(adapter, git, async () => adapter.write('.gitignore', 'cloud overwrite\n'));
  assert.equal(await adapter.read('.gitignore'), localRules, 'successful merge restores local rules');
  await adapter.remove('.gitignore');
  await preserveRootIgnore(adapter, git, async () => adapter.write('.gitignore', 'cloud file\n'));
  assert(!await adapter.exists('.gitignore'), 'a missing local rules file stays missing');
  await adapter.write('.gitignore', localRules);
  await git(['add', '-f', '--', '.gitignore']);
  await assert.rejects(preserveRootIgnore(adapter, git, async () => adapter.write('.gitignore', 'cloud file\n')), /远端仍跟踪根/);
  assert.equal(await adapter.read('.gitignore'), localRules, 'tracked-root rejection still restores local rules');
  const taskError = new Error('fixture original merge error');
  await assert.rejects(preserveRootIgnore(adapter, git, async () => { throw taskError; }), error => {
    assert.match(error.message, /fixture original merge error/);
    assert.match(error.message, /远端仍跟踪根/);
    assert.equal(error.errors[0], taskError);
    assert.equal(error.errors.length, 2);
    return true;
  });
  const restoreError = new Error('fixture restore write error');
  const brokenRestore = { ...adapter, write: async () => { throw restoreError; } };
  await assert.rejects(preserveRootIgnore(brokenRestore, git, async () => { throw taskError; }), error => {
    assert.match(error.message, /fixture original merge error/);
    assert.match(error.message, /fixture restore write error/);
    assert.deepEqual(error.errors, [taskError, restoreError]);
    return true;
  });
  await assert.rejects(preserveRootIgnore(brokenRestore, git, async () => 'completed'), error => error === restoreError, 'a restoration failure cannot be hidden by task success');
  console.log('Native ignore: reviewed index delta, unrelated staged changes, local file retention and merge restoration passed');
} finally {
  if (!resolve(folder).startsWith(output + sep)) throw new Error('Unsafe fixture cleanup path');
  await rm(folder, { recursive: true, force: true });
}
