import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import esbuild from 'esbuild';
import {JSDOM} from 'jsdom';
const directory=await fs.mkdtemp(path.resolve('../../../.codex/output/share-appearance-'));
try {
  await esbuild.build({entryPoints:['src/features/share/appearance.ts'],bundle:true,platform:'node',format:'cjs',outfile:path.join(directory,'appearance.cjs'),logLevel:'silent'});
  const {shareAppearance}=createRequire(import.meta.url)(path.join(directory,'appearance.cjs'));
  const dom=new JSDOM('<body></body>');
  globalThis.document=dom.window.document;
  dom.window.HTMLElement.prototype.createDiv=function({cls}){const el=document.createElement('div');el.className=cls;this.append(el);return el;};
  globalThis.getComputedStyle=dom.window.getComputedStyle.bind(dom.window);
  const settings={desktopTypography:{enabled:true,fontSize:18,lineHeight:1.7,letterSpacing:.05,paragraphSpacing:.8},themeFormatting:{highlightBackground:'#ffd00066',boldColor:'#e60f61'},enhancements:{quickFormat:{headingColors:{h1:'#222222',h2:'',h4:'#478f14'},headingSizes:{h5:'12',h6:'18'},calloutColors:{},customCallouts:[]}}};
  const css=shareAppearance({settings});
  assert(css.includes('--share-h1-color:var(--share-heading-neutral,#222222)'));
  assert(css.includes('--share-h4-color:#478f14'));
  assert(!css.includes('--share-h2-color'), 'restored colors remain theme dependent');
  assert(css.includes('--share-h5-size:12px'), 'reader applies the body-size floor independently');
  assert(css.includes('--share-default-size:18px'));
  assert(css.includes('--share-highlight-bg:#ffd00066'), 'highlight transparency is preserved');
  assert(css.includes('--share-bold-default:#e60f61'));
  assert(!css.includes('--callout-color:'), 'unconfigured Callouts must not capture the current Obsidian theme');
  settings.enhancements.quickFormat.calloutColors.warning='#aabbcc';
  settings.enhancements.quickFormat.customCallouts=[{type:'小贴士',color:'#a20b0b'},{type:'bad\"type',color:'#ff0000'}];
  const configured=shareAppearance({settings});
  assert(configured.includes('.callout[data-callout="caution"]{--callout-color:#aabbcc}'), 'aliases share their explicit color');
  assert(configured.includes('.callout[data-callout="小贴士"]{--callout-color:#a20b0b}'), 'Chinese custom types are supported');
  assert(!configured.includes('bad"type'), 'invalid CSS selector types are rejected');
  settings.displayParameterSwitches={desktop:{fontSize:false}};
  assert(!shareAppearance({settings}).includes('--share-default-size:'));
  // Use the same exporter for the local preview, without exposing private settings.
  if(process.argv.includes('--preview')){
    const preview=path.resolve('../../../.codex/output/share-reader-left-preview/index.html');
    await fs.copyFile('default.html',preview);
  }
  dom.window.close();
  console.log('Share appearance passed: explicit colors, restored theme colors, alpha highlight, sizes and disabled typography.');
} finally {await fs.rm(directory,{recursive:true,force:true});}
