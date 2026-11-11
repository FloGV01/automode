export type AutoModeMode = 'shadow' | 'active' | 'off'

// What the band above the input shows.
export type Display = {
  mode: AutoModeMode
  label: string // "Opus · high"
  reason: string
  locked: boolean // a manual choice (/model, @opus…) locks the routing
  ultracode: boolean
  quota: number // highest of the 5-hour and 7-day quotas, in %
  reportReady: boolean // the 7 days of shadow mode are over
}

declare module 'claude-code' {
  interface PluginState {
    automode: { display: Shaped<Display> }
  }
}
