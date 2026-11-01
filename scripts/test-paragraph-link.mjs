import assert from 'node:assert/strict';
import { build } from 'esbuild';

const result = await build({ entryPoints: ['src/features/paragraphLink.ts'], bundle: true, format: 'esm', write: false });
const { paragraphLinkTarget: target } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
assert.deepEqual(target('第一段\n连续正文\n\n第二段', 0, 'so-test'), { id: 'so-test', endLine: 1, suffix: ' ^so-test' });
assert.deepEqual(target('第一段 ^existing\n\n第二段', 0, 'so-test'), { id: 'existing', endLine: 0, suffix: '' });
assert.deepEqual(target('- 第一项\n  连续内容\n- 第二项', 1, 'so-test'), { id: 'so-test', endLine: 1, suffix: ' ^so-test' });
assert.equal(target('上段\n\n选中的段落\n\n下段', 2, 'so-test').endLine, 2);
assert.equal(target('> 引用\n> 多行\n\n^existing\n', 1, 'so-test').id, 'existing');
assert.equal(target('> 引用\n> 多行', 0, 'so-test').suffix, '\n\n^so-test\n');
assert.throws(() => target('```\ncode\n\nmore code\n```', 3, 'so-test'), /代码块/);
assert.throws(() => target('正文\n\n后文', 1, 'so-test'), /正文段落/);
console.log('Paragraph links: full paragraphs, existing IDs, list items, quotes and code guards passed.');
