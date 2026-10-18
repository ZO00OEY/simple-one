import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import esbuild from 'esbuild';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<main></main>');
const proto = dom.window.HTMLElement.prototype;
proto.addClass = function(...classes) { this.classList.add(...classes); };
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
    configure({ buttonEl, setButtonText(text) { buttonEl.textContent = text; return this; }, setDisabled(value) { buttonEl.disabled = value; return this; }, setCta() { buttonEl.classList.add('mod-cta'); return this; }, onClick(callback) { buttonEl.addEventListener('click', callback); return this; } });
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
  RepoOwner: 'fixture', RepoName: 'notes-share', RepoBranch: 'main', PresetDomain: 'fixture.edgeone.app', Area: 'mainland' };
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
async function authorize(f) { await f.connection.load(); f.connection.authMode = 'create'; f.connection.draftToken = 'fixture-token'; await f.connection.verifyToken(); }

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
  const domains = fixture(async (action, body) => {
    assert.equal(action, 'DescribePagesProjects');
    if (body.ProjectIds) {
      assert.deepEqual(Array.from(body.ProjectIds), ['pages-fixture']);
      return { Projects: [{ ...project, CustomDomains: [
        { Domain: 'notes.example.com', Status: 'Online' },
        { Domain: 'preview.example.com', Status: 'Pending' },
      ] }] };
    }
    return { Projects: [project], TotalCount: 1 };
  });
  await authorize(domains);
  assert.deepEqual(JSON.parse(JSON.stringify(await domains.connection.customDomainsForProject('pages-fixture', site))), [
    { domain: 'notes.example.com', status: 'online' },
    { domain: 'preview.example.com', status: 'pending' },
  ], 'the saved token retrieves every custom domain on the linked project');
  await assert.rejects(domains.connection.customDomainsForProject('pages-fixture', { ...site, branch: 'other' }), /不匹配/);
  assert.equal(edgeOneDeploymentResult([deployed], 'abc123', 'main').kind, 'success');
  assert.equal(edgeOneDeploymentResult([{ ...deployed, Env: 'Preview' }], 'abc123', 'main').kind, 'pending');
  assert.equal(edgeOneDeploymentResult([{ ...deployed, UsedInProd: false }], 'abc123', 'main').kind, 'unknown');
  assert.equal(edgeOneDeploymentResult([{ ...deployed, Status: 'Failed' }], 'abc123', 'main').kind, 'error');
  assert.equal(edgeOneDeploymentResult([{ ...deployed, Status: 'Process', UsedInProd: false }], 'abc123', 'main').kind, 'pending');
  assert.equal(edgeOneDeploymentResult([{ ...deployed, RepoCommitHash: 'old' }], 'abc123', 'main').kind, 'pending');
  assert.equal(edgeOneDeploymentResult([{ ...deployed, Status: 'Failed', UsedInProd: false }, deployed], 'abc123', 'main').kind, 'success', 'active matching production version wins over a failed duplicate');
  assert.equal(edgeOneDeploymentResult([deployed, { ...deployed, DeploymentId: 'dpl-new', Status: 'Failed', UsedInProd: false }], 'abc123', 'main', 'dpl-new').kind,
    'error', 'a fresh private-repository check cannot reuse the old successful deployment');
  assert.equal(edgeOneDeploymentResult([{ ...deployed, Status: 'Failed', UsedInProd: false, CreatedOn: '2026-01-01' }, { ...deployed, Status: 'Process', UsedInProd: false, CreatedOn: '2026-01-02' }], 'abc123', 'main').kind, 'pending', 'newest retry wins over an older failure');

  const f = fixture(async () => ({ Projects: [], TotalCount: 0 }));
  await authorize(f);
  assert.equal(f.connection.state.step, 2);
  assert.equal(f.secrets.size, 1);
  assert([...f.files.values()].every(text => !text.includes('fixture-token')), 'no credential in vault metadata');
  for (const key of ['owner', 'repo']) {
    const original = f.current[key];
    f.current[key] = '';
    const callsBeforeConnect = f.calls.length;
    await assert.rejects(f.connection.connectProject(), /请先选择并验证分享仓库/);
    assert.equal(f.calls.length, callsBeforeConnect, 'missing repository details must not trigger API requests');
    f.current[key] = original;
  }
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
      assert.equal(body.Name, 'notes-share', 'project name follows the selected share repository');
      assert.equal(body.RepoUrl, 'https://github.com/fixture/notes-share');
      assert.equal(body.RepoBranch, 'main'); assert.equal(body.OutputDir, '.');
      created = true; return { ProjectId: project.ProjectId };
    }
    if (action === 'DescribePagesDeployments') return { Deployments: [deployed], TotalCount: 1 };
    throw Error(`Unexpected ${action}`);
  });
  fresh.current.initialized = false;
  await authorize(fresh);
  assert(fresh.connection.projectCheckDone, 'a new share repository is searched before its website is initialized');
  await Promise.all([fresh.connection.run(() => fresh.connection.connectProject()), fresh.connection.run(() => fresh.connection.connectProject())]);
  assert.equal(fresh.calls.filter(call => call.action === 'CreatePagesProject').length, 1, 'concurrent clicks do not create twice');
  assert.equal(fresh.connection.state.step, 3);
  assert(fresh.connection.linked, 'a verified repository can connect before website initialization');
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
  assert(existing.connection.linked, 'token verification automatically recovers the unique matching project');
  assert(existing.connection.projectCheckDone);
  await existing.connection.verifyToken(true); assert.equal(existing.connection.state.step, 2, 'saved authorization is actually revalidated');
  existing.connection.authMode = null;
  let readyCalls = 0;
  const verifyRoot = dom.window.document.createElement('div');
  renderEdgeOneGuide(verifyRoot, existing.connection, true, false, () => {}, () => {}, true, () => { readyCalls++; });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(readyCalls, 1, 'saved authorization is verified automatically and continues to the current Git deployment');
  assert(!verifyRoot.textContent.includes('通过 API Token 授权'));
  assert(!verifyRoot.textContent.includes('验证已有授权'));
  let rejectSavedToken = false;
  const invalidSaved = fixture(async () => {
    if (rejectSavedToken) throw new Error('saved token expired');
    return { Projects: [], TotalCount: 0 };
  });
  await authorize(invalidSaved);
  rejectSavedToken = true;
  invalidSaved.connection.authMode = null;
  const invalidRoot = dom.window.document.createElement('div');
  renderEdgeOneGuide(invalidRoot, invalidSaved.connection, true, false, () => {}, () => {}, true);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(invalidSaved.connection.authMode, 'create', 'failed saved authorization falls back to the token form');
  invalidRoot.replaceChildren(); renderEdgeOneGuide(invalidRoot, invalidSaved.connection, true, false, () => {}, () => {}, true);
  assert(invalidRoot.querySelector('input[type="password"]'));
  assert(invalidRoot.textContent.includes('创建 EdgeOne Makers API Token'));
  let rejectProjectLookup = false;
  const lookupFailure = fixture(async (_action, body) => {
    if (rejectProjectLookup && body.Limit === 100) throw new Error('project lookup unavailable');
    return { Projects: [], TotalCount: 0 };
  });
  await authorize(lookupFailure);
  rejectProjectLookup = true;
  lookupFailure.connection.authMode = null;
  const lookupRoot = dom.window.document.createElement('div');
  renderEdgeOneGuide(lookupRoot, lookupFailure.connection, true, false, () => {}, () => {}, true);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert(lookupFailure.connection.tokenVerified, 'a project lookup failure does not invalidate a verified API token');
  assert.equal(lookupFailure.connection.authMode, 'verify');
  lookupRoot.replaceChildren(); renderEdgeOneGuide(lookupRoot, lookupFailure.connection, true, false, () => {}, () => {}, true);
  assert(lookupRoot.textContent.includes('重新查找项目'));
  assert(!lookupRoot.querySelector('input[type="password"]'));
  existing.current.private = true;
  await existing.connection.enterRepositoryStep();
  assert(existing.connection.linked, 'project lookup matches recorded repository and branch even after visibility changes');
  assert(!existing.calls.some(call => call.action === 'CreatePagesProject'));
  const multiple = fixture(async () => ({ Projects: [project, { ...project, ProjectId: 'pages-other', Name: 'other-share' }], TotalCount: 2 }));
  await authorize(multiple);
  assert(!multiple.connection.linked, 'multiple matching projects require a choice');
  assert(multiple.connection.projectCheckDone, 'token verification automatically checks matching projects');
  const multipleRoot = dom.window.document.createElement('div');
  const privateVisibility = { private: true, checking: false, error: '', refresh: () => {} };
  renderEdgeOneGuide(multipleRoot, multiple.connection, true, false, () => {}, () => {}, true, undefined, privateVisibility);
  assert(multipleRoot.textContent.includes('选择已有项目'));
  assert.deepEqual([...multipleRoot.querySelectorAll('.simple-share-edgeone-flow-step')].map(step => step.querySelector('.setting-item').firstElementChild.firstElementChild.textContent),
    ['授权 Simple One 管理 EdgeOne Makers', '选择已有项目'], 'a successful lookup retains step two');
  assert(!multipleRoot.textContent.includes('新建项目'), 'matching projects replace the new-project form');
  assert.equal(multipleRoot.querySelectorAll('select').length, 1);
  assert(!multipleRoot.textContent.includes('分享仓库为私有'), 'project selection shows no warning before deployment');
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
  const privateRetry = fixture(async (action) => {
    if (action === 'DescribePagesProjects') return { Projects: [project], TotalCount: 1 };
    if (action === 'CreatePagesDeployment') return { DeploymentId: 'dpl-private-check' };
    return { Deployments: [deployed, { ...deployed, DeploymentId: 'dpl-private-check', Status: 'Failed', UsedInProd: false }], TotalCount: 2 };
  });
  await authorize(privateRetry);
  await assert.doesNotReject(privateRetry.connection.initializeWebsite(true));
  assert.equal(privateRetry.calls.filter(call => call.action === 'CreatePagesDeployment').length, 1,
    'private-repository verification triggers a new Git deployment despite an older successful build');
  assert.equal(privateRetry.connection.state.lastCheck.kind, 'error');
  assert.equal(privateRetry.connection.completed, false);
  initialize.connection.message = '已关联腾讯项目 notes-share，可以继续初始化或检查网站。';
  const linkedRoot = dom.window.document.createElement('div');
  renderEdgeOneGuide(linkedRoot, initialize.connection, true, false, () => {}, () => {}, true, undefined, privateVisibility);
  assert(linkedRoot.textContent.includes('授权 Simple One 管理 EdgeOne Makers'));
  assert(linkedRoot.textContent.includes('EdgeOne Makers API Token 已核验。'));
  assert(linkedRoot.textContent.includes('已关联 EdgeOne Makers 项目'));
  assert(linkedRoot.textContent.includes('本次部署未成功，且分享仓库为私有。'));
  assert(linkedRoot.querySelector('.simple-share-edgeone-project-step > p.simple-one-sync-setup-helper'),
    'a matched project is neutral before this visit verifies deployment');
  linkedRoot.replaceChildren(); renderEdgeOneGuide(linkedRoot, initialize.connection, true, true, () => {}, () => {}, true, undefined,
    undefined, '正在读取云端文件清单…');
  assert(linkedRoot.querySelector('.simple-share-edgeone-project-step progress'), 'deployment progress appears below the project heading');
  assert.equal(linkedRoot.querySelector('.simple-share-edgeone-project-step > p.simple-one-sync-setup-feedback').textContent,
    '正在读取云端文件清单…');
  const verifiedCheck = initialize.connection.state.lastCheck;
  const verifiedMessage = initialize.connection.message;
  initialize.connection.message = '最近一次分享正在部署，请稍后检查。';
  initialize.connection.state.lastCheck = { kind: 'pending', text: initialize.connection.message, commit: 'abc123', checkedAt: Date.now() };
  linkedRoot.replaceChildren(); renderEdgeOneGuide(linkedRoot, initialize.connection, true, true, () => {}, () => {}, true, undefined,
    undefined, '内容未变化，正在检查网站部署…');
  assert.equal(linkedRoot.querySelector('.simple-share-edgeone-project-step > p.simple-one-sync-setup-feedback').textContent,
    '最近一次分享正在部署，请稍后检查。', 'EdgeOne deployment status wins over duplicate publish status');
  initialize.connection.state.lastCheck = verifiedCheck;
  initialize.connection.message = verifiedMessage;
  linkedRoot.replaceChildren(); renderEdgeOneGuide(linkedRoot, initialize.connection, true, false, () => {}, () => {}, true, undefined, privateVisibility);
  assert(linkedRoot.querySelector('.simple-share-edgeone-project-step .simple-one-sync-setup-error').textContent.includes('本次部署未成功'));
  assert.equal(linkedRoot.querySelector('a[href="https://console.cloud.tencent.com/edgeone/makers"]').textContent, '查看 EdgeOne 项目及部署日志 ↗');
  assert.equal(linkedRoot.querySelector('a[href="https://github.com/settings/installations"]').textContent, '在 GitHub 检查或补充授权 ↗');
  assert.deepEqual([...linkedRoot.querySelectorAll('.simple-share-edgeone-flow-step')].map(step => step.querySelector('.setting-item').firstElementChild.firstElementChild.textContent),
    ['授权 Simple One 管理 EdgeOne Makers', '已关联 EdgeOne Makers 项目'], 'an existing project shows its region within step two');
  assert(!linkedRoot.textContent.includes('当前项目加速区域'), 'linked projects do not repeat the one-time region choice');
  assert(!linkedRoot.textContent.includes('查找 EdgeOne Makers 项目'), 'completed lookup is replaced by the linked-project result');
  assert(!linkedRoot.textContent.includes('授权并创建 EdgeOne Makers 项目'), 'linked project does not show creation controls');
  assert.equal(linkedRoot.querySelector('.simple-share-edgeone-auth-section > .simple-one-sync-setup-feedback').textContent, 'EdgeOne Makers API Token 已核验。');
  assert(!linkedRoot.querySelector('a[href="https://github.com/fixture/notes-share"]'));
  assert(initialize.connection.projectCheckDone);
  assert(!linkedRoot.textContent.includes('检查已有项目'), 'successful token verification does not require another click');
  linkedRoot.replaceChildren(); renderEdgeOneGuide(linkedRoot, initialize.connection, true, false, () => {}, () => {}, true, undefined,
    { ...privateVisibility, private: false });
  assert(!linkedRoot.textContent.includes('分享仓库为私有'));
  assert(!linkedRoot.querySelector('a[href="https://github.com/settings/installations"]'), 'public repositories hide the authorization reminder and links');
  linkedRoot.replaceChildren(); renderEdgeOneGuide(linkedRoot, initialize.connection, true, false, () => {}, () => {}, true);
  assert(linkedRoot.textContent.includes('已关联腾讯项目'));
  assert(!linkedRoot.textContent.includes('授权并创建 EdgeOne Makers 项目'));
  assert(!linkedRoot.textContent.includes('通过 API Token 授权'), 'the guide does not require a manual authorization-mode choice');

  const root = dom.window.document.querySelector('main');
  const ui = fixture(async () => ({ Projects: [], TotalCount: 0 }));
  await ui.connection.load();
  renderEdgeOneRow(root, ui.connection, true, false, () => {});
  assert(root.textContent.includes('开始接入引导'));
  root.replaceChildren(); renderEdgeOneGuide(root, ui.connection, true, false, () => {}, () => {});
  assert.equal(root.querySelectorAll('.simple-one-sync-setup-nav__step').length, 3);
  assert(root.querySelector('input[type="password"]'), 'missing saved token immediately shows the API Token form');
  assert(!root.querySelector('.simple-share-edgeone-auth-options'));
  assert(!root.querySelector('details'));
  assert(!root.textContent.includes('验证已有授权'));
  assert(root.querySelector('input[type="password"]'));
  assert.equal(root.querySelector('input[type="password"]').placeholder, '粘贴完整的 API Token');
  assert(root.querySelector('.simple-one-sync-token-input'));
  assert(!root.textContent.includes('授权时间长度'));
  assert(!root.textContent.includes('Token 仅存在你的本地设置中。'));
  assert(root.textContent.includes('创建 EdgeOne Makers API Token'));
  assert(!root.textContent.includes('授权平台'));
  assert.equal(root.querySelectorAll('.simple-share-edgeone-guide .simple-share-provider-links a').length, 1);
  assert.deepEqual([...root.querySelectorAll('.simple-share-edgeone-auth-section > p')].map(p => p.textContent), [
    '登录腾讯云，依次进入 EdgeOne → Makers → 设置 → API Token，点击「创建 API Token」。'
  ]);
  assert(root.querySelector('a[href$="?tab=settings"]').classList.contains('simple-share-external-link'));
  await authorize(ui);
  await ui.connection.load();
  assert.equal(ui.connection.authMode, null, 'loading saved authorization defers verification until the guide opens');
  ui.connection.draftToken = 'unsaved-token-must-not-be-used';
  root.replaceChildren(); renderEdgeOneGuide(root, ui.connection, true, false, () => {}, () => {});
  assert(!root.querySelector('.simple-share-edgeone-auth-options'));
  assert(!root.querySelector('input[type="password"]'), 'saved token is checked before offering a replacement form');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(ui.connection.error, '');
  assert(ui.connection.projectCheckDone, 'automatic verification also searches existing projects');
  assert(ui.connection.message.includes('未找到匹配项目'));
  ui.connection.state.step = 2;
  ui.connection.projectCheckDone = false;
  ui.connection.busy = true;
  const searchingRoot = dom.window.document.createElement('div');
  renderEdgeOneGuide(searchingRoot, ui.connection, true, false, () => {}, () => {}, true);
  assert.deepEqual([...searchingRoot.querySelectorAll('.simple-share-edgeone-flow-step')].map(step => step.querySelector('.setting-item').firstElementChild.firstElementChild.textContent),
    ['授权 Simple One 管理 EdgeOne Makers', '查找 EdgeOne Makers 项目'], 'lookup displays step two before it finishes');
  ui.connection.projectCheckDone = true;
  ui.connection.busy = false;
  assert(ui.calls.some(call => call.action === 'DescribePagesProjects'), 'the saved token was checked through the API');
  root.replaceChildren(); renderEdgeOneGuide(root, ui.connection, true, false, () => {}, () => {});
  assert(!root.textContent.includes('关联当前笔记分享仓库'));
  assert(!root.textContent.includes('查找 EdgeOne Makers 项目'), 'lookup is replaced by the new-project form');
  assert(root.textContent.includes('新建项目'), 'missing project reveals creation without another check');
  assert(!root.textContent.includes('在 GitHub 检查或补充授权'), 'without a private result no authorization reminder is shown');
  assert(!root.textContent.includes('导入 Git 仓库'), 'new project attempts creation before showing authorization guidance');
  assert(root.textContent.includes('本次使用：fixture/notes-share（main 分支）'), 'the authorized repository is identified explicitly');
  root.replaceChildren(); renderEdgeOneGuide(root, ui.connection, true, false, () => {}, () => {}, false, undefined, privateVisibility);
  assert(!root.textContent.includes('分享仓库为私有'), 'new project does not warn before a deployment attempt');
  assert(!root.querySelector('a[href="https://github.com/settings/installations"]'));
  assert(root.textContent.includes('项目名称自动使用分享仓库名：notes-share'), 'project name is shown as an automatic value');
  assert(root.textContent.includes('已在腾讯创建？重新查找'), 'a project created in the console can be adopted without a duplicate');
  assert.equal(root.querySelector('button.simple-share-find-project').textContent, '已在腾讯创建？重新查找', 'recheck action uses the outlined button style');
  assert(!root.textContent.includes('检查已有项目'), 'project lookup does not require a second click');
  assert.deepEqual([...root.querySelectorAll('.simple-share-edgeone-project-step')].map(step => step.querySelector('.setting-item').firstElementChild.firstElementChild.textContent),
    ['使用 GitHub 分享仓库', '为新建 EdgeOne Makers 项目选择加速区域']);
  const embeddedRoot = dom.window.document.createElement('div');
  renderEdgeOneGuide(embeddedRoot, ui.connection, true, false, () => {}, () => {}, true);
  assert.deepEqual([...embeddedRoot.querySelectorAll('.simple-share-edgeone-flow-step')].map(step => step.querySelector('.setting-item').firstElementChild.firstElementChild.textContent),
    ['授权 Simple One 管理 EdgeOne Makers', '使用 GitHub 分享仓库', '为新建 EdgeOne Makers 项目选择加速区域']);
  assert(!root.textContent.includes('EdgeOne Makers 支持自定义域名'), 'duplicate domain note is removed');
  assert.equal(root.querySelectorAll('.simple-share-edgeone-project-step').length, 2);
  assert.equal(root.querySelectorAll('.simple-share-edgeone-project-step input').length, 0, 'project name is not editable');
  assert(!root.querySelector('a[href="https://github.com/fixture/notes-share"]'), 'repository link is not repeated in authorization');
  assert.equal(root.querySelectorAll('select').length, 1, 'area selector is not duplicated after checking projects');
  const areaHint = root.querySelector('.simple-share-edgeone-area-note');
  assert(areaHint?.textContent.includes('有效期 3 小时'), 'mainland-capable regions explain the preview link limit');
  assert(areaHint.textContent.includes('未绑定自定义域名时，需从') && !areaHint.textContent.includes('中国大陆访问'), 'mainland-capable regions do not restrict the preview instruction to mainland visitors');
  assert(areaHint.querySelector('a[href="https://console.cloud.tencent.com/edgeone/makers"]')?.textContent === '项目概览 ↗', 'new project notice links inline to the project list');
  assert(areaHint.textContent.includes('长期访问请绑定已备案的自定义域名。'));
  const areaSelect = root.querySelector('select');
  assert(areaHint.compareDocumentPosition(areaSelect) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING, 'region explanation precedes the selector');
  areaSelect.value = 'overseas'; areaSelect.dispatchEvent(new dom.window.Event('change'));
  assert(areaHint.textContent.includes('无需备案'), 'overseas-only region explains its own access and filing rules');
  assert(!areaHint.textContent.includes('有效期 3 小时'));
  const createDenied = fixture(async action => {
    if (action === 'DescribePagesProjects') return { Projects: [], TotalCount: 0 };
    if (action === 'CreatePagesProject') throw new Error('GitHub repository access denied');
    throw new Error(`Unexpected ${action}`);
  });
  await authorize(createDenied);
  await assert.rejects(createDenied.connection.connectProject(), /access denied/);
  assert(createDenied.connection.projectCreationFailed, 'failed creation is tracked separately from deployment');
  const failedCreateRoot = dom.window.document.createElement('div');
  renderEdgeOneGuide(failedCreateRoot, createDenied.connection, true, false, () => {}, () => {}, true, undefined, privateVisibility);
  assert(failedCreateRoot.textContent.includes('分享仓库为私有，请确认 EdgeOne Makers 已获该仓库的 GitHub 授权。'));
  assert.equal(failedCreateRoot.querySelector('a[href="https://github.com/settings/installations"]').textContent,
    '在 GitHub 检查或补充授权 ↗');
  assert(failedCreateRoot.textContent.includes('在 EdgeOne 导入 GitHub 仓库'));
  areaSelect.value = 'mainland'; areaSelect.dispatchEvent(new dom.window.Event('change'));
  assert(areaHint.textContent.includes('有效期 3 小时'), 'mainland region shows the preview-link explanation again');
  assert(areaHint.textContent.includes('未绑定自定义域名时，需从') && !areaHint.textContent.includes('中国大陆访问'));
  initialize.connection.authMode = 'verify'; initialize.connection.state.step = 2; initialize.connection.projectCheckDone = true;
  root.replaceChildren(); renderEdgeOneGuide(root, initialize.connection, true, false, () => {}, () => {}, true);
  assert(!root.textContent.includes('当前项目加速区域'));
  assert(!root.textContent.includes('中国大陆'), 'linked project omits the region after initial setup');
  assert.equal(root.querySelectorAll('select').length, 0, 'existing project area is not presented as an editable setting');
  root.replaceChildren(); renderEdgeOneGuide(root, ui.connection, false, false, () => {}, () => {});
  assert([...root.querySelectorAll('.simple-share-edgeone-guide button')].every(button => button.disabled));
  root.replaceChildren(); renderEdgeOneRow(root, initialize.connection, true, false, () => {});
  assert(root.textContent.includes('检查网站部署')); assert(root.textContent.includes('正式网站已更新'));
  assert(root.querySelector('.simple-share-edgeone-result').classList.contains('simple-share-success'));
  const callsBeforeReset = initialize.calls.length;
  await initialize.connection.resetGuide();
  assert.equal(initialize.connection.linked, false);
  assert.equal(initialize.connection.completed, false);
  assert.equal(initialize.connection.authMode, null);
  assert.deepEqual(JSON.parse(JSON.stringify(initialize.connection.state)), { version: 1, step: 1 });
  assert.equal(initialize.connection.hasToken, true, 'guide restart preserves authorization');
  assert.equal(initialize.connection.area, 'global');
  assert.equal(initialize.calls.length, callsBeforeReset, 'guide restart never deletes remote projects');
  await initialize.connection.load();
  assert.equal(initialize.connection.linked, false, 'reset survives reload');
  console.log('EdgeOne: API envelopes, authorization, secret isolation, repository matching, create recovery, existing projects, production versions, initialization and three-step UI passed.');
} finally { dom.window.close(); }
