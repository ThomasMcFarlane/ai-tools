export type PlanViewPlan = {
  // absolute path of the latest plan file; '' until one is known
  path: string
  // when the pane last read it (epoch ms)
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'plan-view': {
      plan: PlanViewPlan
    }
  }
}
