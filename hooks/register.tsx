import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AutoModeMode, Display } from '../types'
import {
  JUDGE_PROMPT, TIERS, SAFE_TIER, CONFIDENCE_THRESHOLD, TIGHT_QUOTA,
  clamp, cost, decide, familyOf, readCheck, readCorrection, readJudge, readOrder, readTransition,
  labelOf, climb, floorFor, judgeQuestion, localRules,
} from './classify'
import type { Tier, Decision, Family, Evidence, Task, Usage, Verdict, Source, Effort } from './classify'

// AutoMode picks the model and the effort for each of the user's prompts.
//   - prompt.submit classifies the prompt: explicit order, short transition, correction, local rules, Haiku judge;
//   - turn.step applies the choice to every request of the main loop (never to subagents);
//   - tool.call spots failing tests and escalates on evidence;
//   - shadow mode by default: decides and logs without applying, then /automode report after 7 days;
//   - the band above the input shows the state and carries the buttons (AutoMode, Ultracode).
// The log stays local in ~/.claude/automode/ and never contains prompt text.

// Log folder, set at session start from the home folder.
let LOG_DIR = ''
const SEVEN_DAYS = 7 * 24 * 3600 * 1000
const JUDGE_TIMEOUT_MS = 2500
const MAX_JUMPS = 2
const ALIAS: Record<Family, string> = { haiku: 'haiku', sonnet: 'sonnet', opus: 'opus', fable: 'fable' }

type Dollar = EngineInterface

const display = atom({ plugin: 'automode', key: 'display' } as const, {
  mode: 'shadow', label: '…', reason: 'waiting for the first prompt', locked: false, ultracode: false, quota: 0, reportReady: false,
} as Display, { shape: 'automode-1' })

// ---------------------------------------------------------------- session state (reset on reload)

// Version number shown in the band next to the model name.
const VERSIONS: Record<string, string> = { Haiku: '5.5', Sonnet: '5.5', Opus: '5.5', Fable: '5.2' }

let mode: AutoModeMode = 'shadow'
let task: Task | null = null
let decision: Decision | null = null // the decision for the current turn
let manualLock = false // /model or /effort typed by the user
let lastAnswer = ''
let lastTurnEnd = 0
let contextTokens = 0
let quotaPct = 0
let judge: { ms: number; cost: number } | null = null
let turn: { usage: Usage; actual: number; simulated: number; base: number; models: string[] } = empty()
let checks: Record<string, number> = {} // fingerprint of a failing check → times seen failing after an edit
let editedSinceCheck = false
let pendingEvidence: Evidence | null = null
let workflowsSeen = 0
let log: { day: string; lines: string[] } = { day: '', lines: [] }

function empty() {
  return { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, actual: 0, simulated: 0, base: 0, models: [] as string[] }
}

// ---------------------------------------------------------------- log

async function writeLog($: Dollar, line: Record<string, unknown>): Promise<void> {
  if (!LOG_DIR) return
  try {
    const t = await $.clock.now()
    const day = new Date(t).toISOString().slice(0, 10)
    const file = `${LOG_DIR}/log-${day}.jsonl`
    if (log.day !== day) {
      log = { day, lines: [] }
      try {
        log.lines = (await $.fs.read(file)).split('\n').filter(Boolean)
      } catch {
        log.lines = []
      }
    }
    log.lines.push(JSON.stringify({ t, ...line }))
    await $.fs.write(file, log.lines.join('\n') + '\n')
  } catch {
    // an unreadable log must never get in the way of the session
  }
}

async function readLogs($: Dollar, days: number): Promise<Record<string, any>[]> {
  const now = await $.clock.now()
  const out: Record<string, any>[] = []
  for (let i = 0; i < days; i++) {
    const day = new Date(now - i * 86_400_000).toISOString().slice(0, 10)
    try {
      for (const l of (await $.fs.read(`${LOG_DIR}/log-${day}.jsonl`)).split('\n')) {
        if (l) out.push(JSON.parse(l))
      }
    } catch {
      // no log that day
    }
  }
  return out
}

// ---------------------------------------------------------------- display

async function refresh($: Dollar, fields: Partial<Display> = {}): Promise<void> {
  const installedAt = Number((await $.store.get('installedAt')) ?? 0)
  const now = await $.clock.now()
  await update($, display, d => ({
    ...d,
    mode,
    locked: manualLock || Boolean(task?.locked),
    quota: quotaPct,
    reportReady: mode === 'shadow' && installedAt > 0 && now - installedAt >= SEVEN_DAYS,
    ...fields,
  }))
}

