import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const source = ts.createSourceFile('settings.ts', fs.readFileSync('src/settings.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const pageType = source.statements.find(node => ts.isTypeAliasDeclaration(node) && node.name.text === 'SettingsPage');
const pages = new Set();
function strings(node, result) {
  if (ts.isStringLiteral(node)) result.add(node.text);
  ts.forEachChild(node, child => strings(child, result));
}
strings(pageType.type, pages);
const expected = ['overview', 'html-preview', 'link-rules', 'template-rules', 'automatic-reformat', 'calendar-diary', 'date-management', 'holiday-national', 'holiday-company'];
assert.deepEqual([...pages].sort(), expected.sort(), 'Only the new settings and their child pages may be routed');

const settingsClass = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'SimpleSettingTab');
const methods = new Map(settingsClass.members.filter(ts.isMethodDeclaration).map(node => [node.name.getText(source), node]));
const routes = new Set();
function check(node) {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'openPage') {
    const argument = node.arguments[0];
    if (argument && ts.isObjectLiteralExpression(argument)) {
      const type = argument.properties.find(property => property.name?.getText(source) === 'type');
      if (type && ts.isPropertyAssignment(type)) strings(type.initializer, routes);
    }
  }
  ts.forEachChild(node, check);
}
check(settingsClass);
for (const route of routes) assert(pages.has(route), `Unknown or legacy destination: ${route}`);
for (const page of pages) {
  if (page === 'calendar-diary') continue; // Returns to the calendar tab on the new homepage.
  assert(methods.get('renderSettings').getText(source).includes(`this.page.type === "${page}"`), `Missing renderer: ${page}`);
}
for (const name of ['renderHtmlPreviewSettings', 'renderLinkRules', 'renderTemplateRules']) {
  assert(methods.get(name).getText(source).includes('this.displayPreviewTab = "shortcuts"'), `${name} must return to the editing tab`);
}
assert(methods.get('openPage').getText(source).includes('page = { type: "overview" }'), 'Calendar child pages must return to the new homepage');
console.log('Settings navigation: new page routes, destinations, renderers and return tabs passed.');
