import { expect, test } from 'claude-code/testing'

import {
  TIERS, decide, readCheck, readCorrection, readJudge, readOrder, readTransition, climb, floorFor, localRules, cost,
} from '../hooks/classify'
import type { Context, Task } from '../hooks/classify'

const COMMAND = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as const

const CALM: Context = { task: null, contextTokens: 5_000, idleMs: 0, quotaPct: 20 }

test('explicit orders at the start of a message', async () => {
  expect(readOrder('@opus look at this bug')?.tier).toBe(3)
  expect(readOrder('@fable')?.tier).toBe(5)
  expect(readOrder('@haiku effort low, what time is it?')).toEqual({ tier: 0, effort: 'low' })
  expect(readOrder('effort max: redo the math')?.effort).toBe('max')
  expect(readOrder('effort very high: check it all')?.effort).toBe('xhigh')
  expect(readOrder('@haiku effort bas, quelle heure ?')).toEqual({ tier: 0, effort: 'low' }) // French works too
  expect(readOrder('@auto')?.reset).toBe(true)
  // a quoted, pasted or mid-sentence order is not an order
  expect(readOrder('could you use @opus later?')).toBe(null)
  expect(readOrder('```\n@opus\n```\nwhat does this code do?')).toBe(null)
  expect(readOrder('> @fable\nthis is a quote')).toBe(null)
})

test('short transitions in English and French', async () => {
  for (const t of ['yes', 'ok', 'go ahead', 'continue', 'sounds good', 'oui', 'Vas-y', 'd’accord', 'ok, fais-le']) {
    expect(readTransition(t)?.kind).toBe('keep')
  }
  expect(readTransition('thanks!')).toEqual({ kind: 'effort', effort: 'low', reason: 'thanks, same model' })
  expect(readTransition('commit and push')?.kind).toBe('effort')
  expect(readTransition('run the tests')?.kind).toBe('effort')
  expect(readTransition('lance les tests')?.kind).toBe('effort')
  expect(readTransition('yes but redo the whole billing module architecture')).toBe(null)
})

test('corrections and challenges', async () => {
  for (const t of ['no, that’s wrong', 'it still doesn’t work', 'you broke the build', 'not what I wanted', 'Try again', 'ça marche toujours pas']) {
    expect(readCorrection(t)).toBe('correction')
  }
  expect(readCorrection('are you sure about this number?')).toBe('challenge')
  expect(readCorrection('write down tomorrow’s meeting')).toBe(null)
})

test('local rules: simple, medium, hard', async () => {
  expect(localRules('what is the capital of Japan?').tier).toBe(0)
  expect(localRules('fix the typo in the title').tier).toBe(0)
  expect(localRules('add a test for the read function').tier).toBe(1)
  expect(localRules('design the architecture of the dispatch module and weigh the trade-offs').tier).toBe(3)
  expect(localRules('what is the LCOE?').tier).toBe(3) // analysis topic: never Haiku
  expect(localRules('quelle est la capitale du Japon ?').tier).toBe(0)
  expect(localRules('hmm').confidence < 0.65).toBe(true)
})

test('risk floors', async () => {
  expect(floorFor('open private-data/x', '/tmp')?.noJudge).toBe(true)
  expect(floorFor('update model_v2.xlsx', '/tmp')?.tier).toBe(3)
  expect(floorFor('do a review of the code', '/tmp')?.tier).toBe(3)
  expect(floorFor('rotate the API key', '/tmp')?.tier).toBe(3)
  expect(floorFor('what time is it', '/tmp')).toBe(null)
})

test('decision: floor, tight quota and safe default', async () => {
  const simple = { tier: 0 as const, confidence: 0.8, reason: 'x', newTask: true, source: 'rules' as const }
  expect(decide(simple, null, CALM).family).toBe('haiku')
  expect(decide(simple, floorFor('open private-data', '/tmp'), CALM).tier).toBe(2)
  const medium = { ...simple, tier: 1 as const }
  expect(decide(medium, null, { ...CALM, quotaPct: 80 }).tier).toBe(0)
  const hard = { ...simple, tier: 3 as const }
  expect(decide(hard, null, { ...CALM, quotaPct: 80 }).tier).toBe(3) // the quota never touches a hard task
  expect(decide({ ...simple, tier: 5 as const }, null, CALM).tier).toBe(4) // classification alone does not reach Fable
  expect(decide({ ...simple, tier: 5 as const, source: 'order' }, null, CALM).family).toBe('fable')
})

