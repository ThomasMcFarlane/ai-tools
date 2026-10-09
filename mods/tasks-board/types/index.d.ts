export type TasksBoardTask = {
  id: string
  // unique within the board: the id, or `id@tag` for a worktree's variant of the row
  key: string
  // a variant row from another worktree of the repo
  tag?: string
  wtPath?: string
  isOwn?: boolean
  // a worktree's done variant of a row the base still has open: the base row's status (it sorts into that section)
  priorStatus?: string
  // the id's trailing number, for ordering
  n: number
  title: string
  status: string
  owner: string
  agent: string
  depends: string
  notes: string
  epic: string
  eta: string
  line: string
  // canonical status `blocked_on_owner`
  onOwner?: boolean
  // parsed from a Branch column; never displayed or kept in state
  branch?: string
}

export type TasksBoardChanges = {
  path: string
  rows: Record<string, [hash: number, changedAt: number]>
}

export type TasksBoardData = {
  numW: number
  repo: string
  path: string
  mtimeMs: number
  size: number
  checkedAt: number
  tasks: TasksBoardTask[]
  error: string
}

export type TasksBoardFix = { repo: string; url: string; isRunning: boolean }

export type TasksBoardFilter = 'all' | 'blocked' | 'session'

declare module 'claude-code' {
  interface PluginState {
    'tasks-board': {
      board: TasksBoardData
      filter: TasksBoardFilter
      expanded: string[]
      epicFlips: string[]
      // the board-formatting agent: which repo, and its PR once known
      fix: TasksBoardFix
      // /board path <file>, for this session only; '' resolves from the session's directory
      pathOverride: string
      // /board autofix on|off for this session; '' defers to the plugin's autofix option
      autofixOverride: string
      isTurnRunning: boolean
      changes: TasksBoardChanges | null
      frame: number
      pinned: string[]
      touched: string[]
      me: string
    }
  }
}
