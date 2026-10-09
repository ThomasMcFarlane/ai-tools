import { chmodSync, copyFileSync, mkdirSync } from 'node:fs';

mkdirSync('../../actions/tasks-board-check/dist', { recursive: true });
copyFileSync('dist/cli.js', '../../actions/tasks-board-check/dist/index.js');
chmodSync('dist/cli.js', 0o755);
