export type PlanViewPlan = {
  // absolute path of the latest plan file; '' until one is known
  path: string
  // when the pane last read it (epoch ms)
  at: number
}

export type PlanViewOffer = {
  // absolute paths of mentioned .md files awaiting Open or Dismiss, newest last
  pending: string[]
  // every path ever offered this session, so none is offered twice
  seen: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'plan-view': {
      plan: PlanViewPlan
      offer: PlanViewOffer
    }
  }
}
