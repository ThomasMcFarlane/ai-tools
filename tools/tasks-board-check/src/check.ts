import { checkBoard, epicEtaWarnings, parseBoard } from '../../../mods/tasks-board/hooks/board.ts';

export type Format = 'canonical' | 'lenient';

export function check(text: string, format: Format = 'canonical') {
  const problems = checkBoard(text, 'canonical');
  const failing = checkBoard(text, format);
  const warnings = epicEtaWarnings(text);
  return { problems, warnings, tasks: parseBoard(text).length, failed: failing.length > 0 };
}
