import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { webcrypto } from 'node:crypto';
globalThis.crypto ??= webcrypto; globalThis.window = globalThis;
const bundle = await build({entryPoints:['src/features/sync/linkDiff.ts'],bundle:true,format:'esm',platform:'node',write:false});
const {scanCurrent,newLocalState,noteChange,SYNC_HASH_VERSION,identityPaths,LocalSyncEdit}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
let reads=0; const now=Date.now(); let stat={type:'file',mtime:now-10000,ctime:now-10000,size:3}; let bytes=new TextEncoder().encode('abc');
const adapter={list:async()=>({files:['note.md'],folders:[]}),stat:async()=>({...stat}),readBinary:async()=>{reads++;return bytes.buffer;}};
const state=newLocalState(); const options={cacheEnabled:true};
await scanCurrent(adapter,state,options,()=>true,false); const original=reads;
await scanCurrent(adapter,state,options,()=>true,false);assert.equal(reads,original,'stable cache avoids reads');
state.cache['note.md'].verifiedAt=stat.mtime+100;await scanCurrent(adapter,state,options,()=>true,false);assert.equal(reads,original,'old near-write cache becomes reusable');
stat.mtime=Date.now();state.dirty['note.md']=1;await scanCurrent(adapter,state,options,()=>true,false);const verified=reads;
await scanCurrent(adapter,state,options,()=>true,false,undefined,new Set(['note.md']));assert.equal(reads,verified,'just-verified download is reused');
state.dirty['note.md']=2;bytes=new TextEncoder().encode('xyz');await scanCurrent(adapter,state,options,()=>true,false,undefined,new Set(['note.md']));assert.equal(reads,verified+1,'dirty event overrides verified cache');
// Metadata checks overlap, but content buffers and result ordering stay sequential.
{
  const paths = Array.from({ length: 9 }, (_, index) => `${index}.md`);
  const checked = new Map();
  let activeStats = 0, peakStats = 0, activeReads = 0, peakReads = 0;
  const readOrder = [];
  const batchAdapter = {
    list: async () => ({ files: [...paths].reverse(), folders: [] }),
    stat: async path => {
      activeStats++; peakStats = Math.max(peakStats, activeStats);
      await new Promise(setImmediate);
      activeStats--;
      checked.set(path, (checked.get(path) ?? 0) + 1);
      return { type: 'file', mtime: 1, ctime: 1, size: 3 };
    },
    readBinary: async path => {
      activeReads++; peakReads = Math.max(peakReads, activeReads); readOrder.push(path);
      await new Promise(setImmediate);
      activeReads--;
      return new TextEncoder().encode('abc').buffer;
    }
  };
  const batchState = newLocalState();
  const current = await scanCurrent(batchAdapter, batchState, options, () => true, false);
  assert.equal(peakStats, 1, 'cold reads do not prefetch unused metadata');
  assert.equal(peakReads, 1, 'large file buffers cannot accumulate through concurrent reads');
  assert.deepEqual(readOrder, paths);
  assert.deepEqual(Object.keys(current), paths, 'completion timing cannot reorder the manifest');
  for (const path of paths) assert.equal(checked.get(path), 2, 'every read retains its after-stat guard');
  readOrder.length = 0; peakStats = 0;
  await scanCurrent(batchAdapter, batchState, options, () => true, false);
  assert.equal(peakStats, 4, 'warm metadata checks use a bounded batch');
  assert.deepEqual(readOrder, [], 'batched metadata still reuses validated hashes');
}

// A failed stat must wait for every in-flight check, without starting another batch or reading bytes.
{
  const failure = new Error('metadata failure');
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let settled = false, active = 0, checked = 0, reads = 0;
  const failureState = newLocalState();
  const failurePaths = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'];
  failureState.cache = Object.fromEntries(failurePaths.map(path => [path,
    { sha: 'cached', mode: '100644', mtime: 1, ctime: 1, size: 3, verifiedAt: 1, hashVersion: SYNC_HASH_VERSION }]));
  const cacheBefore = structuredClone(failureState.cache);
  const failureAdapter = {
    list: async () => ({ files: failurePaths, folders: [] }),
    stat: async path => {
      checked++; active++;
      try {
        if (path === 'a.md') throw failure;
        if (path === 'b.md') await pending;
        return { type: 'file', mtime: 1, ctime: 1, size: 3 };
      } finally { active--; }
    },
    readBinary: async () => { reads++; return new ArrayBuffer(3); }
  };
  const scan = scanCurrent(failureAdapter, failureState, options, () => true, false);
  scan.then(() => { settled = true; }, () => { settled = true; });
  await new Promise(setImmediate);
  assert.equal(settled, false, 'failure waits for the pending stat');
  assert.equal(active, 1);
  release();
  await assert.rejects(scan, error => error === failure);
  assert.equal(active, 0, 'no background checks survive rejection');
  assert.equal(checked, 4, 'a failed batch cannot launch the next batch');
  assert.equal(reads, 0);
  assert.deepEqual(failureState.cache, cacheBefore);
  assert.equal(failureState.lastCacheAt, 0);
}

