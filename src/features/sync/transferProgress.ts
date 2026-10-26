export function transferProgress(direction: "上传" | "下载", report: (text: string) => void): (chunk: string) => void {
  const phase = direction === "上传" ? "Writing objects" : "Receiving objects";
  let pending = "";
  let previous = "";
  return chunk => {
    const lines = (pending + chunk).split(/[\r\n]/);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const match = line.match(/(Writing objects|Receiving objects):\s*\d+%\s*\((\d+)\/(\d+)\)/);
      if (!match || match[1] !== phase) continue;
      const text = `正在${direction} ${match[2]}/${match[3]}`;
      if (text === previous) continue;
      previous = text;
      report(text);
    }
  };
}
