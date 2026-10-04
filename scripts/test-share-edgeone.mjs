import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import esbuild from 'esbuild';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<main></main>');
const proto = dom.window.HTMLElement.prototype;
proto.createEl = function(tag, options = {}) {
  const el = dom.window.document.createElement(tag);
  if (options.text) el.textContent = options.text;
  if (options.cls) el.className = options.cls;
  for (const [key, value] of Object.entries(options.attr || {})) el.setAttribute(key, value);
  if (options.href) el.setAttribute('href', options.href);
  this.append(el); return el;
};
proto.createDiv = function(options) { return this.createEl('div', options); };
proto.createSpan = function(options) { return this.createEl('span', options); };
class Setting {
  constructor(parent) {
    this.settingEl = parent.createDiv({ cls: 'setting-item' });
    this.infoEl = this.settingEl.createDiv();
    this.nameEl = this.infoEl.createDiv(); this.descEl = this.infoEl.createDiv();
    this.controlEl = this.settingEl.createDiv();
  }
  setName(text) { this.nameEl.textContent = text; return this; }
  setDesc(text) { this.descEl.textContent = text; return this; }
  setClass(cls) { this.settingEl.classList.add(cls); return this; }
  setHeading() { return this; }
  addButton(configure) {
    const buttonEl = this.controlEl.createEl('button');
    configure({ setButtonText(text) { buttonEl.textContent = text; return this; }, setDisabled(value) { buttonEl.disabled = value; return this; }, setCta() { return this; }, onClick(callback) { buttonEl.addEventListener('click', callback); return this; } });
    return this;
  }
  addText(configure) {
    const inputEl = this.controlEl.createEl('input');
    configure({ inputEl, setValue(value) { inputEl.value = value; return this; }, setPlaceholder(value) { inputEl.placeholder = value; return this; }, onChange(callback) { inputEl.addEventListener('input', () => callback(inputEl.value)); return this; } });
    return this;
  }
  addDropdown(configure) {
    const select = this.controlEl.createEl('select');
    configure({ addOptions(options) { for (const [value, text] of Object.entries(options)) select.createEl('option', { text, attr: { value } }); return this; }, setValue(value) { select.value = value; return this; }, setDisabled(value) { select.disabled = value; return this; }, onChange(callback) { select.addEventListener('change', () => callback(select.value)); return this; } });
    return this;
  }
}
let supported = true, request;
const obsidian = { Setting, setIcon() {}, requireApiVersion: () => supported,
  requestUrl: async args => { assert(request, 'no live network requests'); return await request(args); } };
