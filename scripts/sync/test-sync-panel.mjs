import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import esbuild from 'esbuild';
import { JSDOM } from 'jsdom';
const require = createRequire(import.meta.url);
const dom = new JSDOM('<div id="panel"><div></div><div></div></div>');
const prototype = dom.window.HTMLElement.prototype;
prototype.createEl = function(tag, options = {}) { const element = dom.window.document.createElement(tag); if(options.cls) element.className = options.cls; if(options.text) element.textContent = options.text; if(options.value !== undefined) element.value = options.value; for(const [key,value] of Object.entries(options.attr || {})) element.setAttribute(key,value); this.append(element); return element; };
prototype.createDiv = function(options) { return this.createEl('div',options); };
prototype.createSpan = function(options) { return this.createEl('span',options); };
prototype.empty = function() { this.replaceChildren(); };
prototype.addClass = function(...names) { this.classList.add(...names); };
prototype.removeClass = function(...names) { this.classList.remove(...names); };
prototype.toggleClass = function(name, enabled) { this.classList.toggle(name,enabled); };
prototype.setText = function(value) { this.textContent = value; };
prototype.setAttr = function(key,value) { this.setAttribute(key,value); };
prototype.getAttr = function(key) { return this.getAttribute(key); };
const notices = [];
class ItemView { constructor(leaf) { this.app=leaf.app;this.containerEl=leaf.containerEl;this.leaf=leaf; } }
const obsidian = new Proxy({ ItemView, Platform:{isMobile:false}, Notice:class { constructor(message) { notices.push(message); } }, setIcon:()=>{},setTooltip:()=>{},addIcon:()=>{} }, { get:(target,key)=>key in target?target[key]:class {} });
const built = await esbuild.build({ entryPoints:['src/features/sync/index.ts'],bundle:true,platform:'node',format:'cjs',write:false,external:['obsidian'],plugins:[{name:'expose-panel',setup(build){build.onLoad({filter:/features[\\/]sync[\\/]index\.ts$/}, async args=>({contents:(await readFile(args.path,'utf8'))+'\nexport { ZoeySyncView, ZoeySyncConflictPreviewModal, SetupDifferencesModal, FileTrackingModal, createFileListLayout };\nexport { reviewImage, reviewImageLimit, isReviewImage } from "./reviewImage";',loader:'ts'}));}}] });
const imageUrls = { created: [], revoked: [] };
class PreviewURL extends URL {
  static createObjectURL(blob) { const url = 'blob:fixture-' + (imageUrls.created.length + 1); imageUrls.created.push({ url, blob }); return url; }
  static revokeObjectURL(url) { imageUrls.revoked.push(url); }
}
const context = vm.createContext({module:{exports:{}},require:name=>name==='obsidian'?obsidian:require(name),process,console,Date,setTimeout,clearTimeout,URL:PreviewURL,Blob,Element:dom.window.Element,HTMLElement:dom.window.HTMLElement});context.window=context;vm.runInContext(built.outputFiles[0].text,context);
const {default:Sync,ZoeySyncView,ZoeySyncConflictPreviewModal,SetupDifferencesModal,FileTrackingModal,createFileListLayout,reviewImage,reviewImageLimit,isReviewImage}=context.module.exports;
const switchLayout = async root => {
  const buttons = root.querySelectorAll('button.simple-one-sync-layout-toggle');
  assert.equal(buttons.length, 1, 'each panel has one shared SVG layout action');
  assert.equal(buttons[0].textContent, '');
  buttons[0].click(); await new Promise(resolve => setImmediate(resolve));
};
assert.equal(createFileListLayout().get(), 'list', 'new preferences default to flat lists');
assert.equal(createFileListLayout({ viewLayout: 'list' }).get(), 'list', 'existing flat preferences are respected');
assert.equal(createFileListLayout({ viewLayout: 'tree' }).get(), 'tree', 'existing tree preferences are respected');
// Raster metadata is verified from bytes, not a trusted filename extension.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYj8AAAAASUVORK5CYII=', 'base64');
assert.equal(reviewImage(png).mime, 'image/png');
assert.equal(reviewImage(png).bytes, png);
assert.equal(isReviewImage('images/fake.PNG'), true);
assert.equal(isReviewImage('images/active.svg'), false);
for (const text of ['<svg onload="alert(1)"></svg>', '<html><script>alert(1)</script></html>', 'fake .png file'])
    assert.throws(() => reviewImage(Buffer.from(text)), /格式不受支持或内容不匹配/);
