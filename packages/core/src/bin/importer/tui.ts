import readline from "node:readline";

const PAGE_SIZE = 15;

export async function interactiveSelect(title: string, options: string[], multi: true): Promise<string[]>;
export async function interactiveSelect(title: string, options: string[], multi: false): Promise<string>;
export async function interactiveSelect(
  title: string,
  options: string[],
  multi: boolean,
): Promise<string | string[]> {
  return new Promise((resolve) => {
    const { stdout, stdin } = process;
    if (!(stdin as any).isTTY) {
      resolve(multi ? [...options] : options[0]);
      return;
    }
    readline.emitKeypressEvents(stdin);
    (stdin as any).setRawMode(true);
    let cursor = 0;
    const selected = new Set<number>();
    const render = () => {
      stdout.write("\x1B[H\x1B[2J");
      stdout.write(`\n  ${title}\n`);
      stdout.write(
        multi
          ? "  ↑/↓ move  ·  Space toggle  ·  A select-all  ·  Enter confirm\n\n"
          : "  ↑/↓ move  ·  Enter confirm\n\n",
      );
      const startIdx = Math.min(
        Math.max(0, cursor - Math.floor(PAGE_SIZE / 2)),
        Math.max(0, options.length - PAGE_SIZE),
      );
      const endIdx = Math.min(options.length, startIdx + PAGE_SIZE);
      stdout.write(startIdx > 0 ? "  (↑ more)\n" : "\n");
      for (let i = startIdx; i < endIdx; i++) {
        const arrow = i === cursor ? "> " : "  ";
        const box = multi ? (selected.has(i) ? "[x] " : "[ ] ") : "";
        stdout.write(`  ${arrow}${box}${options[i]}\n`);
      }
      stdout.write(endIdx < options.length ? "  (↓ more)\n" : "\n");
    };
    render();
    const onKey = (_str: any, key: any) => {
      if (key.ctrl && key.name === "c") { (stdin as any).setRawMode(false); process.exit(1); }
      if (key.name === "up")            cursor = (cursor - 1 + options.length) % options.length;
      else if (key.name === "down")     cursor = (cursor + 1) % options.length;
      else if (key.name === "space" && multi)
        selected.has(cursor) ? selected.delete(cursor) : selected.add(cursor);
      else if (key.name === "a" && multi)
        selected.size === options.length ? selected.clear() : options.forEach((_, i) => selected.add(i));
      else if (key.name === "return") {
        (stdin as any).setRawMode(false);
        stdin.off("keypress", onKey);
        stdout.write("\x1B[H\x1B[2J");
        resolve(multi ? Array.from(selected).sort((a, b) => a - b).map((i) => options[i]) : options[cursor]);
        return;
      }
      render();
    };
    stdin.on("keypress", onKey);
  });
}
