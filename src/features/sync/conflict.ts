export interface ConflictBlock {
  start: number;
  end: number;
  github: string;
  local: string;
}

const CONFLICT_PATTERN =
  /^<<<<<<<[^\r\n]*\r?\n([\s\S]*?)(?:^\|\|\|\|\|\|\|[^\r\n]*\r?\n[\s\S]*?)?^=======\r?\n([\s\S]*?)^>>>>>>>[^\r\n]*(?:\r?\n|$)/gm;

export function parseConflictBlocks(content: string): ConflictBlock[] {
  const blocks: ConflictBlock[] = [];
  for (const match of content.matchAll(CONFLICT_PATTERN)) {
    if (match.index === undefined) continue;
    blocks.push({
      start: match.index,
      end: match.index + match[0].length,
      // Merge 时 HEAD 是本机版本，另一侧是刚 Fetch 的 GitHub 版本。
      local: match[1],
      github: match[2]
    });
  }
  return blocks;
}

export function applyConflictResolutions(
  content: string,
  blocks: ConflictBlock[],
  resolutions: string[]
): string {
  if (blocks.length !== resolutions.length) throw new Error("仍有冲突没有处理");
  let result = content;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    result = result.slice(0, block.start) + resolutions[index] + result.slice(block.end);
  }
  return result;
}
