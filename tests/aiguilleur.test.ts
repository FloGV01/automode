import { expect, test } from 'claude-code/testing'

import {
  CRANS, decider, lireCheck, lireCorrection, lireJuge, lireOrdre, lireTransition, monter, plancher, reglesLocales, cout,
} from '../hooks/classer'
import type { Contexte, Tache } from '../hooks/classer'

const COMMANDE = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as const

const CALME: Contexte = { tache: null, contexteTokens: 5_000, inactifMs: 0, quotaPct: 20 }

test('ordres explicites en tête de message', async () => {
  expect(lireOrdre('@opus regarde ce bug')?.cran).toBe(3)
  expect(lireOrdre('@fable')?.cran).toBe(5)
  expect(lireOrdre('@haiku effort bas, quelle heure ?')).toEqual({ cran: 0, effort: 'low' })
  expect(lireOrdre('effort max : reprends le calcul')?.effort).toBe('max')
  expect(lireOrdre('@auto')?.reset).toBe(true)
  // un ordre cité, collé ou en milieu de phrase n’en est pas un
  expect(lireOrdre('peux-tu utiliser @opus plus tard ?')).toBe(null)
  expect(lireOrdre('```\n@opus\n```\nque fait ce code ?')).toBe(null)
  expect(lireOrdre('> @fable\nc’est une citation')).toBe(null)
})

test('transitions courtes en français et en anglais', async () => {
  for (const t of ['oui', 'ok', 'Vas-y', 'continue', 'go', 'd’accord', 'ok, fais-le', 'yes']) {
    expect(lireTransition(t)?.genre).toBe('garde')
  }
  expect(lireTransition('merci !')).toEqual({ genre: 'effort', effort: 'low', raison: 'remerciement, même modèle' })
  expect(lireTransition('commit et pousse')?.genre).toBe('effort')
  expect(lireTransition('lance les tests')?.genre).toBe('effort')
  expect(lireTransition('oui mais refais toute l’architecture du module de facturation')).toBe(null)
})

test('corrections et contestations', async () => {
  for (const t of ['non, c’est faux', 'ça marche toujours pas', 'tu as cassé le build', 'pas ce que je voulais', 'Recommence']) {
    expect(lireCorrection(t)).toBe('correction')
  }
  expect(lireCorrection('tu es sûr de ce chiffre ?')).toBe('contestation')
  expect(lireCorrection('note la réunion de demain')).toBe(null)
})

test('règles locales : simple, moyen, dur', async () => {
  expect(reglesLocales('c’est quoi le TURPE ?').cran).toBe(3) // sujet réglementaire : jamais Haiku
  expect(reglesLocales('quelle est la capitale du Japon ?').cran).toBe(0)
  expect(reglesLocales('corrige la faute dans le titre').cran).toBe(0)
  expect(reglesLocales('ajoute un test pour la fonction lire').cran).toBe(1)
  expect(reglesLocales('conçois l’architecture du module de dispatch et arbitre les compromis').cran).toBe(3)
  expect(reglesLocales('hmm').confiance < 0.65).toBe(true)
})

test('planchers de risque', async () => {
  expect(plancher('ouvre donnees-privees/x', '/tmp')?.cran).toBe(2)
  expect(plancher('mets à jour modele_v2.xlsx', '/tmp')?.cran).toBe(3)
  expect(plancher('fais une revue du code', '/tmp')?.cran).toBe(3)
  expect(plancher('quelle heure est-il', '/tmp')).toBe(null)
})

test('décision : plancher, quota tendu et défaut sûr', async () => {
  const simple = { cran: 0 as const, confiance: 0.8, raison: 'x', nouvelleTache: true, source: 'regles' as const }
  expect(decider(simple, null, CALME).famille).toBe('haiku')
  expect(decider(simple, plancher('ouvre donnees-privees', '/tmp'), CALME).cran).toBe(2)
  const moyen = { ...simple, cran: 1 as const }
  expect(decider(moyen, null, { ...CALME, quotaPct: 80 }).cran).toBe(0)
  const dur = { ...simple, cran: 3 as const }
  expect(decider(dur, null, { ...CALME, quotaPct: 80 }).cran).toBe(3) // le quota ne touche jamais une tâche dure
  expect(decider({ ...simple, cran: 5 as const }, null, CALME).cran).toBe(4) // le classement seul n’atteint pas Fable
  expect(decider({ ...simple, cran: 5 as const, source: 'ordre' }, null, CALME).famille).toBe('fable')
})