// Prefetched metadata must not bypass changes arriving while an earlier file is read.
for (const change of ['metadata', 'event', 'yield']) {
  const changeState = newLocalState();
  let contents = { 'a.md': 'abc', 'b.md': 'old' }, changeDuringRead = false;
  const mtimes = { 'a.md': 1, 'b.md': 1 };
  const changeAdapter = {
    list: async () => ({ files: Object.keys(contents), folders: [] }),
    stat: async path => ({ type: 'file', mtime: mtimes[path], ctime: 1, size: 3 }),
    readBinary: async path => {
      if (changeDuringRead && path === 'a.md') {
        contents['b.md'] = 'new';
        if (change === 'metadata') mtimes['b.md']++;
        else noteChange(changeState, 'modify', 'b.md');
      }
      return new TextEncoder().encode(contents[path]).buffer;
    }
  };
  const original = await scanCurrent(changeAdapter, changeState, options, () => true, false);
  let progress;
  if (change === 'yield') progress = () => { contents['b.md'] = 'new'; mtimes['b.md']++; };
  else { mtimes['a.md']++; changeDuringRead = true; }
  const changed = await scanCurrent(changeAdapter, changeState, options, () => true, false, progress);
  assert.notEqual(changed['b.md'].sha, original['b.md'].sha, `${change} change cannot reuse stale prefetched metadata`);
}

for (const change of ['metadata', 'event']) {
  const changingState = newLocalState();
  let mtime = 1;
  const changingAdapter = {
    list: async () => ({ files: ['changing.md'], folders: [] }),
    stat: async () => ({ type: 'file', mtime, ctime: 1, size: 3 }),
    readBinary: async () => {
      if (change === 'metadata') mtime++;
      else noteChange(changingState, 'modify', 'changing.md');
      return new TextEncoder().encode('abc').buffer;
    }
  };
  await assert.rejects(scanCurrent(changingAdapter, changingState, options, () => true, false), error => error instanceof LocalSyncEdit);
  assert.deepEqual(changingState.cache, {}, `${change} change cannot populate a cache entry`);
}
console.log('Hash cache reuse, bounded metadata batches, sequential reads and scan-change guards passed');

{
  const files = entries => Object.fromEntries(Object.entries(entries).map(([path, sha]) => [path, { sha, mode: '100644' }]));
  for (const [base, current, records, expected] of [
    [{ a: 'same' }, { b: 'same' }, {}, { a: 'b' }],
    [{ a: 'same', b: 'same' }, { c: 'same' }, {}, { a: null, b: null }],
    [{ a: 'same' }, { b: 'same', c: 'same' }, {}, { a: null }],
    [{ a: 'same' }, { b: 'same' }, { a: null }, { a: null }],
    [{ a: 'same', b: 'same' }, { x: 'same', y: 'same' }, { a: 'x' }, { a: 'x', b: 'y' }],
    [{ a: 'old', b: 'other' }, { a: 'changed', c: 'other' }, {}, { a: 'a', b: 'c' }]
  ]) assert.deepEqual(identityPaths(files(base), files(current), records), expected);
  assert.deepEqual(identityPaths(files({ a: 'same' }), files({ b: 'same' }), {}, false), { a: null });

  const count = 3000;
  let hashReads = 0;
  const entry = sha => ({ get sha() { hashReads++; return sha; }, mode: '100644' });
  const base = {}, current = {};
  for (let index = 0; index < count; index++) {
    base[`old/${index}.md`] = entry(`sha-${index}`);
    current[`new/${index}.md`] = entry(`sha-${index}`);
  }
  const mapping = identityPaths(base, current, {});
  for (let index = 0; index < count; index++) assert.equal(mapping[`old/${index}.md`], `new/${index}.md`);
  assert(hashReads < count * 8, 'large rename matching reads hashes linearly instead of comparing every pair');
}
console.log('Rename hash indexes preserve ambiguous and recorded identities with linear hash access');