assert.throws(() => reviewImage(new Uint8Array(reviewImageLimit + 1)), /超过 5 MB/);
// Single-line review: quick decisions never open details or fetch file bodies.
const tick = () => new Promise(resolve => setImmediate(resolve));
const clickText = (root, text) => { const b = [...root.querySelectorAll('button')].find(b => b.textContent === text); assert(b, 'missing action: ' + text); b.click(); };
const rowFor = (root, path) => [...root.querySelectorAll('.simple-one-sync-version-row')].find(row => row.dataset.path === path);
const openFile = async (root, path) => { rowFor(root, path).querySelector('.simple-one-sync-version-row__file').click(); await tick(); };
const choose = (root, side) => clickText(root, side === 'local' ? '采用本地' : '采用云端');
const mountReview = live => {
    const root = dom.window.document.body.createDiv(), review = new ZoeySyncConflictPreviewModal({}, live);
    review.modalEl = dom.window.document.body.createDiv();
    const result = review.waitIn(root);
    return { root, review, result, dispose: () => { root.remove(); review.modalEl.remove(); } };
};
{
    let reads = 0;
    const files = Array.from({ length: 101 }, (_, i) => ({ path: 'conflict-' + i, label: 'notes/' + (i % 2 ? 'other/' : 'deep/') + String(i).padStart(3, '0') + '.md', ...(i === 0 ? { remoteMissingLabel: '云端已删除' } : {}) }));
    const f = mountReview({ files, layout: createFileListLayout({ viewLayout: 'tree' }), read: async () => { reads++; return { local: '<script>LOCAL</script>', remote: 'REMOTE' }; } }), { root, review } = f;
    assert.equal(root.querySelectorAll('.simple-one-sync-version-row').length, 100);
    assert.equal(reads, 0);
    assert.equal(root.querySelector('.mod-cta').disabled, true);
    assert.equal(root.querySelectorAll('input,.simple-one-sync-version-choice__batch,.simple-one-sync-version-row__state,.simple-one-sync-view__old-path,.simple-one-sync-view__mark').length, 0, 'no checkboxes, batch controls, status second line or symbols');
    assert.equal(rowFor(root, 'conflict-0').querySelector('.simple-one-sync-version-row__file').children.length, 1);
    assert.match(rowFor(root, 'conflict-0').querySelector('.is-remote').getAttribute('aria-label'), /云端已删除.*两端均不保留/);
    rowFor(root, 'conflict-0').querySelector('.is-remote').click();
    assert(rowFor(root, 'conflict-0').querySelector('.is-remote.is-selected[aria-pressed="true"]'));
    assert.equal(reads, 0);
    assert(rowFor(root, 'conflict-0'), 'quick choice stays in list');
    const deep = root.querySelector('[data-folder="notes/deep"]');
    deep.open = false;
    deep.dispatchEvent(new dom.window.Event('toggle'));
    await switchLayout(root);
    assert.equal(rowFor(root, 'conflict-0').querySelector('.simple-one-sync-view__path').textContent, files[0].label, 'flat row uses full path on one line');
    await switchLayout(root);
    assert.equal(root.querySelector('[data-folder="notes/deep"]').open, false);
    clickText(root, '下一页');
    assert.equal(root.querySelectorAll('.simple-one-sync-version-row').length, 1);
    root.querySelector('.simple-one-sync-preview__mobile-scroll').scrollTop = 73;
    await openFile(root, 'conflict-100');
    assert.equal(reads, 1);
    assert.equal(root.querySelectorAll('[role="tab"],input,textarea,select,script').length, 0);
    assert.match(root.querySelector('.simple-one-sync-version-detail__content').textContent, /<script>LOCAL<\/script>/);
    assert(!root.querySelector('.simple-one-sync-version-detail__content').textContent.includes('REMOTE'), 'local context excludes remote-only changes');
    choose(root, 'remote');
    assert.equal(root.querySelectorAll('.simple-one-sync-version-row').length, 0, 'choosing cloud stays in detail');
    assert(root.querySelector('.is-remote[aria-pressed="true"]'));
    assert.match(root.querySelector('.simple-one-sync-version-detail__content').textContent, /REMOTE/);
    assert(!root.querySelector('.simple-one-sync-version-detail__content').textContent.includes('LOCAL'));
    choose(root, 'local');
    clickText(root, '返回文件列表');
    assert.equal(root.querySelectorAll('.simple-one-sync-version-row').length, 1);
    assert.equal(root.querySelector('.simple-one-sync-preview__mobile-scroll').scrollTop, 73);
    assert(rowFor(root, 'conflict-100').querySelector('.is-local[aria-pressed="true"]'));
    await openFile(root, 'conflict-100');
    assert.equal(reads, 1);
    clickText(root, '返回文件列表');
    assert.equal(root.querySelector('.mod-cta').disabled, true);
    clickText(root, '上一页');
    await openFile(root, 'conflict-0');
    assert.equal(reads, 1, 'selected missing side does not read content');
    assert.match(root.textContent, /云端已删除.*采用此端会删除/);
    clickText(root, '返回文件列表');
    for (const file of files.slice(1, 100))
        review.selectFile(file, 'local');
    assert.equal(root.querySelector('.mod-cta').disabled, false);
    clickText(root, '确认并继续同步');
    const selected = await f.result;
    assert.equal(Object.keys(selected).length, 101);
    assert.equal(selected['conflict-0'].choice, 'remote');
    assert.equal(selected['conflict-100'].choice, 'local');
    assert.equal(reads, 1);
    f.dispose();
}
// First alignment shares path-bound choices, lazy content and explicit final confirmation.
{
    let selected, reads = 0;
    const modal = new SetupDifferencesModal({}, ['notes/other/z.md', 'notes/deep/a.md'], {}, async (path) => { reads++; return { local: 'local ' + path, remote: 'remote ' + path }; }, value => { selected = value; }, createFileListLayout({ viewLayout: 'tree' }));
    modal.contentEl = dom.window.document.body.createDiv();
    modal.modalEl = dom.window.document.body.createDiv();
    modal.close = () => modal.onClose();
    modal.onOpen();
    await tick();
    assert.equal(reads, 0);
    await openFile(modal.contentEl, 'notes/deep/a.md');
    choose(modal.contentEl, 'remote');
    assert(modal.contentEl.querySelector('.simple-one-sync-version-detail__content'));
    assert.match(modal.contentEl.textContent, /remote notes\/deep\/a.md/);
    clickText(modal.contentEl, '返回文件列表');
    await switchLayout(modal.contentEl);
    assert(rowFor(modal.contentEl, 'notes/deep/a.md').querySelector('.is-remote[aria-pressed="true"]'));
    await openFile(modal.contentEl, 'notes/deep/a.md');
    assert.equal(reads, 1);
    clickText(modal.contentEl, '返回文件列表');
    rowFor(modal.contentEl, 'notes/other/z.md').querySelector('.is-local').click();
    assert.equal(selected, undefined);
    clickText(modal.contentEl, '确认选择');
    assert.deepEqual(Object.fromEntries(Object.entries(selected)), { 'notes/deep/a.md': 'remote', 'notes/other/z.md': 'local' });
    modal.contentEl.remove();
    modal.modalEl.remove();
}
// Failed and in-flight text reads are reused across navigation; retry is explicit.
{
    let reads = 0;
    const f = mountReview({ files: [{ path: 'failed.md' }], read: async () => { reads++; if (reads === 1)
            throw Error('fixture content failure'); return { local: 'retried local', remote: 'retried remote' }; } }), { root } = f;
    await openFile(root, 'failed.md');
    assert.match(root.textContent, /fixture content failure/);
    clickText(root, '返回文件列表');
    await switchLayout(root);
    await openFile(root, 'failed.md');
    assert.equal(reads, 1);
    clickText(root, '重试读取');
    await tick();
    assert.equal(reads, 2);
    assert.match(root.textContent, /retried local/);
    clickText(root, '返回文件列表');
    clickText(root, '取消');
    assert.equal(await f.result, null);
    f.dispose();
}
{
    let reads = 0, finish;
    const f = mountReview({ files: [{ path: 'pending.md' }], read: () => { reads++; return new Promise(r => { finish = r; }); } }), { root } = f;
    await openFile(root, 'pending.md');
    clickText(root, '返回文件列表');
    await switchLayout(root);
    await openFile(root, 'pending.md');
    assert.equal(reads, 1);
    finish({ local: 'loaded local', remote: 'loaded remote' });
    await tick();
    assert.match(root.textContent, /loaded local/);
    clickText(root, '返回文件列表');
    clickText(root, '取消');
    assert.equal(await f.result, null);
    f.dispose();
}
// Selected-side diff retains nearby context and bounded text, never editable fragments.
{
    const common = Array.from({ length: 30 }, (_, i) => 'same-' + i).join('\n'), data = { text: { local: common + '\nLOCAL\ntail', remote: common + '\nREMOTE\ntail' }, binary: { local: null, remote: null }, mixed: { local: null, remote: 'cloud readable text' }, empty: { local: '', remote: '' }, long: { local: 'a'.repeat(70000), remote: 'b'.repeat(70000) }, lines: { local: 'local line\n'.repeat(2100), remote: 'remote line\n'.repeat(2100) } };
    const f = mountReview({ files: Object.keys(data).map(path => ({ path })), read: async (file) => data[file.path] }), { root } = f;
    await openFile(root, 'text');
    let diff = root.querySelector('.simple-one-sync-version-detail__diff');
    assert.match(diff.querySelector('.is-local').textContent, /LOCAL/);
    assert.equal(diff.querySelectorAll('.is-remote').length, 0);
    assert(!diff.textContent.includes('same-0\n'));
    assert(diff.querySelectorAll('.is-common').length <= 6);
    choose(root, 'remote');
    diff = root.querySelector('.simple-one-sync-version-detail__diff');
    assert.match(diff.querySelector('.is-remote').textContent, /REMOTE/);
    assert.equal(diff.querySelectorAll('.is-local').length, 0);
    clickText(root, '返回文件列表');
    await openFile(root, 'binary');
    assert.match(root.textContent, /无法可靠生成文本差异.*二进制文件/);
    clickText(root, '返回文件列表');
    await openFile(root, 'mixed');
    assert.match(root.textContent, /二进制文件/);
    choose(root, 'remote');
    assert.match(root.querySelector('.simple-one-sync-version-detail__content').textContent, /无法可靠生成文本差异.*cloud readable text/);
    assert.equal(root.querySelector('.simple-one-sync-version-detail__content').getAttribute('role'), 'region');
    clickText(root, '返回文件列表');
    await openFile(root, 'empty');
    assert.match(root.textContent, /两端内容相同/);
    clickText(root, '返回文件列表');
    await openFile(root, 'long');
    assert.match(root.textContent, /限量截断/);
    assert(root.querySelector('pre .is-local').textContent.length <= 60003);
    clickText(root, '返回文件列表');
    await openFile(root, 'lines');
    assert.match(root.textContent, /限量截断/);
    assert(root.querySelectorAll('.simple-one-sync-version-detail__diff > span').length <= 1001);
    clickText(root, '返回文件列表');
    clickText(root, '取消');
    assert.equal(await f.result, null);
    f.dispose();
}
// Upstream partial prefixes cannot claim entire files match; output stays whole-side only.
{
    let selected;
    const prefix = 'same prefix'.repeat(1000).slice(0, 10000);
    const modal = new SetupDifferencesModal({}, ['truncated.md'], {}, async () => ({ local: prefix, remote: prefix, preview: { local: { kind: 'text', limited: true }, remote: { kind: 'text', limited: true } } }), value => { selected = value; });
    modal.contentEl = dom.window.document.body.createDiv();
    modal.modalEl = dom.window.document.body.createDiv();
    modal.close = () => modal.onClose();
    modal.onOpen();
    await openFile(modal.contentEl, 'truncated.md');
    assert.match(modal.contentEl.textContent, /预览范围内无差异.*未比较后续内容/);
    assert(!modal.contentEl.textContent.includes('两端内容相同'));
    choose(modal.contentEl, 'remote');
    clickText(modal.contentEl, '返回文件列表');
    clickText(modal.contentEl, '确认选择');
    assert.deepEqual(Object.fromEntries(Object.entries(selected)), { 'truncated.md': 'remote' });
    modal.contentEl.remove();
    modal.modalEl.remove();
}
// Images are selected-side/lazy; URL ownership never crosses side, file or close boundaries.
{
    const calls = [], bytes = new Uint8Array([1, 2, 3]), image = { bytes, mime: 'image/png' };
    const f = mountReview({ files: [{ path: 'photo.png' }, { path: 'gone.png', remoteMissingLabel: '云端已删除' }, { path: 'fail.png' }], initialChoices: { 'gone.png': 'remote' },
        read: async () => assert.fail('image detail cannot request text'), readImage: async (file, side) => { calls.push(file.path + ':' + side); if (file.path === 'fail.png' && calls.filter(x => x === file.path + ':' + side).length === 1)
            throw Error('fixture image ' + side); return image; } }), { root } = f;
    assert.equal(calls.length, 0);
    rowFor(root, 'photo.png').querySelector('.is-local').click();
    assert.equal(calls.length, 0);
    await openFile(root, 'photo.png');
    assert.deepEqual(calls, ['photo.png:local']);
    let oldImage = root.querySelector('img'), localURL = oldImage.src;
    assert.equal(imageUrls.created.at(-1).blob.type, 'image/png');
    assert.match(oldImage.alt, /本地图片版本.*photo.png/);
    choose(root, 'remote');
    await tick();
    const remoteURL = root.querySelector('img').src;
    assert.notEqual(remoteURL, localURL);
    assert(imageUrls.revoked.includes(localURL));
    assert.match(root.querySelector('img').alt, /云端图片版本/);
    const revokeCount = imageUrls.revoked.length, readCount = calls.length;
    oldImage.dispatchEvent(new dom.window.Event('error'));
    await tick();
    assert.equal(root.querySelector('img').src, remoteURL);
    assert.equal(imageUrls.revoked.length, revokeCount, 'stale local image error cannot revoke current cloud image');
    assert.equal(calls.length, readCount);
    choose(root, 'remote');
    await tick();
    assert.equal(calls.length, readCount, 'same-side choice reuses loaded image');
    oldImage = root.querySelector('img');
    clickText(root, '返回文件列表');
    assert(imageUrls.revoked.includes(remoteURL));
    const beforeMissing = calls.length;
    await openFile(root, 'gone.png');
    assert.match(root.textContent, /云端已删除.*采用此端会删除/);
    assert.equal(calls.length, beforeMissing, 'missing image side is never read');
    assert.equal(root.querySelector('img'), null);
    clickText(root, '返回文件列表');
    await openFile(root, 'fail.png');
    assert.match(root.textContent, /图片读取失败.*local/);
    choose(root, 'remote');
    await tick();
    assert.match(root.textContent, /图片读取失败.*remote/);
    assert(root.querySelector('.is-remote[aria-pressed="true"]'), 'image read failure does not prevent choosing a complete side');
    clickText(root, '重试图片');
    await tick();
    assert(root.querySelector('img'));
    const broken = root.querySelector('img'), brokenURL = broken.src;
    broken.dispatchEvent(new dom.window.Event('error'));
    await tick();
    assert.match(root.textContent, /图片无法解码/);
    assert(imageUrls.revoked.includes(brokenURL));
    clickText(root, '重试图片');
    await tick();
    assert(root.querySelector('img'));
    const lastURL = root.querySelector('img').src;
    f.review.close();
    assert.equal(await f.result, null);
    assert(imageUrls.revoked.includes(lastURL));
    const closedRevokes = imageUrls.revoked.length;
    oldImage.dispatchEvent(new dom.window.Event('error'));
    await tick();
    assert.equal(imageUrls.revoked.length, closedRevokes, 'closed image handler is inert');
    f.dispose();
}
// Late asynchronous image reads never create a URL for a different file or a closed review.
{
    const pending = new Map(), calls = [];
    const f = mountReview({ files: ['a.png', 'b.webp', 'c.jpg'].map(path => ({ path })), read: async () => assert.fail('no text read'), readImage: (file, side) => { calls.push(file.path + ':' + side); return new Promise(resolve => pending.set(file.path, resolve)); } }), { root } = f;
    await openFile(root, 'a.png');
    clickText(root, '返回文件列表');
    await openFile(root, 'b.webp');
    const before = imageUrls.created.length;
    pending.get('a.png')({ bytes: new Uint8Array([1]), mime: 'image/png' });
    await tick();
    assert.equal(imageUrls.created.length, before);
    assert.equal(root.querySelector('img'), null);
    assert.match(root.textContent, /b.webp.*正在读取图片/);
    pending.get('b.webp')({ bytes: new Uint8Array([2]), mime: 'image/webp' });
    await tick();
    const image = root.querySelector('img');
    assert.match(image.alt, /b.webp/);
    const bURL = image.src;
    clickText(root, '返回文件列表');
    assert(imageUrls.revoked.includes(bURL));
    await openFile(root, 'c.jpg');
    f.review.close();
    assert.equal(await f.result, null);
    const closed = imageUrls.created.length;
    pending.get('c.jpg')({ bytes: new Uint8Array([3]), mime: 'image/jpeg' });
    await tick();
    assert.equal(imageUrls.created.length, closed, 'read completing after close owns no URL');
    assert.deepEqual(calls, ['a.png:local', 'b.webp:local', 'c.jpg:local']);
    f.dispose();
}
// A late local-side result cannot replace the selected cloud image.
{
    const pending = new Map();
    const f = mountReview({ files: [{ path: 'both.png' }], read: async () => assert.fail('no text read'), readImage: (_file, side) => new Promise(resolve => pending.set(side, resolve)) }), { root } = f;
    await openFile(root, 'both.png');
    choose(root, 'remote');
    const before = imageUrls.created.length;
    pending.get('local')({ bytes: new Uint8Array([1]), mime: 'image/png' });
    await tick();
    assert.equal(imageUrls.created.length, before);
    assert.equal(root.querySelector('img'), null);
    pending.get('remote')({ bytes: new Uint8Array([2]), mime: 'image/png' });
    await tick();
    assert.match(root.querySelector('img').alt, /云端图片版本/);
    f.review.close();
    assert.equal(await f.result, null);
    f.dispose();
}
// Optional/unavailable image readers leave whole-file choice usable without text fetches.
for (const reader of [undefined, async () => null]) {
    const f = mountReview({ files: [{ path: 'none.avif' }], read: async () => assert.fail('no text read'), readImage: reader }), { root } = f;
    await openFile(root, 'none.avif');
    assert.match(root.textContent, /不支持图片预览|没有可预览的图片/);
    choose(root, 'remote');
    await tick();
    assert(root.querySelector('.is-remote[aria-pressed="true"]'));
    clickText(root, '返回文件列表');
    assert.equal(root.querySelector('.mod-cta').disabled, false);
    clickText(root, '确认并继续同步');
    assert.equal((await f.result)['none.avif'].choice, 'remote');
    f.dispose();
}
// Image identities can have a synthetic label and a real image path.
{
  let reads = 0;
  const f = mountReview({ files: [{ path: 'identity', label: '相同内容·多路径', localPaths: ['images/actual.png'] }],
    read: async () => assert.fail('image path must not fall back to text'), readImage: async () => { reads++; return null; } });
  await openFile(f.root, 'identity'); assert.equal(reads, 1); assert.match(f.root.textContent, /没有可预览的图片/);
  f.review.close(); assert.equal(await f.result, null); f.dispose();
}
assert(imageUrls.created.every(({ url }) => imageUrls.revoked.includes(url)), 'all owned image URLs are released');
// Switching layout keeps tracking consent, per-list paging and the shared preference.
{
  let repairs = 0;
  const owner = { settings: { viewLayout: 'list' }, saveSettings: async () => {}, repairFileTracking: async () => { repairs++; } };
  const modal = new FileTrackingModal({}, owner, { originalIgnore: 'old', nextIgnore: 'new', missingRules: ['cache/'],
    paths: Array.from({ length: 101 }, (_, index) => `cache/state/${index}.json`), addPaths: ['notes/new.md'] });
  modal.contentEl = dom.window.document.body.createDiv(); modal.modalEl = dom.window.document.body.createDiv();
  modal.onOpen();
  const groups = [...modal.contentEl.querySelectorAll('.simple-one-sync-tracking-details')];
  assert.equal(groups.length, 2);
  assert(groups.every(group => group.querySelector('.simple-one-sync-file-list')), 'tracking honors legacy flat preferences');
  const apply = [...modal.contentEl.querySelectorAll('button')].find(button => button.textContent === '应用修复');
  assert.equal(apply.disabled, true);
  const consent = modal.contentEl.querySelector('input[type="checkbox"]'); consent.checked = true; consent.dispatchEvent(new dom.window.Event('change'));
  await switchLayout(modal.contentEl);
  assert(groups.every(group => group.querySelector('.simple-one-sync-file-tree')), 'one tracking toggle changes both removal and addition lists');
  assert.equal(consent.checked, true); assert.equal(apply.disabled, false);
  [...groups[0].querySelectorAll('button')].find(button => button.textContent === '下一页').click();
  assert.equal(groups[0].querySelectorAll('.simple-one-sync-view__change').length, 1);
  await switchLayout(modal.contentEl);
  assert.equal(groups[0].querySelectorAll('.simple-one-sync-view__change').length, 1, 'tracking layout keeps its current page');
  assert(groups[0].querySelector('[aria-label="cache/state/100.json"]'));
  assert.equal(repairs, 0, 'layout changes never apply tracking repair');
  modal.contentEl.remove(); modal.modalEl.remove();
}
console.log('Shared list/tree layouts: single-line review/detail/image lifetime, onboarding and tracking consent passed.');
const oldSyncError = { context: '手动同步', status: 'error', message: '请先完成手机端 Token、仓库与同步范围引导。' };
const fetchSuccess = { context: '启动时 Fetch + Merge', status: 'success' };
const pushError = { context: '自动备份（Commit + Push）', status: 'error' };
const activeError = logs => Sync.prototype.getActiveSyncError.call({ getRecentErrorLogs: () => logs });
assert.equal(activeError([oldSyncError]), oldSyncError);
const connectedLog = { context: '轻量接入', status: 'success' };
assert.equal(activeError([connectedLog, oldSyncError]), undefined, 'reconnection resolves the earlier incomplete-guide error');
assert.equal(activeError([oldSyncError, connectedLog]), oldSyncError, 'a new error after reconnection remains active');
assert.equal(activeError([connectedLog, pushError]), pushError, 'reconnection does not claim a failed upload succeeded');
assert.equal(activeError([fetchSuccess, oldSyncError]), undefined, 'successful fetch clears the old generic sync warning');
assert.equal(activeError([fetchSuccess, pushError]), pushError, 'fetch does not clear a failed upload');
assert.equal(activeError([{context:'手动同步',status:'success'}, pushError]), undefined);
assert.equal(activeError([{context:'分享发布',status:'success'}, oldSyncError]), oldSyncError, 'unrelated success does not clear sync errors');
const setupCommands = [];
const setupHost = Object.create(Sync.prototype);
setupHost.host = { app: { vault: { configDir: '.obsidian' } } };
setupHost.vaultBasePath = () => 'D:/test-vault';
setupHost.exec = async (program, args, authenticated) => { setupCommands.push({ program, args, authenticated }); return ''; };
const setup = setupHost.setup();
await setup.run('git', ['fetch', 'origin']);
await setup.run('git', ['--git-dir', 'preview.git', 'fetch', 'https://github.com/example/vault.git', 'main']);
await setup.run('gh', ['auth', 'status']);
assert.deepEqual(setupCommands.map(command => command.authenticated), [true, true, false], 'onboarding Git commands reuse gh credentials even with leading Git options');
await setupHost.trustSetupVault();
assert.deepEqual(Array.from(setupCommands.at(-1).args), ['config', '--global', '--add', 'safe.directory', 'D:/test-vault'], 'trust only the current vault, never all repositories');
const authView = Object.create(context.module.exports.SyncSettingsTab.prototype);
let authError;
authView.plugin = { checkSetupAuthorization: async () => { if (authError) throw authError; } };
await authView.verifyExistingSetupAuthorization();
for (const message of ['network connection timed out', 'the token in keyring is invalid', 'unexpected CLI error']) {
  authError = new Error(message);
  await assert.rejects(() => authView.verifyExistingSetupAuthorization(), error => error === authError, 'preserve the real verification failure');
}
authError = new Error('You are not logged into any GitHub hosts.');
await assert.rejects(() => authView.verifyExistingSetupAuthorization(), /未找到登录状态/);
authError = new Error('spawn git ENOENT');
await assert.rejects(() => authView.verifyExistingSetupAuthorization(), /缺少 Git 或 GitHub CLI/);
let reads=0, fail=false, release;
let changes=[{path:'notes/deep/a.md',kind:'modified'},{path:'notes/other/b.md',kind:'added'}];
const plugin={settings:{viewLayout:'list',lastSyncAt:Date.now(),setupComplete:true,mobile:{mode:'github'}},getPendingConflictPaths:async()=>[],getDeferredMergePaths:()=>[],getChanges:async()=>{reads++;if(release)await new Promise(resolve=>{release.resolve=resolve;});if(fail)throw Error('offline status');return changes;},getSetupActivity:()=>undefined,getSyncActivity:()=>undefined,nativeGitEnabled:()=>true,useLightweightSync:()=>false,isSyncing:()=>false,getLightweightPendingStatus:()=>undefined,getActiveSyncError:()=>undefined,getRecentErrorLogs:()=>[],saveSettings:async()=>{},syncNow:async()=>{}};
const leaf={app:{workspace:{layoutReady:true,openLinkText:()=>{}}},containerEl:dom.window.document.querySelector('#panel')};
const view=new ZoeySyncView(leaf,plugin);leaf.view=view;
plugin.refreshSyncView=async reuse=>view.render(reuse);
plugin.toggleViewLayout=()=>Sync.prototype.toggleViewLayout.call(plugin);
await view.render();assert.equal(reads,1);assert.equal(leaf.containerEl.querySelectorAll('.simple-one-sync-view__change').length,2);
assert.match(leaf.containerEl.textContent,/本机变更 · 2 个文件 · 上次同步/);assert(!/Commit|Push|待上传/.test(leaf.containerEl.textContent));
assert(leaf.containerEl.querySelector('.simple-one-sync-file-list'), 'legacy list preferences remain flat');
assert.match(leaf.containerEl.textContent, /notes\/deep\/a\.md/);
await switchLayout(leaf.containerEl);
assert.equal(plugin.settings.viewLayout, 'tree');
assert.equal(reads, 1, 'switching layout does not rescan the repository');
assert(leaf.containerEl.querySelector('.simple-one-sync-file-tree'));
await view.render(true);assert.equal(reads,1,'cached rendering reuses the same snapshot');
let folderGroup = leaf.containerEl.querySelector('details[data-folder="notes"]');
assert(folderGroup.open, 'folders start expanded');
assert.equal(folderGroup.querySelector(':scope > summary .simple-one-sync-view__group-count').textContent, '2');
assert.equal(folderGroup.querySelectorAll(':scope > details').length, 2, 'nested directories remain children of their real parent');
assert.equal(folderGroup.querySelector('details[data-folder="notes/deep"] > summary .simple-one-sync-view__group-count').textContent, '1');
folderGroup.open = false;
folderGroup.dispatchEvent(new dom.window.Event('toggle'));
await view.render(true);
folderGroup = leaf.containerEl.querySelector('details[data-folder="notes"]');
assert.equal(folderGroup.open, false, 'refresh preserves collapsed folders');
folderGroup.querySelector('summary').click();
assert.equal(folderGroup.open, true, 'clicking folder heading expands it');
folderGroup.dispatchEvent(new dom.window.Event('toggle'));
console.log('Sync folders: native collapse, count and refresh state passed.');
changes=[{path:'notes/new.md',kind:'added'}];release={};leaf.containerEl.querySelector('[aria-label="刷新更改区"]').click();assert.match(leaf.containerEl.textContent,/正在刷新文件列表/);assert.equal(leaf.containerEl.querySelectorAll('.simple-one-sync-view__change').length,2,'keep the current list while reading');
await new Promise(resolve=>setTimeout(resolve,0));release.resolve();release=undefined;await new Promise(resolve=>setTimeout(resolve,0));assert.equal(leaf.containerEl.querySelectorAll('.simple-one-sync-view__change').length,1);assert.match(leaf.containerEl.textContent,/new.md/);assert.match(leaf.containerEl.textContent,/列表已刷新/);
fail=true;await view.render();assert.match(leaf.containerEl.textContent,/无法读取更改/);assert.equal(leaf.containerEl.querySelectorAll('.simple-one-sync-view__change').length,1,'failed refresh preserves last successful list');await view.render(true);assert.match(leaf.containerEl.textContent,/无法读取更改/);
assert(leaf.containerEl.querySelector('.simple-one-sync-file-tree'), 'error fallback retains the chosen tree layout');
const failedReads = reads;
await switchLayout(leaf.containerEl);
assert(leaf.containerEl.querySelector('.simple-one-sync-file-list'), 'error fallback can switch to a flat view of the cached files');
assert.equal(reads, failedReads);
await switchLayout(leaf.containerEl);
assert.equal(leaf.containerEl.querySelector('.simple-one-sync-view__status-text').textContent, '刷新失败');
assert.equal(leaf.containerEl.textContent.split('offline status').length - 1, 1, 'the read failure detail is shown exactly once');
assert(!leaf.containerEl.querySelector('.simple-one-sync-view__error-detail').textContent.includes('Error:'), 'cross-realm Error objects display only their message');
assert(leaf.containerEl.querySelector('.simple-one-sync-view__status .simple-one-sync-view__error-detail'), 'read errors live in the top status area');
assert(!leaf.containerEl.querySelector('.simple-one-sync-view__section .simple-one-sync-view__error-detail'), 'file lists never repeat error details');
const order = leaf.containerEl.querySelector('.simple-one-sync-view__error-detail').compareDocumentPosition(leaf.containerEl.querySelector('.simple-one-sync-view__section-action'));
assert(order & dom.window.Node.DOCUMENT_POSITION_FOLLOWING, 'full errors precede the sync action and file list');
plugin.getActiveSyncError = () => ({ context: '手动同步', message: 'another important sync failure', timestamp: Date.now() });
await view.render();
assert.equal(leaf.containerEl.querySelectorAll('.simple-one-sync-view__status .simple-one-sync-view__error-detail').length, 2, 'distinct read and sync failures remain visible together');
assert.equal(leaf.containerEl.textContent.split('another important sync failure').length - 1, 1);
plugin.getActiveSyncError = () => ({ context: '手动同步', message: 'offline status', timestamp: Date.now() });
await view.render();
assert.equal(leaf.containerEl.querySelectorAll('.simple-one-sync-view__error-detail').length, 1, 'identical details merge their contexts');
assert.match(leaf.containerEl.querySelector('.simple-one-sync-view__error-detail').textContent, /无法读取更改.*手动同步/);
plugin.getActiveSyncError = () => undefined;