const output = await esbuild.build({ stdin: { contents: 'export * from "./src/features/share/edgeone.ts"; export * from "./src/features/share/edgeoneUi.ts";', resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['obsidian'] });
const context = vm.createContext({ module: { exports: {} }, require: () => obsidian,
  console, TextEncoder, URL, crypto: webcrypto, setTimeout, clearTimeout });
context.window = context;
vm.runInContext(output.outputFiles[0].text, context);
const { EdgeOneConnection, edgeOneRequest, matchesEdgeOneRepository, edgeOneDeploymentResult,
  edgeOneWebsite, renderEdgeOneGuide, renderEdgeOneRow } = context.module.exports;
const site = { owner: 'fixture', repo: 'notes-share', branch: 'main', initialized: true };
const project = { ProjectId: 'pages-fixture', Name: 'notes-share', Provider: 'Github',
  RepoOwner: 'fixture', RepoName: 'notes-share', RepoBranch: 'main', PresetDomain: 'fixture.edgeone.app' };
const deployed = { DeploymentId: 'dpl-fixture', Status: 'Success', Env: 'Production', RepoBranch: 'main', RepoCommitHash: 'abc123', UsedInProd: true };
function fixture(handler) {
  const files = new Map(), secrets = new Map(), calls = [];
  const current = { ...site };
  const host = { manifest: { id: 'simple-one' }, app: { vault: { configDir: '.obsidian', getName: () => 'test',
    adapter: { getBasePath: () => '/vault', exists: async path => files.has(path), read: async path => files.get(path), write: async (path, text) => files.set(path, text) } },
    secretStorage: { getSecret: id => secrets.get(id) ?? null, setSecret: (id, value) => secrets.set(id, value) } } };
  const connection = new EdgeOneConnection(host, () => current, async () => 'abc123', () => {}, async (token, action, body) => {
    assert.equal(token, 'fixture-token'); calls.push({ action, body });
    return await handler(action, body);
  });
  return { connection, files, secrets, calls, current, host };
}
async function authorize(f) { await f.connection.load(); f.connection.draftToken = 'fixture-token'; await f.connection.verifyToken(); }

try {
  request = async args => {
    assert.equal(args.headers.Authorization, 'Bearer fixture-token');
    assert.equal(args.url, 'https://pages-api.cloud.tencent.com/v1');
    assert.equal(JSON.parse(args.body).Action, 'DescribePagesProjects');
    return { status: 200, json: { Code: 0, Data: { Response: { Projects: [] } } } };
  };
  assert.equal((await edgeOneRequest('fixture-token', 'DescribePagesProjects', {})).Projects.length, 0);
  request = async () => ({ status: 200, json: { Code: 0, Data: { Response: { Error: { Code: 'AuthFailure', Message: 'fixture-token' } } } } });
  await assert.rejects(edgeOneRequest('fixture-token', 'DescribePagesProjects', {}), /授权无效或已过期/);
  request = async () => ({ status: 500, json: { Code: 1, Message: 'failed fixture-token' } });
  await assert.rejects(edgeOneRequest('fixture-token', 'DescribePagesProjects', {}), error => !error.message.includes('fixture-token'));
  assert(matchesEdgeOneRepository(project, site));
  assert(matchesEdgeOneRepository({ ...project, RepoOwner: undefined, RepoName: undefined, RepoUrl: 'https://github.com/FIXTURE/notes-share.git' }, site));
  assert(!matchesEdgeOneRepository({ ...project, RepoBranch: 'private' }, site));
  assert(!matchesEdgeOneRepository({ ...project, RepoName: 'private-vault' }, site));
  assert.equal(edgeOneWebsite('javascript:alert(1)'), '');
  assert.equal(edgeOneWebsite('https://name:password@example.com'), '');
  assert.equal(edgeOneWebsite('fixture.edgeone.app'), 'https://fixture.edgeone.app');
  assert.equal(edgeOneDeploymentResult([deployed], 'abc123', 'main').kind, 'success');
  assert.equal(edgeOneDeploymentResult([{ ...deployed, Env: 'Preview' }], 'abc123', 'main').kind, 'pending');
  assert.equal(edgeOneDeploymentResult([{ ...deployed, UsedInProd: false }], 'abc123', 'main').kind, 'unknown');
  assert.equal(edgeOneDeploymentResult([{ ...deployed, Status: 'Failed' }], 'abc123', 'main').kind, 'error');
  assert.equal(edgeOneDeploymentResult([{ ...deployed, Status: 'Process', UsedInProd: false }], 'abc123', 'main').kind, 'pending');
  assert.equal(edgeOneDeploymentResult([{ ...deployed, RepoCommitHash: 'old' }], 'abc123', 'main').kind, 'pending');
  assert.equal(edgeOneDeploymentResult([{ ...deployed, Status: 'Failed', UsedInProd: false }, deployed], 'abc123', 'main').kind, 'success', 'active matching production version wins over a failed duplicate');
  assert.equal(edgeOneDeploymentResult([{ ...deployed, Status: 'Failed', UsedInProd: false, CreatedOn: '2026-01-01' }, { ...deployed, Status: 'Process', UsedInProd: false, CreatedOn: '2026-01-02' }], 'abc123', 'main').kind, 'pending', 'newest retry wins over an older failure');

  const f = fixture(async () => ({ Projects: [], TotalCount: 0 }));
  await authorize(f);
  assert.equal(f.connection.state.step, 2);
  assert.equal(f.secrets.size, 1);
  assert([...f.files.values()].every(text => !text.includes('fixture-token')), 'no credential in vault metadata');
  f.current.initialized = false;
  await assert.rejects(f.connection.connectProject(), /先完成笔记分享引导/);
  assert(!f.calls.some(call => call.action === 'CreatePagesProject'));
  supported = false;
  f.connection.draftToken = 'fixture-token';
  await assert.rejects(f.connection.verifyToken(), /1.11.4/);
  supported = true;

  let created = false;
  const fresh = fixture(async (action, body) => {
    if (action === 'DescribePagesProjects') return { Projects: created ? [project] : [], TotalCount: created ? 1 : 0 };
    if (action === 'CreatePagesProject') {
      assert.equal(body.Provider, 'Github'); assert.equal(body.Source, 'sdk');
      assert.equal(body.RepoUrl, 'https://github.com/fixture/notes-share');
      assert.equal(body.RepoBranch, 'main'); assert.equal(body.OutputDir, '.');
      created = true; return { ProjectId: project.ProjectId };
    }
    if (action === 'DescribePagesDeployments') return { Deployments: [deployed], TotalCount: 1 };
    throw Error(`Unexpected ${action}`);
  });
  await authorize(fresh);
  await Promise.all([fresh.connection.run(() => fresh.connection.connectProject()), fresh.connection.run(() => fresh.connection.connectProject())]);
  assert.equal(fresh.calls.filter(call => call.action === 'CreatePagesProject').length, 1, 'concurrent clicks do not create twice');
  assert.equal(fresh.connection.state.step, 3);
  assert(fresh.connection.linked);
  await fresh.connection.initializeWebsite();
  assert(fresh.connection.completed);
  assert.equal(fresh.calls.filter(call => call.action === 'CreatePagesDeployment').length, 0, 'existing matching build is not duplicated');
  assert([...fresh.files.values()].every(text => !text.includes('fixture-token')));
  const restored = new EdgeOneConnection(fresh.host, () => fresh.current, async () => 'abc123', () => {});
  await restored.load(); assert(restored.completed); assert(restored.hasToken);
  await restored.invalidateDeployment('new-commit'); assert(!restored.completed); assert.equal(restored.state.lastCheck, undefined, 'a new push clears stale deployment success');
  fresh.current.repo = 'changed-share'; assert(!fresh.connection.linked, 'old project cannot be used after repository change');

  const existing = fixture(async () => ({ Projects: [project], TotalCount: 1 }));
  await authorize(existing);
  assert.equal(existing.connection.state.step, 2, 'authorization always leads to repository step');
  assert(existing.connection.linked, 'automatically recover the unique project for this repository');
  await existing.connection.verifyToken(true); assert.equal(existing.connection.state.step, 2, 'saved authorization is actually revalidated');
  assert(!existing.calls.some(call => call.action === 'CreatePagesProject'));
  const multiple = fixture(async () => ({ Projects: [project, { ...project, ProjectId: 'pages-other', Name: 'other-share' }], TotalCount: 2 }));
  await authorize(multiple);
  assert(!multiple.connection.linked, 'multiple matching projects require a choice');
  await multiple.connection.connectProject(); assert(multiple.connection.linked);
  assert(!multiple.calls.some(call => call.action === 'CreatePagesProject'));

  let createRequests = 0;
  const delayed = fixture(async (action, body) => {
    if (action === 'CreatePagesProject') { createRequests++; return { ProjectId: project.ProjectId }; }
    if (body.ProjectIds) return { Projects: createRequests > 1 ? [project] : [], TotalCount: 0 };
    return { Projects: [], TotalCount: 0 };
  });
  await authorize(delayed);
  await assert.rejects(delayed.connection.connectProject(), /不会重复创建/);
  assert.equal(delayed.connection.state.projectId, project.ProjectId, 'created ID saved before querying it');
  await assert.rejects(delayed.connection.connectProject(), /不会重复创建/);
  assert.equal(createRequests, 1);

  let deploymentRequests = 0;
  const initialize = fixture(async action => {
    if (action === 'DescribePagesProjects') return { Projects: [project], TotalCount: 1 };
    if (action === 'CreatePagesDeployment') { deploymentRequests++; return { DeploymentId: 'dpl-fixture' }; }
    return { Deployments: deploymentRequests ? [deployed] : [], TotalCount: deploymentRequests ? 1 : 0 };
  });
  await authorize(initialize); await initialize.connection.findProjects(); await initialize.connection.connectProject();
  await initialize.connection.initializeWebsite(); assert.equal(deploymentRequests, 1); assert(initialize.connection.completed);

  const root = dom.window.document.querySelector('main');
  const ui = fixture(async () => ({ Projects: [], TotalCount: 0 }));
  await ui.connection.load();
  renderEdgeOneRow(root, ui.connection, true, false, () => {});
  assert(root.textContent.includes('开始接入引导'));
  root.replaceChildren(); renderEdgeOneGuide(root, ui.connection, true, false, () => {}, () => {});
  assert.equal(root.querySelectorAll('.simple-one-sync-setup-nav__step').length, 3);
  assert(root.querySelector('input[type="password"]'));
  assert.equal(root.querySelectorAll('.simple-share-edgeone-auth-options button').length, 2);
  assert(root.querySelector('.simple-one-sync-token-input'));
  assert(!root.querySelector('details'));
  assert(root.textContent.includes('验证已有授权'));
  assert.deepEqual([...root.querySelectorAll('.simple-share-edgeone-auth-options button')].map(button => button.textContent), ['填写 API Token', '验证已有授权']);
  assert(root.querySelectorAll('.simple-share-edgeone-auth-options button')[1].disabled, 'saved authorization requires a saved token');
  ui.connection.authMode = 'create';
  root.replaceChildren(); renderEdgeOneGuide(root, ui.connection, true, false, () => {}, () => {});
  assert(root.textContent.includes('授权时间长度'));
  assert(root.textContent.includes('授权时间长度可给长授权，过期将无法查询构建状态。'));
  assert(root.textContent.includes('打开腾讯 API Token 设置'));
  assert(!root.textContent.includes('授权平台'));
  assert.equal(root.querySelectorAll('.simple-share-edgeone-guide .simple-share-provider-links a').length, 1);
  assert.deepEqual([...root.querySelectorAll('.simple-share-edgeone-guide > p')].map(p => p.textContent), [
    '登录腾讯云，选择 EdgeOne → Makers → 设置 → API Token，点击「创建 API Token」。复制创建后的完整 API Token，粘贴到下方核验。',
    '授权时间长度可给长授权，过期将无法查询构建状态。',
    'Token 仅存在你的本地设置中。'
  ]);
  assert(root.querySelector('a[href$="?tab=settings"]').classList.contains('simple-share-external-link'));
  await authorize(ui);
  ui.connection.state.step = 1;
  ui.connection.draftToken = 'unsaved-token-must-not-be-used';
  root.replaceChildren(); renderEdgeOneGuide(root, ui.connection, true, false, () => {}, () => {});
  const callsBeforeVerify = ui.calls.length;
  root.querySelectorAll('.simple-share-edgeone-auth-options button')[1].click();
  for (let attempt = 0; ui.connection.busy && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(ui.connection.error, '');
  assert(ui.calls.length > callsBeforeVerify, 'clicking saved authorization immediately reconnects using the saved token');
  assert.equal(ui.connection.state.step, 2);
  root.replaceChildren(); renderEdgeOneGuide(root, ui.connection, true, false, () => {}, () => {});
  assert(!root.textContent.includes('关联当前笔记分享仓库'));
  assert(root.textContent.includes('尚未关联腾讯项目'));
  assert(root.textContent.includes('https://github.com/fixture/notes-share'));
  root.replaceChildren(); renderEdgeOneGuide(root, ui.connection, false, false, () => {}, () => {});
  assert([...root.querySelectorAll('.simple-share-edgeone-guide button')].every(button => button.disabled));
  root.replaceChildren(); renderEdgeOneRow(root, initialize.connection, true, false, () => {});
  assert(root.textContent.includes('检查网站部署')); assert(root.textContent.includes('正式网站已更新'));
  assert(root.querySelector('.simple-share-edgeone-result').classList.contains('simple-share-success'));
  console.log('EdgeOne: API envelopes, authorization, secret isolation, repository matching, create recovery, existing projects, production versions, initialization and three-step UI passed.');
} finally { dom.window.close(); }
