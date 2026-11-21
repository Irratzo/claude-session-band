export type Limit = { kind: string; percent: number; resetsAt: string | null }

export type Changes = {
  files: number
  added: number
  removed: number
  untracked: number
  conflicts: number
  ahead: number
  behind: number
}

export type BandInfo = {
  profile: string
  model: string
  effort: string | null
  contextPercent: number | null
  limits: Limit[]
  repo: string | null
  branch: string | null
  worktree: string | null
  plan: string | null
  planPath?: string | null
  changes?: Changes | null
  cacheAt?: number | null
  cacheTtlMs?: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'session-band': { info: BandInfo | null }
  }
}