const originalChanges = plugin.getChanges;
plugin.getChanges = async () => { throw 'Error: Error: another distinct read failure'; };
await view.render();
assert.match(leaf.containerEl.textContent, /another distinct read failure/);
assert(!leaf.containerEl.querySelector('.simple-one-sync-view__error-detail').textContent.includes('Error:'));
const noCacheContainer = dom.window.document.createElement('div'); noCacheContainer.innerHTML = '<div></div><div></div>';
const noCacheLeaf = { app: leaf.app, containerEl: noCacheContainer };
const noCacheView = new ZoeySyncView(noCacheLeaf, plugin);
await noCacheView.render();
assert.equal(noCacheContainer.querySelectorAll('.simple-one-sync-view__change').length, 0);
assert.equal(noCacheContainer.textContent.split('another distinct read failure').length - 1, 1);
assert.match(noCacheContainer.textContent, /暂无可显示的文件列表/);
assert(!noCacheContainer.textContent.includes('本机暂无变更'), 'a failed initial read is not reported as no changes');
plugin.getChanges = originalChanges;
fail = false;
plugin.getActiveSyncError = () => ({ context: '自动同步', message: 'Error: independent sync failure', timestamp: Date.now() });
await view.render();
assert.match(leaf.containerEl.querySelector('.simple-one-sync-view__status-text').textContent, /同步失败/);
assert.equal(leaf.containerEl.querySelector('.simple-one-sync-view__status .simple-one-sync-view__error-detail').textContent, '自动同步：independent sync failure');
assert.equal(leaf.containerEl.textContent.split('independent sync failure').length - 1, 1);
plugin.getActiveSyncError = () => undefined;


