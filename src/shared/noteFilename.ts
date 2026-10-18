export function sanitizeNoteFilename(title: string): string {
  const name = title.replace(/[\\/:*?"<>|\p{Cc}]/gu, "").trim().replace(/[. ]+$/g, "");
  if (!name) return "未命名";
  return /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name) ? `_${name}` : name;
}

export function availableNotePath(folder: string, name: string, exists: (path: string) => boolean): string {
  const prefix = folder ? `${folder}/` : "";
  let path = `${prefix}${name}.md`;
  for (let index = 1; exists(path); index++) path = `${prefix}${name} ${index}.md`;
  return path;
}
