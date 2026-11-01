import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve, sep } from 'node:path';
import vm from 'node:vm';
import { build } from 'esbuild';

const artifacts = resolve('../../../.codex/output');
await mkdir(artifacts, { recursive: true });
const root = await mkdtemp(join(artifacts, 'simple-one-direct-'));
const run = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore','pipe','pipe'] }).trim();
try {
  const local = join(root, 'local'), a = join(root, 'a.git'), b = join(root, 'b.git');
  await mkdir(local);
  run(root, ['init', '--bare', a]); run(root, ['init', '--bare', b]);
  run(local, ['init', '-b', 'main']);
  run(local, ['config', 'user.name', 'Test']); run(local, ['config', 'user.email', 'test@example.invalid']);
  const rulesBundle = join(root, 'rules.cjs');
  await build({ entryPoints: ['src/features/sync/localIgnore.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: rulesBundle });
  const { organizedLocalIgnore } = createRequire(import.meta.url)(rulesBundle);
  const localRules = organizedLocalIgnore('', '.obsidian');
  await writeFile(join(local, '.gitignore'), localRules);
  await writeFile(join(local, 'note.md'), 'first');
  run(local, ['add', '.']); run(local, ['commit', '-m', 'first']);
  run(local, ['remote', 'add', 'origin', a]);
  run(local, ['push', '-u', 'origin', 'HEAD:main']);
  run(local, ['push', b, 'HEAD:main']);
  const first = run(local, ['rev-parse', 'HEAD']);
  const config = await readFile(join(local, '.git/config'), 'utf8');
  const output = await build({ entryPoints: ['src/features/sync/index.ts'], bundle: true, platform: 'browser', format: 'cjs', external: ['obsidian'], write: false, loader: { '.png':'dataurl' } });
  const obsidian = new Proxy({ Platform: { isMobile:false } }, { get: (o,k) => k in o ? o[k] : function() {} });
  const context = vm.createContext({ module: {exports:{}}, require:()=>obsidian, console, crypto:globalThis.crypto, TextEncoder, Uint8Array, setTimeout, clearTimeout });
  context.window=context; vm.runInContext(output.outputFiles[0].text, context);
  const sync=Object.create(context.module.exports.default.prototype);
  const syncCommands = [];
  Object.assign(sync, { settings:{gitRemoteUrl:b,gitBranch:'main',gitAuthorName:'Test',gitAuthorEmail:'test@example.invalid'}, desktopGitTrace:[],
    host: { app: { vault: { configDir: '.obsidian', adapter: {
      exists: async path => { try { await access(join(local, path)); return true; } catch { return false; } },
      read: async path => readFile(join(local, path), 'utf8'),
      write: async (path, text) => writeFile(join(local, path), text),
      remove: async path => rm(join(local, path))
    } } } },
    exec:async(_program,args)=>{ syncCommands.push(Array.from(args)); return run(local,Array.from(args)); }, ensureNormalGitState:async()=>{}, setSyncActivity:()=>{}, setStatus:()=>{},
    traceDesktopGitStep:async(_name,fn)=>fn(), saveSettings:async()=>{}, clearDesktopPushRetry:()=>{}, refreshSyncView:async()=>{} });
  await writeFile(join(local, '.gitignore'), 'unmigrated/\n');
  await assert.rejects(sync.desktopFetchAndMerge(), /重建忽略规则/);
  assert(!syncCommands.some(args => args[0] === 'fetch'), 'unconfirmed rules stop before fetching');
  await writeFile(join(local, '.gitignore'), localRules);
  run(local, ['add', '-f', '--', '.gitignore']);
  await assert.rejects(sync.desktopFetchAndMerge(), /排除文件受到 Git 追踪/);
  assert(!syncCommands.some(args => args[0] === 'fetch'), 'tracked excluded paths stop before fetching');
  run(local, ['rm', '--cached', '--', '.gitignore']);
  await sync.desktopFetchAndMerge();
  assert.equal(await readFile(join(local, '.gitignore'), 'utf8'), localRules);
  assert.equal(run(local, ['ls-files', '--', '.gitignore']), '', 'root rules remain local');
  assert.equal(await sync.getUnpushedCommitWindow(),null);
  await writeFile(join(local,'note.md'),'second');run(local,['add','.']);run(local,['commit','-m','second']);
  const second=run(local,['rev-parse','HEAD']);
  assert(await sync.getUnpushedCommitWindow());
  await sync.desktopPushOnly(false);
  assert.equal(run(root,['--git-dir',a,'rev-parse','main']),first,'origin A is untouched');
  assert.equal(run(root,['--git-dir',b,'rev-parse','main']),second,'configured B receives commit');
  assert.equal(await sync.getUnpushedCommitWindow(),null,'push updates plugin snapshot');
  assert.equal((await sync.getPendingUploadChanges()).length,0);
  assert.equal(run(local,['rev-parse','refs/remotes/origin/main']),first,'user tracking ref unchanged');
  assert.equal(await readFile(join(local,'.git/config'),'utf8'),config,'remote/upstream config unchanged');
  sync.settings.gitBranch='other';
  assert(await sync.getUnpushedCommitWindow(),'different branch cannot reuse main snapshot');
  sync.settings.gitBranch='main';sync.settings.gitRemoteUrl=a;
  assert(await sync.getUnpushedCommitWindow(),'different repository cannot reuse B snapshot');
  // URL equal to origin must not opportunistically update user remote-tracking refs.
  run(root,['--git-dir',a,'fetch',b,'main:refs/heads/main']);
  await sync.desktopFetchAndMerge();
  assert.equal(run(local,['rev-parse','refs/remotes/origin/main']),first);
  assert.equal(await readFile(join(local,'.git/config'),'utf8'),config);
  // A deleted remote branch invalidates the cached baseline.
  run(root,['--git-dir',a,'update-ref','-d','refs/heads/main']);
  await sync.desktopFetchAndMerge();
  assert(await sync.getUnpushedCommitWindow());
  console.log('Direct URL sync: target isolation, unchanged config/tracking, pending changes, branch/repo switch and deletion passed.');
} finally {
  if(!resolve(root).startsWith(artifacts+sep)) throw Error('unsafe fixture path');
  await rm(root,{recursive:true,force:true});
}