fail=false;changes=[];await view.render();assert.equal(leaf.containerEl.querySelectorAll('.simple-one-sync-view__change').length,0);assert.match(leaf.containerEl.textContent,/本机暂无变更/);assert.equal(notices.length,0);
console.log('Sync panel: unified status, stable layout, visible refresh, refreshed data and failed-read recovery passed.');
changes = Array.from({length: 10001}, (_, i) => ({path: `bulk/${i}.md`, kind: 'added'}));
await view.render();
assert.equal(leaf.containerEl.querySelectorAll('.simple-one-sync-view__change').length, 100);
const pageReads = reads;
[...leaf.containerEl.querySelectorAll('button')].find(button => button.textContent === '下一页').click();
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(reads, pageReads, 'paging reuses repository snapshot');
assert(leaf.containerEl.querySelector('.simple-one-sync-view__change[aria-label="bulk/100.md"]'));
fail = true; await view.render();
assert.equal(leaf.containerEl.querySelectorAll('.simple-one-sync-view__change').length, 100, 'error fallback stays bounded');
fail = false; changes = []; await view.render();
console.log('Large native lists: bounded rows, cached paging and bounded error fallback passed.');
const plan = { remote:{ files:{'remote.md':{sha:'r',mode:'100644'}} }, local:{'local.md':{sha:'l',mode:'100644'}},
  uploads:['local.md'], downloads:['remote.md'], conflicts:[], localDeletes:['local.md'],remoteDeletes:[] };