test('décision : le cache chaud protège le modèle en pleine tâche', async () => {
  const tache: Tache = { cran: 3, famille: 'opus', depuis: 0, sauts: 0, verrou: false }
  const suite = { cran: 1 as const, confiance: 0.9, raison: 'petite suite', nouvelleTache: false, source: 'regles' as const }
  const chaud = decider(suite, null, { tache, contexteTokens: 150_000, inactifMs: 60_000, quotaPct: 20 })
  expect(chaud.famille).toBe('opus') // on ne réécrit pas 150k tokens de cache pour une petite suite
  expect(chaud.effort).toBe('medium') // mais l’effort baisse, gratuitement
  const froid = decider(suite, null, { tache, contexteTokens: 150_000, inactifMs: 2 * 3600_000, quotaPct: 20 })
  expect(froid.famille).toBe('sonnet') // cache froid : redescendre ne coûte rien de plus
  const nouvelle = decider({ ...suite, nouvelleTache: true }, null, { tache, contexteTokens: 150_000, inactifMs: 60_000, quotaPct: 20 })
  expect(nouvelle.famille).toBe('sonnet')
  const long = decider({ ...suite, cran: 0, nouvelleTache: true }, null, { tache: null, contexteTokens: 120_000, inactifMs: 0, quotaPct: 20 })
  expect(long.famille).toBe('sonnet') // Haiku refusé au-delà de 90k tokens
})

test('escalade : faible = effort, forte = modèle, Fable en dernier', async () => {
  expect(monter(1, 'faible')).toBe(2)
  expect(monter(3, 'faible')).toBe(4)
  expect(monter(1, 'forte')).toBe(3)
  expect(monter(3, 'forte')).toBe(4)
  expect(monter(4, 'forte')).toBe(5)
  expect(CRANS[5].famille).toBe('fable')
})

test('repérage des tests rouges', async () => {
  expect(lireCheck('npm test', 'FAIL src/a.test.ts', true).rouge).toBe(true)
  expect(lireCheck('npm test', 'Tests: 12 passed', false).rouge).toBe(false)
  expect(lireCheck('pytest -q', 'bash: pytest: command not found', true).rouge).toBe(false) // panne d’environnement
  expect(lireCheck('ls -la', 'Error: x', true).check).toBe(false)
})

test('lecture de la réponse du juge', async () => {
  expect(lireJuge('{"cran":2,"nouvelle":true,"incertain":false,"pourquoi":"fonctionnalité"}')?.cran).toBe(2)
  expect(lireJuge('{"cran":7}')).toBe(null)
  expect(lireJuge('pas de JSON')).toBe(null)
})

test('coût catalogue', async () => {
  const u = { entree: 1_000_000, sortie: 0, lecture: 0, ecriture: 0 }
  expect(cout('opus', u)).toBe(4)
  expect(cout('fable', u)).toBe(8)
  expect(cout('haiku', u)).toBe(0.5) // palier au-delà de 100k
})

test('la commande /aiguilleur répond son état et change de mode', async ($, on) => {
  const magasin: Record<string, unknown> = {}
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('store.get', (_, e) => ({ value: magasin[e.key] }))
  on('store.set', (_, e) => ((magasin[e.key] = e.value), { value: undefined }))
  on('fs.read', () => { throw new Error('absent') })
  on('fs.write', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1_800_000_000_000 }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  const etat = await $.command.run({ command: 'aiguilleur', args: '', ...COMMANDE })
  expect(etat.text?.startsWith('AutoMode ombre')).toBe(true)
  const actif = await $.command.run({ command: 'aiguilleur', args: 'actif', ...COMMANDE })
  expect(actif.text).toBe('AutoMode actif : il applique ses choix.')
  const usage = await $.command.run({ command: 'aiguilleur', args: 'nimporte', ...COMMANDE })
  expect(usage.text?.startsWith('Usage')).toBe(true)
})

test('la bande s’affiche sur une ligne, sur le bureau comme au terminal', async ($, on) => {
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'aiguilleur', surface, component: 'AbovePrompt', requestId: 'band',
      props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 6, bodyColumns: 100, scroll: { offset: 0, bodyRows: 6 }, view: {} },
    })
    expect((await ui.find({ type: 'Text', text: 'AutoMode' }))?.text).toBe('AutoMode')
    expect((await ui.find({ type: 'Button', key: 'mode' }))?.text).toBe('Off')
    expect((await ui.find({ type: 'Button', key: 'ultra' }))?.text).toBe('Off')
    expect(await ui.find({ type: 'Button', key: 'off' })).toBeFalsy()
    await ui.unmount()
  }
})
