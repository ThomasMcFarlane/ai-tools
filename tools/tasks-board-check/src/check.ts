import { checkBoard, parseBoard } from '../../../mods/tasks-board/hooks/board.ts';

export type Format = 'canonical' | 'lenient';

export function check(text: string, format: Format = 'canonical') {
  const problems = checkBoard(text, 'canonical');
  const failing = checkBoard(text, format);
  return { problems, tasks: parseBoard(text).length, failed: failing.length > 0 };
}
