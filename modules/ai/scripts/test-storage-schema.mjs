import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const result = await build({ stdin: { contents: `export * from './src/agent/storage'; export * from './src/agent/storageSchema'; export * from './src/agent/types'; export * from './src/agent/runtime';`, resolveDir: root }, bundle: true, write: false, format: 'cjs', platform: 'browser', external: ['obsidian'] });
const context = vm.createContext({ module: { exports: {} }, require: () => ({ Notice: class {}, TFile: class {}, TFolder: class {} }), crypto: webcrypto, console, TextEncoder, AbortController });
vm.runInContext(result.outputFiles[0].text, context);
const { SessionStore, newState, newSession, decodeSession, decodeMemory, decodePrivateState, AgentRuntime } = context.module.exports;
function fixture() {
  const disk = new Map(), mutations = [];
  const adapter = { exists: async p => disk.has(p), read: async p => disk.get(p), mkdir: async p => { mutations.push(p); disk.set(p, ''); }, write: async (p, v) => { mutations.push(p); disk.set(p, v); }, remove: async p => { mutations.push(p); disk.delete(p); }, list: async p => ({ files: [...disk.keys()].filter(k => k.startsWith(p + '/') && !k.slice(p.length + 1).includes('/')), folders: [] }) };
  const state = newState(), session = newSession(null); state.sessions = [session]; state.active = session.id;
  session.messages = [{ role: 'user', text: 'preserve me', images: [{ name: 'x', mime: 'image/png', id: 'image-1' }] }];
  disk.set('private/index.json', JSON.stringify({ version: 2, sessions: [session.id], active: session.id, futureIndex: { keep: true } }));
  disk.set('private/memory.json', JSON.stringify(state.memory));
  const path = 'private/sessions/' + session.id + '.json';
  disk.set(path, JSON.stringify(session)); disk.set('private/images/image-1.txt', 'BASE64');
  return { disk, mutations, adapter, state, session, path, store: new SessionStore(adapter, 'private') };
}
let count = 0;
async function check(name, fn) { await fn(); count++; console.log('PASS ' + name); }
await check('Structural corruption in every collection falls back and first save preserves good recovery', async () => {
  for (const corrupt of [s => { s.images = {}; }, s => { s.messages[0].images = [null]; }, s => { s.messages[0].files = ['x']; }, s => { s.messages[0].calls = [{ id: 'c', name: 'tool', arguments: [] }]; }, s => { s.changes = [null]; }, s => { s.messages = 'lost'; }]) {
    const e = fixture(), good = e.disk.get(e.path), bad = JSON.parse(good); corrupt(bad);
    e.disk.set(e.path + '.previous', good); e.disk.set(e.path, JSON.stringify(bad));
    const loaded = await e.store.load(); assert.equal(loaded.sessions[0].messages[0].text, 'preserve me');
    assert.equal(e.mutations.length, 0); loaded.sessions[0].draft = 'saved after recovery'; await e.store.save(loaded);
    assert.equal(e.disk.get(e.path + '.previous'), good); assert(e.disk.has('private/images/image-1.txt'));
  }
});
await check('Both structurally bad copies preserve all disk bytes and attachments', async () => {
  for (const target of ['session', 'index', 'memory']) {
    const e = fixture(), path = target === 'session' ? e.path : 'private/' + target + '.json';
    const bad = target === 'session' ? { ...e.session, messages: [null] } : target === 'index' ? { version: 2, sessions: ['../escape'] } : { ...e.state.memory, summaries: [] };
    e.disk.set(path, JSON.stringify(bad)); e.disk.set(path + '.previous', JSON.stringify(bad));
    const before = [...e.disk]; await assert.rejects(e.store.load()); assert.deepEqual([...e.disk], before); assert.equal(e.mutations.length, 0);
  }
});
await check('Invalid index IDs and memory versions use validated previous copies', async () => {
  for (const target of ['index', 'memory']) {
    const e = fixture(), path = 'private/' + target + '.json', good = e.disk.get(path), bad = JSON.parse(good);
    if (target === 'index') bad.sessions = [4]; else bad.versions = [{ path: 'a', before: null, after: '' }];
    e.disk.set(path + '.previous', good); e.disk.set(path, JSON.stringify(bad)); const loaded = await e.store.load();
    await e.store.save(loaded); assert.equal(e.disk.get(path + '.previous'), good);
  }
});
await check('Historical optional fields and unknown new fields round trip', async () => {
  const e = fixture(), raw = JSON.parse(e.disk.get(e.path));
  for (const key of ['files', 'references', 'draftSkills', 'archivedAt', 'pinned', 'historyEdited', 'permission']) delete raw[key];
  raw.futureSession = { value: 1 }; raw.messages[0].futureMessage = ['keep'];
  e.disk.set(e.path, JSON.stringify(raw)); const loaded = await e.store.load(); await e.store.save(loaded);
  const saved = JSON.parse(e.disk.get(e.path)); assert.deepEqual(saved.futureSession, { value: 1 }); assert.deepEqual(saved.messages[0].futureMessage, ['keep']);
  assert.deepEqual(JSON.parse(e.disk.get('private/index.json')).futureIndex, { keep: true });
});
await check('Critical missing arrays and invalid enums are rejected instead of erased', () => {
  const e = fixture();
  for (const key of ['images', 'changes', 'messages']) { const raw = { ...e.session }; delete raw[key]; assert.throws(() => decodeSession(raw)); }
  assert.throws(() => decodeMemory({ summaries: {}, versions: null }));
  assert.throws(() => decodeMemory({ summaries: { s: { revision: 1, updated: 2, text: null } }, versions: [] }));
  assert.throws(() => decodePrivateState({ sessions: [e.session] }));
  assert.equal(decodePrivateState({ sessions: [e.session] }, true).sessions.length, 1);
  assert.throws(() => decodeSession({ ...e.session, status: 'nonsense' }));
  assert.throws(() => decodeSession({ ...e.session, messages: [{ role: 'assistant', text: '', process: 'nonsense' }] }));
});
await check('Legacy runtime loading validates nested state and can recover a backup-only install', async () => {
  for (const primary of [false, true]) {
    const e = fixture(); e.disk.clear(); const plugin = { manifest: { dir: 'plugin' }, app: { vault: { adapter: e.adapter } }, settings: { selected: null } };
    const good = JSON.stringify(e.state); e.disk.set('plugin/private/state.previous.json', good);
    if (primary) e.disk.set('plugin/private/state.json', JSON.stringify({ ...e.state, memory: { summaries: null, versions: [] } }));
    const runtime = new AgentRuntime(plugin); await runtime.load(); assert.equal(runtime.state.sessions[0].id, e.session.id); assert.equal(e.mutations.length, 0);
  }
});
await check('Attachment cleanup rejects malformed recovery collections without scrubbing them', async () => {
  const e = fixture(), loaded = await e.store.load(); await e.store.save(loaded);
  const backup = JSON.stringify({ ...e.session, messages: [{ role: 'user', text: 'keep', files: [null] }] }); e.disk.set(e.path + '.previous', backup);
  await assert.rejects(e.store.cleanAttachments(loaded)); assert.equal(e.disk.get(e.path + '.previous'), backup);
});
console.log(`${count} storage schema regression checks passed.`);