test('decision: a warm cache protects the model mid-task', async () => {
  const task: Task = { tier: 3, family: 'opus', since: 0, jumps: 0, locked: false }
  const followUp = { tier: 1 as const, confidence: 0.9, reason: 'small follow-up', newTask: false, source: 'rules' as const }
  const warm = decide(followUp, null, { task, contextTokens: 150_000, idleMs: 60_000, quotaPct: 20 })
  expect(warm.family).toBe('opus') // no rewriting 150k cached tokens for a small follow-up
  expect(warm.effort).toBe('medium') // but the effort goes down, for free
  const cold = decide(followUp, null, { task, contextTokens: 150_000, idleMs: 2 * 3600_000, quotaPct: 20 })
  expect(cold.family).toBe('sonnet') // cold cache: going down costs nothing extra
  const fresh = decide({ ...followUp, newTask: true }, null, { task, contextTokens: 150_000, idleMs: 60_000, quotaPct: 20 })
  expect(fresh.family).toBe('sonnet')
  const long = decide({ ...followUp, tier: 0, newTask: true }, null, { task: null, contextTokens: 120_000, idleMs: 0, quotaPct: 20 })
  expect(long.family).toBe('sonnet') // no Haiku above 90k tokens
})

test('escalation: weak = effort, strong = model, Fable last', async () => {
  expect(climb(1, 'weak')).toBe(2)
  expect(climb(3, 'weak')).toBe(4)
  expect(climb(1, 'strong')).toBe(3)
  expect(climb(3, 'strong')).toBe(4)
  expect(climb(4, 'strong')).toBe(5)
  expect(TIERS[5].family).toBe('fable')
})

test('spotting failing tests', async () => {
  expect(readCheck('npm test', 'FAIL src/a.test.ts', true).red).toBe(true)
  expect(readCheck('npm test', 'Tests: 12 passed', false).red).toBe(false)
  expect(readCheck('pytest -q', 'bash: pytest: command not found', true).red).toBe(false) // environment problem
  expect(readCheck('ls -la', 'Error: x', true).check).toBe(false)
})

test('reading the judge answer', async () => {
  expect(readJudge('{"tier":2,"new":true,"unsure":false,"why":"feature"}')?.tier).toBe(2)
  expect(readJudge('{"tier":7}')).toBe(null)
  expect(readJudge('no JSON')).toBe(null)
})

test('list-price cost', async () => {
  const u = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }
  expect(cost('opus', u)).toBe(4)
  expect(cost('fable', u)).toBe(8)
  expect(cost('haiku', u)).toBe(0.5) // higher rate above 100k
})

test('the /automode command reports its state and changes mode', async ($, on) => {
  const store: Record<string, unknown> = {}
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('store.get', (_, e) => ({ value: store[e.key] }))
  on('store.set', (_, e) => ((store[e.key] = e.value), { value: undefined }))
  on('fs.read', () => { throw new Error('missing') })
  on('fs.write', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1_800_000_000_000 }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  const status = await $.command.run({ command: 'automode', args: '', ...COMMAND })
  expect(status.text?.startsWith('AutoMode shadow')).toBe(true)
  const active = await $.command.run({ command: 'automode', args: 'active', ...COMMAND })
  expect(active.text).toBe('AutoMode active: it applies its choices.')
  const usage = await $.command.run({ command: 'automode', args: 'whatever', ...COMMAND })
  expect(usage.text?.startsWith('Usage')).toBe(true)
})

test('the band draws on one row, on desktop as in the terminal', async ($, on) => {
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'automode', surface, component: 'AbovePrompt', requestId: 'band',
      props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 6, bodyColumns: 100, scroll: { offset: 0, bodyRows: 6 }, view: {} },
    })
    expect((await ui.find({ type: 'Text', text: 'AutoMode' }))?.text).toBe('AutoMode')
    expect((await ui.find({ type: 'Button', key: 'mode' }))?.text).toBe('Off')
    expect((await ui.find({ type: 'Button', key: 'ultra' }))?.text).toBe('Off')
    await ui.unmount()
  }
})