const choice=view.chooseStrategy(plan);
assert.equal(leaf.containerEl.querySelectorAll('.simple-one-sync-transfer__strategies button').length,4);
assert.deepEqual([...leaf.containerEl.querySelectorAll('.simple-one-sync-transfer__strategy-box h4')].map(el=>el.textContent), ['合并两端', '重建一端']);
assert.deepEqual([...leaf.containerEl.querySelectorAll('.simple-one-sync-transfer__strategy-actions button')].map(el=>el.textContent), ['优先云端', '优先本地', '保留云端', '保留本地', '暂不处理']);
assert.match(leaf.containerEl.textContent,/云端 1 个文件，本地 1 个文件/);
[...leaf.containerEl.querySelectorAll('button')].find(button=>button.textContent === '保留云端').click();
assert.equal(await choice,'remote');
const confirmation=view.confirmLightweightPlan(plan);
assert.match(leaf.containerEl.textContent,/待删除本机文件（1）/);
assert.equal(leaf.containerEl.querySelectorAll('.simple-one-sync-plan-confirmation > p').length, 0, 'the four directional groups replace duplicate summary paragraphs');
[...leaf.containerEl.querySelectorAll('button')].find(button=>button.textContent==='返回选择').click();
assert.equal(await confirmation,false);
const groupedConfirmation = view.confirmLightweightPlan({ remote: { files: { 'notes/deep/upload.md': {} } }, local: {},
  uploads: ['notes/deep/upload.md'], downloads: ['notes/deep/download.md'],
  localDeletes: ['notes/deep/local-delete.md'], remoteDeletes: ['notes/deep/remote-delete.md'] });
