import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import {build} from 'esbuild';
const one=(await fs.readFile('package.json','utf8')).includes('"name": "simple-one"');
const helper=one?'src/shared/tooltipText.ts':'src/tooltipText.ts';
const files=[];
async function scan(dir){for(const e of await fs.readdir(dir,{withFileTypes:true})){const file=path.join(dir,e.name);if(e.isDirectory())await scan(file);else if(file.endsWith('.ts')&&!file.endsWith('readerPayload.ts'))files.push(file);}}
await scan('src');const violations=[];
for(const file of files){const source=await fs.readFile(file,'utf8'),sf=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);
const name=n=>n&&(ts.isIdentifier(n)||ts.isStringLiteral(n))?n.text:'';
function visit(n){
 if(ts.isObjectLiteralExpression(n)&&ts.isPropertyAssignment(n.parent)&&name(n.parent.name)==='attr'&&n.properties.some(p=>(ts.isPropertyAssignment(p)||ts.isShorthandPropertyAssignment(p))&&name(p.name)==='title'))violations.push(file+': title attribute');
 if(ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&['setAttr','setAttribute'].includes(n.expression.name.text)&&ts.isStringLiteral(n.arguments[0])&&n.arguments[0].text==='title')violations.push(file+': native title setter');
 if(ts.isBinaryExpression(n)&&ts.isPropertyAccessExpression(n.left)&&n.left.name.text==='title'&&[ts.SyntaxKind.EqualsToken,ts.SyntaxKind.PlusEqualsToken].includes(n.operatorToken.kind)&&!file.replaceAll('\\','/').endsWith('agent/runtime.ts')&&!file.endsWith('mermaidViewer.ts'))violations.push(file+': title assignment');
 ts.forEachChild(n,visit);
}visit(sf);}
assert.deepEqual(violations,[],'plugin-owned tooltips must not reintroduce native browser titles');
const built=await build({entryPoints:[helper],bundle:true,format:'esm',platform:'node',write:false});const {tooltipText,setNativeTooltip}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
assert.equal(tooltipText('复制','复制'),'复制');assert.equal(tooltipText('复制','复制当前笔记链接'),'复制当前笔记链接');assert.equal(tooltipText('恢复','跟随主题'),'恢复\n跟随主题');
class Element{createSpan(){return {tagName:'SPAN'};}constructor(tag='INPUT'){this.tagName=tag;this.attrs=new Map();this.afterNodes=[];this.ownerDocument={createElement:tag=>({tagName:tag.toUpperCase()})};}getAttribute(k){return this.attrs.get(k)??null;}setAttribute(k,v){this.attrs.set(k,String(v));}removeAttribute(k){this.attrs.delete(k);}hasAttribute(k){return this.attrs.has(k);}after(n){this.afterNodes.push(n);}}
const input=new Element();input.setAttribute('aria-label','请求地址');input.setAttribute('title','旧提示');setNativeTooltip(input,'自动补全路径');assert.equal(input.hasAttribute('title'),false);assert.equal(input.getAttribute('aria-label'),'自动补全路径');assert.equal(input.afterNodes[0].textContent,'请求地址');assert.equal(input.afterNodes[0].hidden,true);assert.equal(input.getAttribute('aria-labelledby'),input.afterNodes[0].id);setNativeTooltip(input,'新的实际地址');assert.equal(input.afterNodes.length,1);
const unnamed=new Element();setNativeTooltip(unnamed,'旧说明');setNativeTooltip(unnamed,'新说明');assert.equal(unnamed.afterNodes.length,0,'an earlier tooltip must not become the accessible name');
if(one){const mermaid=await fs.readFile('src/shared/mermaidViewer.ts','utf8');assert(mermaid.includes('if (!icon) control.title = label;'));const toolbar=await fs.readFile('src/features/selectionToolbar.ts','utf8');assert(toolbar.includes('el.setAttribute("aria-label", label)'));}
console.log(`Native tooltip audit passed: ${files.length} source files; merged descriptions, no browser titles, accessible names, dynamic updates and browser-only diagram fallback.`);