async function setMode($: Dollar, m: AutoModeMode): Promise<string> {
  mode = m
  await $.store.set('mode', m)
  await writeLog($, { ev: 'mode', mode: m })
  await refresh($)
  return m === 'active' ? 'AutoMode active: it applies its choices.' : m === 'shadow' ? 'AutoMode in shadow mode: it decides and logs without applying.' : 'AutoMode off.'
}

async function toggleUltracode($: Dollar, on: boolean): Promise<string> {
  try {
    const r = await $.command.run({ command: 'effort', args: on ? 'ultracode on' : 'ultracode off' })
    const text = r.text ?? ''
    const ok = on ? /ultracode on/i.test(text) : /ultracode off/i.test(text)
    if (ok) {
      workflowsSeen = 0
      await refresh($, { ultracode: on })
    }
    await writeLog($, { ev: 'ultracode', on, ok })
    return text || (on ? 'Ultracode requested.' : 'Ultracode off.')
  } catch (err) {
    return `Ultracode: the command could not be sent (${String(err).slice(0, 120)}).`
  }
}

// ---------------------------------------------------------------- classification

async function callJudge($: Dollar, text: string): Promise<Verdict | null> {
  const start = await $.clock.now()
  try {
    const r = await $.model.complete({
      model: 'haiku',
      system: [{ text: JUDGE_PROMPT, cache: true }],
      prompt: judgeQuestion(text, lastAnswer),
      maxTokens: 80,
      effort: 'low',
      timeoutMs: JUDGE_TIMEOUT_MS,
    })
    const u = r.usage
    judge = {
      ms: (await $.clock.now()) - start,
      cost: cost('haiku', { input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens }),
    }
    return r.isAnswered ? readJudge(r.text) : null
  } catch {
    judge = { ms: (await $.clock.now()) - start, cost: 0 }
    return null
  }
}

function taskAt(tier: Tier, now: number, locked = false, jumps = 0): Task {
  return { tier, family: TIERS[tier].family, since: now, jumps, locked }
}

async function classify($: Dollar, text: string): Promise<Decision> {
  const now = await $.clock.now()
  const folder = await $.session.cwd()
  const ctx = { task, contextTokens, idleMs: lastTurnEnd ? now - lastTurnEnd : 0, quotaPct }
  const f = floorFor(text, folder)
  judge = null

  // 1. explicit order at the start of the message
  const order = readOrder(text)
  if (order?.reset) {
    task = null
    manualLock = false
  }
  if (order && (order.tier !== undefined || order.effort)) {
    const tier = order.tier ?? task?.tier ?? SAFE_TIER
    if (order.tier !== undefined) task = taskAt(tier, now, true)
    return decide({ tier, confidence: 1, reason: 'explicit order', newTask: order.tier !== undefined, source: 'order', ...(order.effort ? { forcedEffort: order.effort } : {}) }, f, ctx)
  }

  // 2. weak evidence noted during the previous turn: the effort goes up now (it could not change mid-turn)
  if (pendingEvidence === 'weak' && task && !task.locked) {
    task = { ...task, tier: climb(task.tier, 'weak') }
  }
  pendingEvidence = null

  // 3. correction from the user: strong evidence, the model changes
  const correction = readCorrection(text)
  if (correction === 'correction' && task && !task.locked) {
    if (task.jumps < MAX_JUMPS) {
      const tier = climb(task.tier, 'strong')
      task = { ...taskAt(tier, now, false, task.jumps + 1) }
      return decide({ tier, confidence: 1, reason: 'user correction: escalating', newTask: false, source: 'correction' }, f, ctx)
    }
    $.ui.toast('AutoMode: already escalated twice on this task. Type @opus, @max or @fable to force.')
  }

  // 4. a manual choice locks the task
  if ((manualLock || task?.locked) && task) {
    return decide({ tier: task.tier, confidence: 1, reason: 'manual choice kept', newTask: false, source: 'order' }, f, ctx)
  }

  // 5. short transitions
  const tr = readTransition(text)
  if (tr && task) {
    return decide({
      tier: task.tier, confidence: 1, reason: tr.reason, newTask: false, source: 'transition',
      ...(tr.kind === 'effort' ? { forcedEffort: tr.effort } : {}),
    }, f, ctx)
  }

  // 6. local rules, then the judge in the fuzzy zone (never on private data)
  let v: Verdict & { source: Source } = { ...localRules(text), source: 'rules' }
  if (correction === 'challenge' && task) v = { ...v, tier: clamp(Math.max(v.tier, task.tier)), reason: 'challenge: at least the tier of the challenged work' }
  else if (v.confidence < CONFIDENCE_THRESHOLD && !f?.noJudge) {
    const j = await callJudge($, text)
    v = j ? { ...j, tier: clamp(Math.max(j.tier, j.confidence < 0.6 ? SAFE_TIER : 0)), source: 'judge' } : { ...v, tier: clamp(Math.max(v.tier, SAFE_TIER)), source: 'default', reason: 'judge unavailable: safe default' }
  }
  const d = decide(v, f, ctx)
  if (!task || d.newTask || d.tier > task.tier) task = { ...taskAt(d.tier, now), family: d.family }
  return d
}

