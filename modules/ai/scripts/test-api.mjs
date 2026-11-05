import { build } from "esbuild";
import assert from "node:assert/strict";

async function moduleAt(path) {
  const result = await build({ entryPoints: [path], bundle: true, write: false, format: "esm", platform: "browser", target: "es2020" });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}`);
}
const { ApiClient, endpoint, completeSourceAddresses } = await moduleAt("src/api/client.ts");
const { ReplyStream } = await moduleAt("src/agent/stream.ts");
const { newSource, label, validateSource, defaults } = await moduleAt("src/api/types.ts");
const source = { ...newSource(), name: "test", url: "https://example.invalid" };
let checks = 0;
async function check(name, fn) { await fn(); checks++; console.log(`PASS ${name}`); }
const reply = (data, status = 200) => ({ status, text: JSON.stringify(data) });

await check("Saved addresses show completed paths without freezing automatic model URLs", () => {
  const saved=completeSourceAddresses(source);
  assert.equal(saved.url,"https://example.invalid/v1/chat/completions");assert.equal(saved.modelsUrl,"");
  assert.deepEqual(completeSourceAddresses(saved),saved);
  assert.equal(endpoint({...saved,url:"https://changed.invalid/v2"},"models"),"https://changed.invalid/v2/models");
  assert.equal(completeSourceAddresses({...source,urlMode:"full",url:"https://example.invalid/custom"}).url,"https://example.invalid/custom");
});
await check("URL modes preserve proxy paths and avoid duplicate v1", () => {
  assert.equal(endpoint(source, "chat"), "https://example.invalid/v1/chat/completions");
  assert.equal(endpoint({ ...source, url: "https://example.invalid/proxy/v1/" }, "models"), "https://example.invalid/proxy/v1/models");
  assert.equal(endpoint({ ...source, protocol: "anthropic" }, "chat"), "https://example.invalid/v1/messages");
  assert.equal(endpoint({ ...source, urlMode: "full", url: "https://example.invalid/custom?version=2" }, "chat"), "https://example.invalid/custom?version=2");
  assert.equal(endpoint({ ...source, urlMode: "full" }, "models"), "https://example.invalid/v1/models");
  assert.equal(endpoint({ ...source, urlMode: "full", modelsUrl: "https://example.invalid/catalog" }, "models"), "https://example.invalid/catalog");
  assert.throws(() => endpoint({ ...source, url: "file:///tmp" }, "chat"));
  assert.equal(endpoint({ ...source, url: "https://example.invalid/v1/chat/completions" }, "chat"), "https://example.invalid/v1/chat/completions");
  assert.equal(endpoint({ ...source, url: "https://example.invalid/v1///" }, "chat"), "https://example.invalid/v1/chat/completions");
  assert.equal(endpoint({ ...source, urlMode: "full", url: "https://example.invalid/v1/chat/completions/" }, "chat"), "https://example.invalid/v1/chat/completions/");
  assert.equal(endpoint({ ...source, urlMode: "full", url: "https://example.invalid/v1/chat/completions/" }, "models"), "https://example.invalid/v1/models");
  assert.equal(endpoint({ ...source, protocol: "anthropic", urlMode: "full", url: "https://example.invalid/v1/messages/" }, "models"), "https://example.invalid/v1/models");
});
await check("Auto completion handles version roots, complete paths and locked endpoints", () => {
  for (const url of ["https://example.invalid/proxy/v1", "https://example.invalid/proxy/v1/chat", "https://example.invalid/proxy/v1/chat/completions/"]) {
    assert.equal(endpoint({ ...source, url }, "chat"), "https://example.invalid/proxy/v1/chat/completions");
    assert.equal(endpoint({ ...source, url }, "models"), "https://example.invalid/proxy/v1/models");
  }
  assert.equal(endpoint({ ...source, protocol: "anthropic", url: "https://example.invalid/v1/messages?version=2" }, "chat"), "https://example.invalid/v1/messages?version=2");
  assert.equal(endpoint({ ...source, url: "https://example.invalid/proxy/v2/" }, "chat"), "https://example.invalid/proxy/v2/chat/completions");
  const locked = "https://example.invalid/custom%2Froute/?version=2";
  assert.equal(endpoint({ ...source, urlMode: "full", url: locked }, "chat"), locked);
  assert.equal(endpoint({ ...source, urlMode: "full", modelsUrl: "https://example.invalid/catalog", url: locked }, "models"), "https://example.invalid/catalog");
});
await check("Model list URLs support independent auto completion and exact locking", () => {
  for(const url of ["https://example.invalid/v1","https://example.invalid/v2/","https://example.invalid/v1/chat/completions","https://example.invalid/custom"]){
    assert.equal(endpoint({...source,url,urlMode:"base",modelsUrlMode:"base"},"models"),endpoint({...source,url,urlMode:"full",modelsUrlMode:"base"},"models"),"request locking must not change automatic list generation");
  }

  for (const modelsUrl of ["https://example.invalid/proxy/v1", "https://example.invalid/proxy/v1/models/", "https://example.invalid/proxy/v1/chat/completions"]) {
    assert.equal(endpoint({ ...source, modelsUrl, modelsUrlMode: "base" }, "models"), "https://example.invalid/proxy/v1/models");
  }
  assert.equal(endpoint({ ...source, modelsUrlMode: "base" }, "models"), "https://example.invalid/v1/models");
  const modelsUrl = "https://example.invalid/catalog%2Flist/?version=2";
  assert.equal(endpoint({ ...source, modelsUrl, modelsUrlMode: "full" }, "models"), modelsUrl);
  assert.equal(endpoint({ ...source, modelsUrl }, "models"), modelsUrl);
  assert.throws(() => endpoint({ ...source, modelsUrlMode: "full" }, "models"), /完整的模型列表地址/);
  assert.equal(endpoint({ ...source, modelsUrl, modelsUrlMode: "full" }, "chat"), "https://example.invalid/v1/chat/completions");
});
await check("Model labels and duplicate validation", () => {
  assert.equal(defaults().showSourceName, true);
  assert.equal(label({ ...source, name: "CPA", prefix: "旧前缀" }, { id: "actual-id", alias: "日常" }), "[CPA] 日常");
  assert.equal(label({ ...source, name: "CPA" }, { id: "actual-id", alias: "日常" }, false), "日常");
  assert.equal(label({ ...source, name: "CP" }, { id: "actual-id", alias: "" }), "[CP] actual-id");
  assert.throws(() => validateSource({ ...source, models: [{ id: "a", alias: "" }, { id: " a ", alias: "" }] }), /重复/);
});
await check("OpenAI headers, raw model ID and Hello test", async () => {
  let captured;
  const client = new ApiClient(async request => { captured = request; return reply({ choices: [{ message: { content: "Hi" } }] }); });
  assert.equal((await client.test(source, "test-secret", "actual-id")).reply, "Hi");
  assert.equal(captured.headers.Authorization, "Bearer test-secret");
  assert.equal(captured.headers["x-api-key"], undefined);
  assert.equal(JSON.parse(captured.body).model, "actual-id");
  assert.equal(JSON.parse(captured.body).messages[0].content, "Hello");
});
await check("Anthropic headers and content blocks", async () => {
  const client = new ApiClient(async request => {
    assert.equal(request.headers["x-api-key"], "test-secret");
    assert.equal(request.headers["anthropic-version"], "2023-06-01");
    assert.equal(JSON.parse(request.body).max_tokens, 128);
    return reply({ content: [{ type: "text", text: "Hello" }] });
  });
  assert.equal((await client.test({ ...source, protocol: "anthropic" }, "test-secret", "a")).reply, "Hello");
});
await check("Paginated model list deduplicates and uses same endpoint", async () => {
  let calls = 0;
  const client = new ApiClient(async request => {
    calls++;
    if (calls === 1) return reply({ data: [{ id: "b" }, { id: "a" }], has_more: true, last_id: "a" });
    assert.equal(new URL(request.url).searchParams.get("after_id"), "a");
    return reply({ data: [{ id: "a" }, { id: "c" }], has_more: false });
  });
  assert.deepEqual(await client.listModels(source, ""), ["a", "b", "c"]);
});
await check("Pagination loops fail instead of pretending all models were fetched", async () => {
  const client = new ApiClient(async () => reply({ data: [{ id: "a" }], has_more: true, last_id: "a" }));
  await assert.rejects(client.listModels(source, ""), /分页/);
});
await check("Errors hide the key and reject invalid response bodies", async () => {
  const client = new ApiClient(async () => reply({ error: { message: "bad key test-secret" } }, 401));
  await assert.rejects(client.test(source, "test-secret", "a"), e => e.message.includes("401") && !e.message.includes("test-secret"));
  await assert.rejects(new ApiClient(async () => ({ status: 200, text: "<html>" })).listModels(source, ""), /JSON/);
  await assert.rejects(new ApiClient(async () => reply({})).test(source, "", "a"), /返回格式/);
});
await check("List errors retain status and provider details; empty responses are explicit", async () => {
  for(const [status,hint] of [[401,"认证失败"],[403,"访问被拒绝"],[404,"地址不存在"],[429,"请求受限"]]){
    await assert.rejects(new ApiClient(async()=>reply({error:{message:"provider detail test-secret"}},status)).listModels(source,"test-secret"),e=>e.message.includes("HTTP "+status)&&e.message.includes(hint)&&e.message.includes("provider detail")&&!e.message.includes("test-secret"));
  }
  await assert.rejects(new ApiClient(async()=>({status:200,text:""})).listModels(source,""),/返回为空/);
  await assert.rejects(new ApiClient(async()=>reply({data:[]})).listModels(source,""),/模型列表为空/);
});
await check("Timeout is bounded and does not automatically repeat a paid call", async () => {
  let calls = 0;
  const client = new ApiClient(() => { calls++; return new Promise(() => {}); }, 5);
  await assert.rejects(client.test(source, "", "a"), /超时/);
  assert.equal(calls, 1);
});
await check("503 preserves gateway errors, explains 1102 and never repeats the request", async () => {
  for (const response of [
    { status: 503, text: 'error code: 1102' },
    { status: 503, text: '<html><body>error code: 1102</body></html>' },
    reply({ error: { message: 'error code: 1102 test-secret' } }, 503),
  ]) {
    let calls = 0;
    const client = new ApiClient(async () => { calls++; return response; });
    await assert.rejects(client.chat(source, 'test-secret', 'a', '', [{role:'user',text:'hello'}], []), error => error.message.includes('HTTP 503') && error.message.includes('1102') && error.message.includes('资源超限') && !error.message.includes('test-secret'));
    assert.equal(calls, 1);
  }
  await assert.rejects(new ApiClient(async () => ({status:503,text:'upstream unavailable'})).test(source, '', 'a'), error => error.message.includes('上游服务暂时不可用') && !error.message.includes('1102') && !error.message.includes('检查请求地址'));
});
const sse = value => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\r\n\r\n`;
await check("OpenAI streaming assembles split Unicode, reasoning, tool JSON and usage before executing anything", async () => {
  const previews = [], wire = [
    {choices:[{index:0,delta:{reasoning_content:'check first'}}]},
    {choices:[{index:0,delta:{content:'你好'}}]},
    {choices:[{index:0,delta:{tool_calls:[{index:0,id:'c1',type:'function',function:{name:'read_note',arguments:'{"path":'}}]}}]},
    {choices:[{index:0,delta:{tool_calls:[{index:0,function:{arguments:'"Notes/a.md"}'}}]},finish_reason:'tool_calls'}]},
    {choices:[],usage:{prompt_tokens:12,completion_tokens:4}}, '[DONE]',
  ].map(sse).join('');
  let requests = 0;
  const client = new ApiClient(async () => { throw new Error('must not use buffered transport'); }, 30000, async (url,init) => {
    requests++; assert.equal(JSON.parse(init.body).stream,true);
    const bytes = new TextEncoder().encode(wire);
    return new Response(new ReadableStream({start(controller){ for(const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); }}), {headers:{'content-type':'text/event-stream'}});
  });
  const message = await client.chat(source,'','m','',[],[],undefined,partial=>previews.push({...partial}));
  assert.equal(message.text,'你好'); assert.equal(message.reasoning,'check first'); assert.equal(message.calls[0].arguments.path,'Notes/a.md');
  assert.equal(message.usage.inputTokens,12); assert.equal(requests,1); assert(previews.some(p=>p.reasoning && !p.text));
});
await check("Anthropic streaming retains separate thinking, complete tool input and combined usage", () => {
  const stream = new ReplyStream('anthropic',()=>{});
  const events = [
    {type:'message_start',message:{usage:{input_tokens:8}}},
    {type:'content_block_start',index:0,content_block:{type:'thinking',thinking:''}},
    {type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'source check'}},
    {type:'content_block_start',index:1,content_block:{type:'text',text:''}},
    {type:'content_block_delta',index:1,delta:{type:'text_delta',text:'answer'}},
    {type:'content_block_start',index:2,content_block:{type:'tool_use',id:'c2',name:'read_note',input:{}}},
    {type:'content_block_delta',index:2,delta:{type:'input_json_delta',partial_json:'{"path":"Notes/a.md"}'}},
    {type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:5}},
    {type:'message_stop'},
  ];
  for(const event of events) stream.push(sse(event));
  const result = stream.finish(); assert.equal(result.reasoning,'source check'); assert.equal(result.text,'answer');
  assert.equal(result.calls[0].arguments.path,'Notes/a.md'); assert.equal(result.usage.inputTokens,8); assert.equal(result.usage.outputTokens,5);
});
await check("Incomplete, truncated and malformed streaming tools are rejected", () => {
  const unfinished = new ReplyStream('openai',()=>{}); unfinished.push(sse({choices:[{delta:{content:'partial'}}]}));
  assert.throws(()=>unfinished.finish(),/提前断开/);
  for(const reason of ['length','tool_calls']) {
    const stream = new ReplyStream('openai',()=>{});
    stream.push(sse({choices:[{delta:{tool_calls:[{index:0,id:'x',function:{name:'read_note',arguments:'{"path":'}}]},finish_reason:reason}]}));
    assert.throws(()=>stream.finish(),/截断|完整 JSON/);
  }
  const error = new ReplyStream('anthropic',()=>{}); assert.throws(()=>error.push(sse({type:'error',error:{message:'overloaded'}})),/overloaded/);
});
await check("Streaming handles ordinary JSON, legacy preferences, gateway failure and abort without hidden retries", async () => {
  let streamCalls=0, buffered=0;
  const client = new ApiClient(async()=>{buffered++;return reply({choices:[{message:{content:'buffered'}}]});},30000,async()=>{streamCalls++;return new Response(JSON.stringify({choices:[{message:{content:'ordinary'}}]}),{headers:{'content-type':'application/json'}});});
  assert.equal((await client.chat(source,'','m','',[],[],undefined,()=>{})).text,'ordinary');
  assert.equal((await client.chat({...source,streaming:false},'','m','',[],[],undefined,()=>{})).text,'ordinary');
  assert.equal(streamCalls,2); assert.equal(buffered,0);
  const gateway = new ApiClient(async()=>{throw new Error('no retry');},30000,async()=>new Response('error code: 1102',{status:503}));
  await assert.rejects(gateway.chat(source,'','m','',[],[],undefined,()=>{}),/资源超限/);
  const controller = new AbortController(); let previews=0;
  const aborted = new ApiClient(async()=>{throw new Error('no retry');},30000,async()=>{
    controller.abort(); return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(sse({choices:[{delta:{content:'late'},finish_reason:'stop'}]})));c.close();}}),{headers:{'content-type':'text/event-stream'}});
  });
  await assert.rejects(aborted.chat(source,'','m','',[],[],controller.signal,()=>previews++),/已停止/); assert.equal(previews,0);
});
console.log(`${checks} API checks passed; no real network requests or keys used.`);
