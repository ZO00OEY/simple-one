import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
import { transform } from "esbuild";

const source = fs.readFileSync("src/features/diary.ts", "utf8");
const parsed = ts.createSourceFile("diary.ts", source, ts.ScriptTarget.Latest, true);
const names = ["insertRecurringPlansIntoContent", "insertDateRemindersIntoContent", "anniversaryReminderLinesForDate"];
const functions = parsed.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text)).map(node => node.getText(parsed));
assert.equal(functions.length, 3);
const output = await transform(functions.join("\n"), { loader: "ts" });
const methods = new Function("holidaySetupReminderLinesForDate", `${output.code}\nreturn {${names.join(",")}};`)(() => []);
const content = "Existing diary content";
const date = new Date(2026, 9, 27);
const disabled = { settings: { diary: { autoRemindersEnabled: false } } };
assert.deepEqual(methods.insertRecurringPlansIntoContent(disabled, date, content), { content, added: 0 });
assert.deepEqual(methods.insertDateRemindersIntoContent(disabled, date, content), { content, added: 0 });
assert.deepEqual(methods.anniversaryReminderLinesForDate(disabled.settings.diary, date), []);
const legacy = { settings: { diary: { recurringRules: [], dateManagement: { reminderWriting: { enabled: false }, holidaySetupReminder: { writeToTips: true } } } } };
assert.deepEqual(methods.insertRecurringPlansIntoContent(legacy, date, content), { content, added: 0 });
assert.deepEqual(methods.insertDateRemindersIntoContent(legacy, date, content), { content, added: 0 });
console.log("Diary reminder switch: recurring, anniversary and holiday writing disabled without changing rules; legacy settings remain supported.");
const openFunction = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "openOrCreateDiaryNote");
const openOutput = await transform(openFunction.getText(parsed), { loader: "ts" });
let existing = null;
let created = 0;
let opened = 0;
const openDiary = new Function("diaryPathForDate", "diaryFileForDate", "ensureFolder", `${openOutput.code}\nreturn openOrCreateDiaryNote;`)(
  () => "test.md", () => existing, () => { created++; throw new Error("unexpected creation"); }
);
const plugin = { settings: { diary: {} }, app: { workspace: { getLeaf: () => ({ openFile: async () => { opened++; } }) } } };
assert.equal(await openDiary(plugin, date, false), null);
assert.equal(created, 0, "disabled date click creates no folder or file");
existing = { path: "test.md" };
assert.equal(await openDiary(plugin, date, false), existing);
assert.equal(opened, 1, "disabled creation still opens existing diaries");
console.log("Calendar date click: disabling creation preserves opening existing diaries.");