// ---------------------------------------------------------------- escalation during a turn

async function evidence($: Dollar, strength: Evidence, reason: string): Promise<void> {
  if (!task || task.locked || manualLock) return
  if (strength === 'weak') {
    pendingEvidence = 'weak'
    await writeLog($, { ev: 'evidence', strength, reason })
    return
  }
  if (task.jumps >= MAX_JUMPS) {
    $.ui.toast('AutoMode: repeated failures after two escalations. Your call (@max, @fable or ultracode).')
    return
  }
  const tier = climb(task.tier, 'strong')
  task = taskAt(tier, await $.clock.now(), false, task.jumps + 1)
  if (decision) decision = { ...decision, tier, family: TIERS[tier].family, effort: TIERS[tier].effort, source: 'evidence', reason }
  await writeLog($, { ev: 'evidence', strength, reason, tier })
  if (mode === 'active') $.ui.toast(`AutoMode: ${reason}, switching to ${TIERS[tier].label}.`)
  await refresh($, { label: TIERS[tier].label, reason })
}

// ---------------------------------------------------------------- report

async function report($: Dollar): Promise<string> {
  const l = await readLogs($, 7)
  const turns = l.filter(x => x.ev === 'turn')
  if (turns.length === 0) return 'No turns logged in the last 7 days.'
  const sum = (k: string) => turns.reduce((s, x) => s + (Number(x[k]) || 0), 0)
  const actual = sum('actual')
  const simulated = sum('simulated')
  const base = sum('base')
  const byTier: Record<string, number> = {}
  for (const x of turns) byTier[x.label] = (byTier[x.label] ?? 0) + 1
  const judged = l.filter(x => x.ev === 'decision' && x.judgeMs)
  const latency = judged.length ? Math.round(judged.reduce((s, x) => s + x.judgeMs, 0) / judged.length) : 0
  const judgeCost = judged.reduce((s, x) => s + (x.judgeCost || 0), 0)
  const corrections = l.filter(x => x.ev === 'decision' && x.source === 'correction').length
  const manual = l.filter(x => x.ev === 'manual').length
  const evidences = l.filter(x => x.ev === 'evidence').length
  const sources: Record<string, number> = {}
  for (const x of l.filter(y => y.ev === 'decision')) sources[x.source] = (sources[x.source] ?? 0) + 1
  const quotas = turns.map(x => x.quota).filter((q: unknown) => typeof q === 'number')
  const inShadow = turns.every(x => x.mode !== 'active')
  const saving = (a: number, b: number) => (b > 0 ? Math.round((1 - a / b) * 100) : 0)
  const lines = [
    `AutoMode report over 7 days (${turns.length} turns, ${inShadow ? 'shadow mode' : 'active mode'}):`,
    inShadow
      ? `- Actual cost (without AutoMode): $${actual.toFixed(2)}; simulated cost with its choices: $${simulated.toFixed(2)}, i.e. ${saving(simulated, actual)}% estimated savings.`
      : `- Actual cost with AutoMode: $${actual.toFixed(2)}; without it (session model): $${base.toFixed(2)}, i.e. ${saving(actual, base)}% savings.`,
    `- Split: ${Object.entries(byTier).map(([k, n]) => `${k} ${Math.round((n / turns.length) * 100)}%`).join(', ')}.`,
    `- Decisions: ${Object.entries(sources).map(([k, n]) => `${k} ${n}`).join(', ')}.`,
    `- Haiku judge: ${judged.length} calls, ${latency} ms on average, $${judgeCost.toFixed(3)} in total.`,
    `- Under-routing signals: ${corrections} corrections, ${manual} manual choices (/model, /effort), ${evidences} pieces of failure evidence.`,
    quotas.length ? `- Quota: from ${quotas[0]}% to ${quotas[quotas.length - 1]}% over the period (highest of the 5-hour and 7-day windows).` : '- Quota: no reading available.',
    'List prices in $; on a subscription, the order of magnitude carries over to your quota. The simulated cost assumes the same token volumes.',
  ]
  return lines.join('\n')
}

