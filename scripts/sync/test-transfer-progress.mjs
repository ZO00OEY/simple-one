import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['src/features/sync/transferProgress.ts'], bundle: true, format: 'esm', platform: 'node', write: false });
const { transferProgress } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const messages = [];
const upload = transferProgress('上传', text => messages.push(text));
upload('Counting objects: 100% (13/13)\rCompressing objects: 50% (5/10)\r');
assert.deepEqual(messages, []);
upload('Writing obj');
upload('ects: 38% (5/13)\rWriting objects: 38% (5/13)\rWriting objects: 100% (13/13), done.\n');
assert.deepEqual(messages, ['正在上传 5/13', '正在上传 13/13']);
const download = transferProgress('下载', text => messages.push(text));
download('remote: Writing objects: 100% (8/8)\rReceiving objects: 37% (3/8)\rResolving deltas: 100% (2/2)\n');
assert.equal(messages.at(-1), '正在下载 3/8');
console.log('Transfer progress: counts, split chunks, duplicates and phase filtering passed');