const directions = [...leaf.containerEl.querySelectorAll('.simple-one-sync-plan-confirmation > details')];
assert.equal(directions.length, 4, 'the verified plan retains its four independent directions');
assert(directions.every(group => group.querySelector('.simple-one-sync-file-tree [data-folder="notes/deep"]')));
assert.deepEqual(directions.map(group => group.querySelector(':scope > summary').textContent), ['待删除云端文件（1）', '待上传（1）', '待删除本机文件（1）', '待下载（1）']);
assert.deepEqual(directions.map(group => group.querySelector('.simple-one-sync-view__mark').textContent), ['−', 'M', '−', '+']);
await switchLayout(leaf.containerEl.querySelector('.simple-one-sync-plan-confirmation'));
assert(directions.every(group => group.querySelector('.simple-one-sync-file-list')), 'one plan toggle changes all four directions');
await switchLayout(leaf.containerEl.querySelector('.simple-one-sync-plan-confirmation'));
assert(directions.every(group => group.querySelector('.simple-one-sync-file-tree')));
[...leaf.containerEl.querySelectorAll('button')].find(button => button.textContent === '返回选择').click();
assert.equal(await groupedConfirmation, false);
const cancelled=view.chooseStrategy(plan);await view.onClose();assert.equal(await cancelled,null);
view.closed=false;
const taskEngine={downloadTask:{mode:'manual',downloads:1500,total:2000,completed:500},remaining:3500,state:{pending:{commit:'abcdef1234567890'}}};
plugin.getMobileGithub=()=>taskEngine;plugin.useLightweightSync=()=>true;plugin.nativeGitEnabled=()=>false;
await view.render();
assert(leaf.containerEl.querySelector('.simple-one-sync-view__status-meta .simple-one-sync-view__quota'));
assert(!leaf.containerEl.querySelector('.view-content > .simple-one-sync-view__quota'));
assert(leaf.containerEl.querySelector('[aria-label^="下载待办尚未完成"]'));
await view.showDownloadTask();
assert.equal(leaf.containerEl.querySelectorAll('.simple-one-sync-view__quota').length, 1);
assert(leaf.containerEl.querySelector('.simple-one-sync-view__status-meta .simple-one-sync-view__quota'));
assert(!leaf.containerEl.querySelector('.simple-one-sync-transfer__download-info').textContent.includes('API'));
assert.match(leaf.containerEl.textContent,/1500|1,500/);
assert(!leaf.containerEl.querySelector('.simple-one-sync-transfer__download a'));
assert(![...leaf.containerEl.querySelectorAll('button')].some(button=>button.textContent==='选择 ZIP 并导入'));
assert([...leaf.containerEl.querySelectorAll('button')].some(button=>button.textContent==='继续自动下载'));
assert.equal(leaf.containerEl.querySelectorAll('.simple-one-sync-transfer button').length,1);
assert.match(leaf.containerEl.textContent,/待下载：1,000 个文件/);
assert.match(leaf.containerEl.textContent,/已下载：500 个文件/);
assert.equal(leaf.containerEl.querySelector('.simple-one-sync-transfer__download-info code').textContent,'abcdef123456');
assert(!leaf.containerEl.textContent.includes('重置进度'));
taskEngine.downloadTask.reviewRequired=true;await view.render();
assert.equal(leaf.containerEl.querySelector('.simple-one-sync-transfer button').textContent,'重新检查同步');
assert.equal(leaf.containerEl.querySelectorAll('.simple-one-sync-transfer button').length,1);
taskEngine.downloadTask=undefined;await view.render();assert(!leaf.containerEl.querySelector('.simple-one-sync-download-alert'));
const candidateReads = reads;
plugin.getLightweightPlan = () => ({ uploads: ['verified/upload.md'], downloads: ['verified/download.md'],
  localDeletes: ['verified/delete-local.md'], remoteDeletes: ['verified/delete-remote.md'],
  desired: { 'verified/upload.md': {}, 'verified/download.md': {} }, local: {}, remote: { files: {} } });