// ---------------------------------------------------------------- hooks

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    const home = await $.env.get('HOME')
    LOG_DIR = home ? `${home}/.claude/automode` : ''
    await $.command.register({
      name: 'automode',
      description: 'AutoMode model and effort routing: status, mode (active, shadow, off), ultracode, report',
      argumentHint: '[active | shadow | off | auto | ultracode on|off | report | status]',
    })
    const stored = (await $.store.get('mode')) as AutoModeMode | undefined
    mode = stored === 'active' || stored === 'off' ? stored : 'shadow'
    if (!(await $.store.get('installedAt'))) await $.store.set('installedAt', await $.clock.now())
    await refresh($)
    return r
  })

  on('prompt.submit', async ($, e, next) => {
    if (mode === 'off' || e.command || e.isMeta || e.text.trim().startsWith('/')) return next(e)
    const d = await classify($, e.text)
    decision = d
    await writeLog($, {
      ev: 'decision', mode, tier: d.tier, family: d.family, effort: d.effort, source: d.source,
      reason: d.reason, floor: d.floor, new: d.newTask, quota: quotaPct, context: contextTokens,
      ...(judge ? { judgeMs: judge.ms, judgeCost: judge.cost } : {}),
    })
    await refresh($, { label: labelOf(d.family, d.effort), reason: d.floor ? `${d.reason} · ${d.floor}` : d.reason })
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined || mode === 'off' || !decision) return yield* next(e)
    const sessionFamily = familyOf(e.model) ?? 'opus'
    const apply = mode === 'active' && !manualLock
    const sent = apply
      ? { ...e, model: ALIAS[decision.family], ...(e.effort !== undefined ? { effort: decision.effort as Effort } : {}) }
      : e
    const res = yield* next(sent)
    const u = res?.usage
    if (u) {
      const usage: Usage = { input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens }
      const answered = familyOf(u.model) ?? sessionFamily
      for (const k of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) turn.usage[k] += usage[k]
      turn.actual += cost(answered, usage)
      turn.simulated += cost(decision.family, usage)
      turn.base += cost(sessionFamily, usage)
      if (!turn.models.includes(u.model)) turn.models.push(u.model)
      contextTokens = usage.input + usage.cacheRead + usage.cacheWrite + usage.output
    }
    return res
  })

  on('tool.call', async ($, e, next) => {
    const res = await next(e)
    if (e.agentId !== undefined || mode === 'off') return res
    const name = String(e.tool)
    if (name === 'Edit' || name === 'Write' || name === 'NotebookEdit') editedSinceCheck = true
    if (name === 'Workflow' && (await read($, display)).ultracode) {
      workflowsSeen += 1
      if (workflowsSeen === 1) $.ui.toast('AutoMode: first ultracode workflow of the session, it can launch dozens of agents.')
      if (quotaPct >= TIGHT_QUOTA) $.ui.toast(`AutoMode: quota at ${quotaPct}%, consider turning ultracode off.`)
    }
    if (name === 'Bash') {
      const command = String((e as { command?: unknown }).command ?? '')
      const r = res as { result?: { stdout?: string; stderr?: string }; isError?: boolean; text?: string }
      const output = `${r.result?.stdout ?? ''}\n${r.result?.stderr ?? ''}\n${r.text ?? ''}`.slice(-20_000)
      const c = readCheck(command, output, r.isError === true)
      if (c.check && c.red && editedSinceCheck) {
        checks[c.fingerprint] = (checks[c.fingerprint] ?? 0) + 1
        const n = checks[c.fingerprint]
        if (n === 2) await evidence($, 'weak', 'same test failed twice after a fix')
        if (n === 3) await evidence($, 'strong', 'test still failing after escalation')
      }
      if (c.check && !c.red) checks = {}
      if (c.check) editedSinceCheck = false
    }
    return res
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done
    lastTurnEnd = await $.clock.now()
    lastAnswer = String((done as { text?: string })?.text ?? '').slice(0, 600)
    if (decision && turn.usage.input + turn.usage.cacheRead + turn.usage.output > 0) {
      await writeLog($, {
        ev: 'turn', mode, label: labelOf(decision.family, decision.effort), family: decision.family, effort: decision.effort,
        source: decision.source, models: turn.models, ...turn.usage,
        actual: Number(turn.actual.toFixed(5)), simulated: Number(turn.simulated.toFixed(5)), base: Number(turn.base.toFixed(5)), quota: quotaPct,
      })
    }
    turn = empty()
    await refresh($)
    return done
  })

  on('session.measure', async ($, e, next) => {
    const pcts = e.rateLimits.map(r => r.percentUsed).filter(n => typeof n === 'number')
    if (pcts.length) quotaPct = Math.max(...pcts)
    if (e.changed.includes('rateLimits')) await refresh($)
    return next(e)
  })

  on('classic.PostModelSwitch', async ($, e, next) => {
    if (e.source === 'command' || e.source === 'picker') {
      manualLock = true
      await writeLog($, { ev: 'manual', what: 'model', to: familyOf(e.to_model) })
      await refresh($, { reason: 'model picked by hand: /automode auto to hand control back' })
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'effort' }, async ($, e, next) => {
    const r = await next(e)
    if (e.origin.kind !== 'plugin' && !/ultracode/i.test(e.args) && e.args.trim()) {
      manualLock = true
      await writeLog($, { ev: 'manual', what: 'effort' })
      await refresh($, { reason: 'effort picked by hand: /automode auto to hand control back' })
    }
    if (/ultracode/i.test(e.args)) await refresh($, { ultracode: /ultracode on/i.test(r.text ?? '') })
    return r
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'automode' }, async ($, e) => {
    const a = e.args.trim().toLowerCase()
    if (a === 'active' || a === 'on') return { text: await setMode($, 'active') }
    if (a === 'shadow') return { text: await setMode($, 'shadow') }
    if (a === 'off') return { text: await setMode($, 'off') }
    if (a === 'auto') {
      manualLock = false
      if (task) task = { ...task, locked: false }
      await refresh($, { reason: 'automatic routing restored' })
      return { text: 'AutoMode: automatic routing restored.' }
    }
    if (a === 'ultracode on') return { text: await toggleUltracode($, true) }
    if (a === 'ultracode off') return { text: await toggleUltracode($, false) }
    if (a === 'report') return { text: await report($) }
    if (a && a !== 'status') return { text: 'Usage: /automode [active | shadow | off | auto | ultracode on | ultracode off | report | status]' }
    const s = await read($, display)
    return {
      text: `AutoMode ${s.mode} · ${s.label} · ${s.reason}${s.locked ? ' · manual choice locked' : ''}${s.ultracode ? ' · ultracode on' : ''} · quota ${s.quota}%`,
    }
  })

  // One row: AutoMode and the chosen model on the left, Ultracode on the right.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, display)
    if (e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const below = await next(e)
    const active = s.mode === 'active'
    const off = s.mode === 'off'
    // The name carries the color (the desktop's native button does not color its text); the button next to it acts.
    // AutoMode: green active, orange shadow, red off. Ultracode: green on, grey off.
    const modeControl = (
      <Box flexDirection="row" alignItems="center" columnGap={1}>
        <Text bold color={active ? 'success' : off ? 'error' : 'warning'}>AutoMode</Text>
        <Button key="mode" label={active ? 'On' : 'Off'} onPress={async () => void (await setMode($, active ? 'off' : 'active'))} />
      </Box>
    )
    const ultraControl = (
      <Box flexDirection="row" alignItems="center" columnGap={1}>
        {s.ultracode ? <Text bold color="success">Ultracode</Text> : <Text dimColor>Ultracode</Text>}
        <Button key="ultra" label={s.ultracode ? 'On' : 'Off'} onPress={async () => void $.ui.toast(await toggleUltracode($, !s.ultracode))} />
      </Box>
    )
    const [modelName = '', effortText = ''] = s.label.split(' · ')
    const model = VERSIONS[modelName] ? `${modelName} ${VERSIONS[modelName]}` : modelName
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" alignItems="center" justifyContent="space-between" columnGap={2}>
          <Box flexDirection="row" alignItems="center" columnGap={2}>
            {modeControl}
            {off ? null : (
              <Box flexDirection="row" alignItems="center" columnGap={1}>
                <Text>{model}</Text>
                {effortText ? <Text dimColor>{effortText}</Text> : null}
              </Box>
            )}
            {!off && s.locked ? <Text dimColor>Manual</Text> : null}
          </Box>
          <Box flexDirection="row" alignItems="center" columnGap={2}>
            {s.reportReady ? <Button key="report" variant="primary" label="Report ready" onPress={async () => void $.ui.toast('Type /automode report to read it.')} /> : null}
            {ultraControl}
          </Box>
        </Box>
        {below}
      </Box>
    )
  })
}
