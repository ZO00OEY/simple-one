import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
globalThis.window = globalThis;
const require=createRequire(import.meta.url);let requests=[],reply={data:[{id:'one'},{id:'two'},{id:'one'}]},status=200,transport;
const bundled=await build({stdin:{contents:'export * from "./src/features/translationApi"; export { translationProvider, translationService } from "./src/features/selectionTranslation";',resolveDir:process.cwd()},bundle:true,platform:'node',format:'cjs',write:false,external:['obsidian']});
const module={exports:{}};
const obsidian={Modal:class{},requireApiVersion:()=>true,requestUrl:async request=>{requests.push(request);if(transport)return transport(request);return {status,text:JSON.stringify(reply)};}};
new Function('require','module','exports',bundled.outputFiles[0].text)(name=>name==='obsidian'?obsidian:require(name),module,module.exports);
const {translationEndpoint,completeTranslationAddresses,fetchTranslationModels,customTranslate,translationProvider,translationService}=module.exports;
const api={protocol:'openai',url:'https://example.com/v1',modelsUrl:'',models:['one']};
for(const url of ['https://example.com','https://example.com/v1/','https://example.com/v1/chat/completions'])assert.equal(translationEndpoint({...api,url},'chat'),'https://example.com/v1/chat/completions');
assert.equal(translationEndpoint(api,'models'),'https://example.com/v1/models');
for(const url of ['https://example.com/v1','https://example.com/v2/','https://example.com/v1/chat/completions','https://example.com/custom']){
  assert.equal(translationEndpoint({...api,url,urlMode:'base',modelsUrlMode:'base'},'models'),translationEndpoint({...api,url,urlMode:'full',modelsUrlMode:'base'},'models'),'request and model-list locks are independent');
}

const completed=completeTranslationAddresses(api);
assert.equal(completed.url,'https://example.com/v1/chat/completions');assert.equal(completed.modelsUrl,'');
assert.deepEqual(completeTranslationAddresses(completed),completed,'saving again does not append a second suffix');
assert.equal(translationEndpoint({...completed,url:'https://changed.example/v2'},'models'),'https://changed.example/v2/models','automatic model URLs continue following request edits');
assert.equal(completeTranslationAddresses({...api,urlMode:'full',url:'https://example.com/custom'}).url,'https://example.com/custom');

assert.equal(translationEndpoint({...api,url:'https://example.com/v2'},'models'),'https://example.com/v2/models');
assert.equal(translationEndpoint({...api,modelsUrlMode:'base',modelsUrl:'https://example.com/proxy/v2'},'models'),'https://example.com/proxy/v2/models');
assert.equal(translationEndpoint({...api,modelsUrlMode:'full',modelsUrl:'https://example.com/catalog'},'models'),'https://example.com/catalog');
assert.throws(()=>translationEndpoint({...api,modelsUrlMode:'full'},'models'),/完整模型列表地址/);

assert.equal(translationEndpoint({...api,urlMode:'full',url:'https://example.com/custom?version=2'},'chat'),'https://example.com/custom?version=2');
assert.equal(translationEndpoint({...api,urlMode:'full',url:'https://example.com/v1/chat/completions'},'models'),'https://example.com/v1/models');
assert.equal(translationEndpoint({...api,urlMode:'full',url:'https://example.com/custom'},'models'),'https://example.com/custom/v1/models');

assert.equal(translationEndpoint({...api,protocol:'anthropic'},'chat'),'https://example.com/v1/messages');
assert.equal(translationEndpoint({...api,modelsUrl:'https://example.com/catalog?format=json'},'models'),'https://example.com/catalog?format=json');
assert.throws(()=>translationEndpoint({...api,url:'file:///private'},'chat'));
assert.throws(()=>translationEndpoint({...api,url:'https://user:pass@example.com'},'chat'));
assert.deepEqual(await fetchTranslationModels(api,'secret'),['one','two']);assert.equal(requests.at(-1).headers.Authorization,'Bearer secret');
reply={choices:[{message:{content:'翻译结果'}}]};
assert.equal(await customTranslate(api,'secret',{modelId:'one',text:'原文',prompt:'只翻译'}),'翻译结果');
assert.deepEqual(JSON.parse(requests.at(-1).body).messages,[{role:'system',content:'只翻译'},{role:'user',content:'原文'}]);
reply={content:[{type:'thinking',thinking:'private'},{type:'text',text:'译文'}]};
assert.equal(await customTranslate({...api,protocol:'anthropic'},'secret',{modelId:'one',text:'原文',prompt:'只翻译'}),'译文');
assert.equal(requests.at(-1).headers['x-api-key'],'secret');assert.equal(requests.at(-1).headers['anthropic-version'],'2023-06-01');assert.equal(JSON.parse(requests.at(-1).body).system,'只翻译');
status=401;await assert.rejects(fetchTranslationModels(api,'secret'),/HTTP 401/);status=200;
for(const [code,hint]of [[401,'认证失败'],[403,'访问被拒绝'],[404,'地址不存在'],[429,'请求受限']]){status=code;reply={error:{message:'provider detail secret'}};await assert.rejects(fetchTranslationModels(api,'secret'),e=>e.message.includes('HTTP '+code)&&e.message.includes(hint)&&e.message.includes('provider detail')&&!e.message.includes('secret'));}
status=200;reply={data:[]};await assert.rejects(fetchTranslationModels(api,''),/模型列表为空/);
transport=async()=>({status:200,text:''});await assert.rejects(fetchTranslationModels(api,''),/返回为空/);transport=undefined;
reply={};await assert.rejects(fetchTranslationModels(api,''),/没有模型列表/);

transport=async()=>{throw Error('Bearer secret network failed secret');};await assert.rejects(fetchTranslationModels(api,'secret'),e=>!e.message.includes('secret'));
let finish;transport=()=>new Promise(resolve=>{finish=resolve;});const controller=new AbortController();const pending=customTranslate(api,'secret',{modelId:'one',text:'原文',prompt:'只翻译'},controller.signal);controller.abort();await assert.rejects(pending,e=>e.name==='AbortError');finish({status:200,text:'{}'});transport=undefined;
assert.equal(translationProvider(undefined),'custom');assert.equal(translationProvider({sourceId:'legacy-source'}),'simple-ai');
const legacyBridge={getTranslationModels:()=>[{sourceId:'legacy',modelId:'m',label:'M'}],translateSelection:async()=> 'legacy'};
const config={provider:'custom',api,sourceId:'custom',modelId:'one',preset:'parallel',prompt:'prompt'};
const plugin={manifest:{id:'simple-one'},settings:{enhancements:{quickFormat:{translation:config}}},app:{secretStorage:{getSecret:id=>{assert.equal(id,'simple-one-translation-api');return 'secret';}},plugins:{plugins:{'simple-ai':legacyBridge}}}};
reply={choices:[{message:{content:'new'}}]};assert.equal(await translationService(plugin).translateSelection({modelId:'one',text:'x',prompt:'p',sourceId:'custom'}),'new');
assert(!JSON.stringify(plugin.settings).includes('secret'));
config.provider='simple-ai';assert.equal(translationService(plugin),legacyBridge);delete config.provider;config.sourceId='legacy';assert.equal(translationService(plugin),legacyBridge);
console.log('Translation API passed: URL completion, model fetching, both protocols, errors/redaction, cancellation, secret storage, custom routing and legacy Simple AI compatibility.');