await view.render(true);
assert.equal(reads, candidateReads, 'showing the verified plan reuses cached candidates without another scan');
assert.match(leaf.containerEl.textContent, /本次同步变更 · 上传 1 · 下载 1 · 删除本机 1 · 删除云端 1/);
assert.equal(leaf.containerEl.querySelectorAll('.simple-one-sync-view__change').length, 4);
assert.match(leaf.containerEl.textContent, /upload\.md|download\.md/);
assert(!leaf.containerEl.textContent.includes('a.md'), 'candidate paths do not masquerade as the verified plan');
plugin.getLightweightPlan = () => undefined;
await view.render(true);
assert(!leaf.containerEl.textContent.includes('本次同步变更'));
assert.match(leaf.containerEl.textContent, /本机(?:暂无)?变更/);
console.log('Sync flow panel: strategy/deletion confirmation, cancelled steps, persistent download badge and API resume page passed.');
assert.equal(view.getDisplayText(), '同步');
let settingsOpens = 0;
plugin.openPluginSettings = () => { settingsOpens++; };
plugin.settings.enabled = false;
const readsBeforeDisabled = reads;
await view.render();
assert.equal(reads, readsBeforeDisabled, 'disabled sync panel must not read repository changes');
assert.match(leaf.containerEl.textContent, /同步已关闭/);
assert.equal(leaf.containerEl.querySelector('[aria-label="切换到分享"]'), null, 'sync has no sharing switch');
[...leaf.containerEl.querySelectorAll('button')].find(button => button.textContent === '打开同步设置').click();
assert.equal(settingsOpens, 1);
let switchedType, revealed = 0;
const restoredShareLeaf = { setViewState: async state => { switchedType = state.type; } };
let syncType;
const newSyncLeaf = { setViewState: async state => { syncType = state.type; } };
await Sync.prototype.openSyncView.call({
  settings: { enabled: false },
  app: { workspace: {
    getLeavesOfType: type => type === 'simple-one-share' ? [restoredShareLeaf] : [],
    getRightLeaf: () => newSyncLeaf,
    revealLeaf: async () => { revealed++; },
  } },
}, false, false);
assert.equal(switchedType, undefined, 'opening sync preserves a restored sharing page');
assert.equal(syncType, 'simple-one-sync-view', 'sync opens its own tab');
assert.equal(revealed, 0, 'startup must preserve the active workspace pane');
console.log('Separate panels: sync title, disabled sync entry and independent sharing tab passed.');

const { SyncSettingsTab } = context.module.exports;
const entryCard = dom.window.document.createElement('div');
let entryNavigations = 0, entryToggles = 0;
const entryHost = {
  navigateTo: page => { assert.equal(page, 'mobile'); entryNavigations++; },
  renderSettings: () => {},
};
SyncSettingsTab.prototype.addSyncBadges.call(entryHost, entryCard, true, false, async () => { entryToggles++; });
SyncSettingsTab.prototype.addSettingsArrow.call(entryHost, entryCard, 'mobile', '轻量 Git 同步');
entryCard.querySelector('.simple-one-sync-state-toggle').click();
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(entryToggles, 1, 'state button toggles the feature');
assert.equal(entryNavigations, 0, 'state button does not navigate');
entryCard.querySelector('.simple-one-sync-device-badge').click();
entryCard.click();
entryCard.querySelector('.simple-one-sync-entry-arrow').click();
assert.equal(entryNavigations, 3, 'badge, card and arrow each navigate once');
for (const key of ['Enter', ' ']) entryCard.dispatchEvent(new dom.window.KeyboardEvent('keydown', {key, bubbles:true}));
assert.equal(entryNavigations, 5, 'card supports keyboard navigation');
entryCard.querySelector('.simple-one-sync-state-toggle').dispatchEvent(new dom.window.KeyboardEvent('keydown', {key:'Enter', bubbles:true}));
assert.equal(entryNavigations, 5, 'toggle keyboard events do not activate the card');
console.log('Settings cards: toggle isolation and whole-card navigation passed.');

