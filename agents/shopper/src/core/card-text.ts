import { normaliseText } from './html.js';

export interface NodeLike {
  nodeType: number;
  textContent: string | null;
  childNodes: ArrayLike<NodeLike>;
}

export function textLines(root: unknown): string[] {
  const lines: string[] = [];
  const walk = (node: NodeLike): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        const text = normaliseText(child.textContent);
        if (text !== '') lines.push(text);
      } else if (child.nodeType === 1) {
        walk(child);
      }
    }
  };
  walk(root as NodeLike);
  return lines;
}

export function spacedText(root: unknown): string {
  return textLines(root).join(' ');
}
