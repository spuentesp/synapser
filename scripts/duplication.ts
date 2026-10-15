export interface DuplicateBlock {
  file: string;
  line: number;
}

/** Find repeated windows after trimming lines and omitting blank and comment-only lines. */
export function findDuplicatedBlocks(sources: Readonly<Record<string, string>>, windowSize = 12): DuplicateBlock[][] {
  if (!Number.isInteger(windowSize) || windowSize < 1) throw new Error("windowSize must be a positive integer");
  const blocks = new Map<string, DuplicateBlock[]>();
  for (const [file, source] of Object.entries(sources)) {
    const lines = source.split("\n").map((text, index) => ({ text: text.trim(), line: index + 1 }))
      .filter((line) => line.text && !line.text.startsWith("//"));
    for (let i = 0; i + windowSize <= lines.length; i++) {
      const key = lines.slice(i, i + windowSize).map((line) => line.text).join("\n");
      const list = blocks.get(key) ?? [];
      list.push({ file, line: lines[i]!.line });
      blocks.set(key, list);
    }
  }
  return [...blocks.values()].filter((list) => list.length > 1);
}