obsidian.Setting = class {
  constructor(parent) { this.settingEl = parent.createDiv(); }
  setName(name) { this.settingEl.textContent = name; return this; }
  setHeading() { return this; }
};
const settingsTab = Object.create(SyncSettingsTab.prototype);
const guides = [];
Object.assign(settingsTab, { desktopPage: 'root', addBeginnerLink: (_parent, title, _icon, page) => guides.push({title, page}) });
settingsTab.displayBeginner(dom.window.document.createElement('div'));
assert.deepEqual(guides.map(x => x.page), ['setup', 'beginner-mobile'], 'sync guides exclude sharing');
const shareContainer = dom.window.document.createElement('div');
let shareTitleChanged;
Object.assign(settingsTab, { settingsHost: shareContainer, desktopPage: 'share-root',
  plugin: { host: { share: { detachSettings() {}, renderSettings(root, guide, title, callback) {
    assert.equal(guide, false); assert.equal(title, false);
    root.createDiv({ text: '分享设置与分享库管理' }); shareTitleChanged = callback;
    callback('笔记分享设置');
  } } } }, settingsTitleChanged: () => {} });
settingsTab.renderSettings();
assert.equal(guides.at(-1).page, 'beginner-server');
assert.equal(shareContainer.textContent, '分享设置与分享库管理', 'sharing groups render without an extra standalone heading');
shareTitleChanged('分享库管理');
assert.equal(shareContainer.querySelector('.simple-one-sync-beginner-links').style.display, 'none');
shareTitleChanged('笔记分享设置');
assert.equal(shareContainer.querySelector('.simple-one-sync-beginner-links').style.display, '');
settingsTab.navigationParents = ['share-root']; settingsTab.desktopPage = 'beginner-server';
settingsTab.stopSetupBrowserAuthorization = () => {}; settingsTab.renderSettings = () => {};
assert.equal(settingsTab.backToOverview(), true);
assert.equal(settingsTab.desktopPage, 'share-root', 'share guide returns to the sharing homepage');
settingsTab.plugin.host.share.backFromEdgeOneGuide = () => false;
settingsTab.resetNavigation(true);
assert.equal(settingsTab.desktopPage, 'share-root');
settingsTab.desktopPage = 'beginner-server'; settingsTab.navigationParents = [];
assert.equal(settingsTab.backToOverview(), true);
assert.equal(settingsTab.desktopPage, 'share-root', 'missing history returns to the selected sharing root');
assert.equal(settingsTab.backToOverview(), false, 'sharing root does not fall through to sync');
settingsTab.resetNavigation(false);
settingsTab.desktopPage = 'setup'; settingsTab.navigationParents = [];
assert.equal(settingsTab.backToOverview(), true);
assert.equal(settingsTab.desktopPage, 'root', 'sync guide stays in the sync category');
console.log('Settings split: sync/share guides, inline sharing settings and return navigation passed.');
const trustView = Object.create(SyncSettingsTab.prototype);
Object.assign(trustView, { setupFailure: true, setupTrustRequired: true, setupBusy: false, setupMessage: 'Git 尚未信任此笔记库',
  plugin: { settings: { setupStep: 3, setupRepoUrl: 'https://github.com/example/vault.git' }, getSetupPreview: () => undefined, getVaultBasePath: () => 'D:/test-vault' } });
let trustBody = dom.window.document.createElement('div');
trustView.displaySetupPreview(trustBody);
assert.equal(trustBody.querySelector('button').textContent, '信任此笔记库并重试');
assert(trustBody.querySelector('button').classList.contains('simple-one-sync-trust-action'));
assert(trustBody.querySelector('.simple-one-sync-setup-error'));
trustView.setupBusy = true; trustView.setupFailure = false;
trustBody = dom.window.document.createElement('div');
trustView.displaySetupPreview(trustBody);
assert.equal(trustBody.querySelector('button').textContent, '正在检查…');
assert(trustBody.querySelector('button').disabled);
assert(!trustBody.querySelector('button').classList.contains('simple-one-sync-trust-action'));
trustView.setupBusy = false; trustView.setupFailure = true; trustView.setupTrustRequired = false;
trustBody = dom.window.document.createElement('div');
trustView.displaySetupPreview(trustBody);
assert.equal(trustBody.querySelector('button').textContent, '检查两端', 'ordinary errors keep the normal retry action');
console.log('Vault trust: exact path, red error action, disabled retry and ordinary error isolation passed.');
const connectedView = Object.create(SyncSettingsTab.prototype);
Object.assign(connectedView, { setupFailure: true, setupMessage: 'old failure', renderDeviceHeader() {},
  plugin: { settings: { setupComplete: true, setupVerified: {}, enabled: true },
    getRecentErrorLogs() { throw Error('onboarding status must not read sync history'); } } });
const connectedRoot = dom.window.document.createElement('div');
const stopAfterStatus = new Error('status rendered');
connectedRoot.createDiv = function(options) {
  const page = prototype.createDiv.call(this, options);
  page.createDiv = function(options) {
    if (options.cls === 'simple-one-sync-setup-tab-panel') throw stopAfterStatus;
    return prototype.createDiv.call(this, options);
  };
  return page;
};
assert.throws(() => connectedView.displaySetup(connectedRoot), error => error === stopAfterStatus);
assert.equal(connectedRoot.querySelector('.simple-one-sync-setup-status strong').textContent, '接入成功');
assert(connectedRoot.querySelector('.simple-one-sync-setup-status.is-success'), 'sync failures cannot turn a completed connection red');

const settingsSource = await readFile('src/settings.ts', 'utf8');
const entryBody = /plugin\.sync\.openSettings = \(share = false\) => \{([\s\S]*?)\n    \};/.exec(settingsSource)?.[1];
assert(entryBody, 'settings shortcut exists');
for (const share of [true, false, true]) {
  const resets = [], pages = [];
  const entry = { syncTab: { resetNavigation: value => resets.push(value) }, openPage: page => pages.push(page.type) };
  new Function('share', entryBody).call(entry, share);
  assert.equal(entry.displayPreviewTab, share ? 'sharing' : 'sync-sharing');
  assert.equal(entry.syncNavigationTab, entry.displayPreviewTab);
  assert.deepEqual(resets, [share]);
  assert.deepEqual(pages, ['overview'], 'settings shortcut opens the current tabbed page, never the legacy page');
}
console.log('Settings shortcuts: sync and sharing open their own current tabs.');
