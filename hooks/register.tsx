import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Affichage, ModeAiguilleur } from '../types'
import {
  CONSIGNE_JUGE, CRANS, CRAN_SUR, SEUIL_CONFIANCE, QUOTA_TENDU,
  borne, cout, decider, familleDe, lireCheck, lireCorrection, lireJuge, lireOrdre, lireTransition,
  libelleDe, monter, plancher, questionJuge, reglesLocales,
} from './classer'
import type { Cran, Decision, Famille, Preuve, Tache, Usage, Verdict, Source, Effort } from './classer'

// L’aiguilleur choisit le modèle et l’effort de chaque demande de l’utilisateur.
//   - prompt.submit classe la demande : ordre explicite, transition courte, correction, règles locales, juge Haiku ;
//   - turn.step applique le choix à chaque requête de la boucle principale (jamais aux sous-agents) ;
//   - tool.call repère les tests rouges et fait monter sur preuve ;
//   - mode ombre les 7 premiers jours : décide et journalise sans appliquer, puis /aiguilleur bilan ;
//   - la bande au-dessus de la saisie affiche l’état et porte les boutons (mode, ultracode).
// Le journal reste en local dans ~/.claude/aiguilleur/, sans aucun texte de demande.

// Dossier du journal, fixé au démarrage à partir du dossier personnel.
let DOSSIER = ''
const SEPT_JOURS = 7 * 24 * 3600 * 1000
const JUGE_DELAI_MS = 2500
const SAUTS_MAX = 2
const ALIAS: Record<Famille, string> = { haiku: 'haiku', sonnet: 'sonnet', opus: 'opus', fable: 'fable' }

type Dollar = EngineInterface

const affichage = atom({ plugin: 'aiguilleur', key: 'affichage' } as const, {
  mode: 'ombre', libelle: '…', raison: 'en attente de la première demande', verrou: false, ultracode: false, quota: 0, bilanPret: false,
} as Affichage, { shape: 'aiguilleur-1' })

// ---------------------------------------------------------------- état de session (repart à zéro au rechargement)

// Numéro affiché dans la bande à côté du nom du modèle.
const VERSIONS: Record<string, string> = { Haiku: '5.5', Sonnet: '5.5', Opus: '5.5', Fable: '5.2' }

let mode: ModeAiguilleur = 'ombre'
let tache: Tache | null = null
let decision: Decision | null = null // la décision du tour en cours
let verrouManuel = false // /model ou /effort tapé par l’utilisateur
let derniereReponse = ''
let finDernierTour = 0
let contexteTokens = 0
let quotaPct = 0
let juge: { ms: number; cout: number } | null = null
let tour: { usage: Usage; reel: number; simule: number; base: number; modeles: string[] } = vide()
let checks: Record<string, number> = {} // empreinte d’un check rouge → nombre de fois vu rouge après une édition
let editeDepuisCheck = false
let preuveEnAttente: Preuve | null = null
let workflowsVus = 0
let journal: { jour: string; lignes: string[] } = { jour: '', lignes: [] }

function vide() {
  return { usage: { entree: 0, sortie: 0, lecture: 0, ecriture: 0 }, reel: 0, simule: 0, base: 0, modeles: [] as string[] }
}

// ---------------------------------------------------------------- journal

async function noter($: Dollar, ligne: Record<string, unknown>): Promise<void> {
  if (!DOSSIER) return
  try {
    const t = await $.clock.now()
    const jour = new Date(t).toISOString().slice(0, 10)
    const fichier = `${DOSSIER}/journal-${jour}.jsonl`
    if (journal.jour !== jour) {
      journal = { jour, lignes: [] }
      try {
        journal.lignes = (await $.fs.read(fichier)).split('\n').filter(Boolean)
      } catch {
        journal.lignes = []
      }
    }
    journal.lignes.push(JSON.stringify({ t, ...ligne }))
    await $.fs.write(fichier, journal.lignes.join('\n') + '\n')
  } catch {
    // un journal illisible ne doit jamais gêner la session
  }
}

async function lireJournaux($: Dollar, jours: number): Promise<Record<string, any>[]> {
  const maintenant = await $.clock.now()
  const out: Record<string, any>[] = []
  for (let i = 0; i < jours; i++) {
    const jour = new Date(maintenant - i * 86_400_000).toISOString().slice(0, 10)
    try {
      for (const l of (await $.fs.read(`${DOSSIER}/journal-${jour}.jsonl`)).split('\n')) {
        if (l) out.push(JSON.parse(l))
      }
    } catch {
      // jour sans journal
    }
  }
  return out
}

// ---------------------------------------------------------------- affichage

async function rafraichir($: Dollar, champs: Partial<Affichage> = {}): Promise<void> {
  const installeLe = Number((await $.store.get('installeLe')) ?? 0)
  const maintenant = await $.clock.now()
  await update($, affichage, a => ({
    ...a,
    mode,
    verrou: verrouManuel || Boolean(tache?.verrou),
    quota: quotaPct,
    bilanPret: mode === 'ombre' && installeLe > 0 && maintenant - installeLe >= SEPT_JOURS,
    ...champs,
  }))
}

async function changerMode($: Dollar, m: ModeAiguilleur): Promise<string> {
  mode = m
  await $.store.set('mode', m)
  await noter($, { ev: 'mode', mode: m })
  await rafraichir($)
  return m === 'actif' ? 'AutoMode actif : il applique ses choix.' : m === 'ombre' ? 'AutoMode en ombre : il décide et journalise sans appliquer.' : 'Aiguilleur coupé.'
}

async function basculerUltracode($: Dollar, allumer: boolean): Promise<string> {
  try {
    const r = await $.command.run({ command: 'effort', args: allumer ? 'ultracode on' : 'ultracode off' })
    const texte = r.text ?? ''
    const ok = allumer ? /ultracode on/i.test(texte) : /ultracode off/i.test(texte)
    if (ok) {
      workflowsVus = 0
      await rafraichir($, { ultracode: allumer })
    }
    await noter($, { ev: 'ultracode', allumer, ok })
    return texte || (allumer ? 'Ultracode demandé.' : 'Ultracode coupé.')
  } catch (err) {
    return `Ultracode : la commande n’a pas pu partir (${String(err).slice(0, 120)}).`
  }
}

// ---------------------------------------------------------------- classement

async function appelerJuge($: Dollar, texte: string): Promise<Verdict | null> {
  const debut = await $.clock.now()
  try {
    const r = await $.model.complete({
      model: 'haiku',
      system: [{ text: CONSIGNE_JUGE, cache: true }],
      prompt: questionJuge(texte, derniereReponse),
      maxTokens: 80,
      effort: 'low',
      timeoutMs: JUGE_DELAI_MS,
    })
    const u = r.usage
    juge = {
      ms: (await $.clock.now()) - debut,
      cout: cout('haiku', { entree: u.input_tokens, sortie: u.output_tokens, lecture: u.cache_read_input_tokens, ecriture: u.cache_creation_input_tokens }),
    }
    return r.isAnswered ? lireJuge(r.text) : null
  } catch {
    juge = { ms: (await $.clock.now()) - debut, cout: 0 }
    return null
  }
}

function tacheVers(cran: Cran, maintenant: number, verrou = false, sauts = 0): Tache {
  return { cran, famille: CRANS[cran].famille, depuis: maintenant, sauts, verrou }
}

async function classer($: Dollar, texte: string): Promise<Decision> {
  const maintenant = await $.clock.now()
  const dossier = await $.session.cwd()
  const ctx = { tache, contexteTokens, inactifMs: finDernierTour ? maintenant - finDernierTour : 0, quotaPct }
  const p = plancher(texte, dossier)
  juge = null

  // 1. ordre explicite en tête de message
  const ordre = lireOrdre(texte)
  if (ordre?.reset) {
    tache = null
    verrouManuel = false
  }
  if (ordre && (ordre.cran !== undefined || ordre.effort)) {
    const cran = ordre.cran ?? tache?.cran ?? CRAN_SUR
    if (ordre.cran !== undefined) tache = tacheVers(cran, maintenant, true)
    return decider({ cran, confiance: 1, raison: 'ordre explicite', nouvelleTache: ordre.cran !== undefined, source: 'ordre', ...(ordre.effort ? { effortForce: ordre.effort } : {}) }, p, ctx)
  }

  // 2. preuve faible notée au tour précédent : l’effort monte maintenant (il ne pouvait pas monter en cours de tour)
  if (preuveEnAttente === 'faible' && tache && !tache.verrou) {
    tache = { ...tache, cran: monter(tache.cran, 'faible') }
  }
  preuveEnAttente = null

  // 3. correction de l’utilisateur : preuve forte, on change de modèle
  const correction = lireCorrection(texte)
  if (correction === 'correction' && tache && !tache.verrou) {
    if (tache.sauts < SAUTS_MAX) {
      const cran = monter(tache.cran, 'forte')
      tache = { ...tacheVers(cran, maintenant, false, tache.sauts + 1) }
      return decider({ cran, confiance: 1, raison: 'correction de l’utilisateur : on monte', nouvelleTache: false, source: 'correction' }, p, ctx)
    }
    $.ui.toast('AutoMode : deux montées déjà faites sur cette tâche. Tape @opus, @max ou @fable pour forcer.')
  }

  // 4. un choix manuel fige la tâche
  if ((verrouManuel || tache?.verrou) && tache) {
    return decider({ cran: tache.cran, confiance: 1, raison: 'choix manuel conservé', nouvelleTache: false, source: 'ordre' }, p, ctx)
  }

  // 5. transitions courtes
  const tr = lireTransition(texte)
  if (tr && tache) {
    return decider({
      cran: tache.cran, confiance: 1, raison: tr.raison, nouvelleTache: false, source: 'transition',
      ...(tr.genre === 'effort' ? { effortForce: tr.effort } : {}),
    }, p, ctx)
  }

  // 6. règles locales, puis juge dans la zone floue (jamais sur des données privées)
  let v: Verdict & { source: Source } = { ...reglesLocales(texte), source: 'regles' }
  if (correction === 'contestation' && tache) v = { ...v, cran: borne(Math.max(v.cran, tache.cran)), raison: 'contestation : au moins le cran du travail contesté' }
  else if (v.confiance < SEUIL_CONFIANCE && !p?.sansJuge) {
    const j = await appelerJuge($, texte)
    v = j ? { ...j, cran: borne(Math.max(j.cran, j.confiance < 0.6 ? CRAN_SUR : 0)), source: 'juge' } : { ...v, cran: borne(Math.max(v.cran, CRAN_SUR)), source: 'defaut', raison: 'juge indisponible : défaut sûr' }
  }
  const d = decider(v, p, ctx)
  if (!tache || d.nouvelleTache || d.cran > tache.cran) tache = { ...tacheVers(d.cran, maintenant), famille: d.famille }
  return d
}

// ---------------------------------------------------------------- escalade en cours de tour

async function preuve($: Dollar, force: Preuve, raison: string): Promise<void> {
  if (!tache || tache.verrou || verrouManuel) return
  if (force === 'faible') {
    preuveEnAttente = 'faible'
    await noter($, { ev: 'preuve', force, raison })
    return
  }
  if (tache.sauts >= SAUTS_MAX) {
    $.ui.toast('AutoMode : échecs répétés après deux montées. À toi de décider (@max, @fable ou ultracode).')
    return
  }
  const cran = monter(tache.cran, 'forte')
  tache = tacheVers(cran, await $.clock.now(), false, tache.sauts + 1)
  if (decision) decision = { ...decision, cran, famille: CRANS[cran].famille, effort: CRANS[cran].effort, source: 'preuve', raison }
  await noter($, { ev: 'preuve', force, raison, cran })
  if (mode === 'actif') $.ui.toast(`AutoMode : ${raison}, passage à ${CRANS[cran].libelle}.`)
  await rafraichir($, { libelle: CRANS[cran].libelle, raison })
}

// ---------------------------------------------------------------- bilan

async function bilan($: Dollar): Promise<string> {
  const l = await lireJournaux($, 7)
  const tours = l.filter(x => x.ev === 'tour')
  if (tours.length === 0) return 'Aucun tour journalisé sur les 7 derniers jours.'
  const somme = (k: string) => tours.reduce((s, x) => s + (Number(x[k]) || 0), 0)
  const reel = somme('reel')
  const simule = somme('simule')
  const base = somme('base')
  const parCran: Record<string, number> = {}
  for (const x of tours) parCran[x.libelle] = (parCran[x.libelle] ?? 0) + 1
  const juges = l.filter(x => x.ev === 'decision' && x.jugeMs)
  const latence = juges.length ? Math.round(juges.reduce((s, x) => s + x.jugeMs, 0) / juges.length) : 0
  const coutJuge = juges.reduce((s, x) => s + (x.jugeCout || 0), 0)
  const corrections = l.filter(x => x.ev === 'decision' && x.source === 'correction').length
  const manuels = l.filter(x => x.ev === 'manuel').length
  const preuves = l.filter(x => x.ev === 'preuve').length
  const sources: Record<string, number> = {}
  for (const x of l.filter(y => y.ev === 'decision')) sources[x.source] = (sources[x.source] ?? 0) + 1
  const quotas = tours.map(x => x.quota).filter((q: unknown) => typeof q === 'number')
  const enOmbre = tours.every(x => x.mode !== 'actif')
  const gain = (a: number, b: number) => (b > 0 ? Math.round((1 - a / b) * 100) : 0)
  const lignes = [
    `Bilan de l’aiguilleur sur 7 jours (${tours.length} tours, ${enOmbre ? 'mode ombre' : 'mode actif'}) :`,
    enOmbre
      ? `- Coût réel (sans aiguilleur) : ${reel.toFixed(2)} $ ; coût simulé avec ses choix : ${simule.toFixed(2)} $, soit ${gain(simule, reel)} % d’économie estimée.`
      : `- Coût réel avec l’aiguilleur : ${reel.toFixed(2)} $ ; sans lui (modèle de session) : ${base.toFixed(2)} $, soit ${gain(reel, base)} % d’économie.`,
    `- Répartition : ${Object.entries(parCran).map(([k, n]) => `${k} ${Math.round((n / tours.length) * 100)} %`).join(', ')}.`,
    `- Décisions : ${Object.entries(sources).map(([k, n]) => `${k} ${n}`).join(', ')}.`,
    `- Juge Haiku : ${juges.length} appels, ${latence} ms en moyenne, ${coutJuge.toFixed(3)} $ au total.`,
    `- Signaux de sous-classement : ${corrections} corrections, ${manuels} choix manuels (/model, /effort), ${preuves} preuves d’échec.`,
    quotas.length ? `- Quota : de ${quotas[0]} % à ${quotas[quotas.length - 1]} % sur la période (plus haut des fenêtres 5 h et 7 j).` : '- Quota : pas de lecture disponible.',
    'Prix catalogue en $ ; en abonnement, l’ordre de grandeur se reporte sur le quota. Le coût simulé suppose les mêmes volumes de tokens.',
  ]
  return lignes.join('\n')
}

// ---------------------------------------------------------------- hooks

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    const maison = await $.env.get('HOME')
    DOSSIER = maison ? `${maison}/.claude/aiguilleur` : ''
    await $.command.register({
      name: 'aiguilleur',
      description: 'AutoMode de modèle et d’effort : état, mode (actif, ombre, off), ultracode, bilan',
      argumentHint: '[actif | ombre | off | auto | ultracode on|off | bilan]',
    })
    const stocke = (await $.store.get('mode')) as ModeAiguilleur | undefined
    mode = stocke === 'actif' || stocke === 'off' ? stocke : 'ombre'
    if (!(await $.store.get('installeLe'))) await $.store.set('installeLe', await $.clock.now())
    await rafraichir($)
    return r
  })

  on('prompt.submit', async ($, e, next) => {
    if (mode === 'off' || e.command || e.isMeta || e.text.trim().startsWith('/')) return next(e)
    const d = await classer($, e.text)
    decision = d
    await noter($, {
      ev: 'decision', mode, cran: d.cran, famille: d.famille, effort: d.effort, source: d.source,
      raison: d.raison, plancher: d.plancher, nouvelle: d.nouvelleTache, quota: quotaPct, contexte: contexteTokens,
      ...(juge ? { jugeMs: juge.ms, jugeCout: juge.cout } : {}),
    })
    await rafraichir($, { libelle: libelleDe(d.famille, d.effort), raison: d.plancher ? `${d.raison} · ${d.plancher}` : d.raison })
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined || mode === 'off' || !decision) return yield* next(e)
    const sessionFamille = familleDe(e.model) ?? 'opus'
    const appliquer = mode === 'actif' && !verrouManuel
    const envoye = appliquer
      ? { ...e, model: ALIAS[decision.famille], ...(e.effort !== undefined ? { effort: decision.effort as Effort } : {}) }
      : e
    const res = yield* next(envoye)
    const u = res?.usage
    if (u) {
      const usage: Usage = { entree: u.input_tokens, sortie: u.output_tokens, lecture: u.cache_read_input_tokens, ecriture: u.cache_creation_input_tokens }
      const repondu = familleDe(u.model) ?? sessionFamille
      for (const k of ['entree', 'sortie', 'lecture', 'ecriture'] as const) tour.usage[k] += usage[k]
      tour.reel += cout(repondu, usage)
      tour.simule += cout(decision.famille, usage)
      tour.base += cout(sessionFamille, usage)
      if (!tour.modeles.includes(u.model)) tour.modeles.push(u.model)
      contexteTokens = usage.entree + usage.lecture + usage.ecriture + usage.sortie
    }
    return res
  })

  on('tool.call', async ($, e, next) => {
    const res = await next(e)
    if (e.agentId !== undefined || mode === 'off') return res
    const nom = String(e.tool)
    if (nom === 'Edit' || nom === 'Write' || nom === 'NotebookEdit') editeDepuisCheck = true
    if (nom === 'Workflow' && (await read($, affichage)).ultracode) {
      workflowsVus += 1
      if (workflowsVus === 1) $.ui.toast('AutoMode : premier workflow ultracode de la session, il peut lancer des dizaines d’agents.')
      if (quotaPct >= QUOTA_TENDU) $.ui.toast(`AutoMode : quota à ${quotaPct} %, pense à couper ultracode.`)
    }
    if (nom === 'Bash') {
      const commande = String((e as { command?: unknown }).command ?? '')
      const r = res as { result?: { stdout?: string; stderr?: string }; isError?: boolean; text?: string }
      const sortie = `${r.result?.stdout ?? ''}\n${r.result?.stderr ?? ''}\n${r.text ?? ''}`.slice(-20_000)
      const c = lireCheck(commande, sortie, r.isError === true)
      if (c.check && c.rouge && editeDepuisCheck) {
        checks[c.empreinte] = (checks[c.empreinte] ?? 0) + 1
        const n = checks[c.empreinte]
        if (n === 2) await preuve($, 'faible', 'même test rouge deux fois après correction')
        if (n === 3) await preuve($, 'forte', 'test toujours rouge après montée')
      }
      if (c.check && !c.rouge) checks = {}
      if (c.check) editeDepuisCheck = false
    }
    return res
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const fini = await next(e)
    if (e.agentId !== undefined) return fini
    finDernierTour = await $.clock.now()
    derniereReponse = String((fini as { text?: string })?.text ?? '').slice(0, 600)
    if (decision && tour.usage.entree + tour.usage.lecture + tour.usage.sortie > 0) {
      await noter($, {
        ev: 'tour', mode, libelle: libelleDe(decision.famille, decision.effort), famille: decision.famille, effort: decision.effort,
        source: decision.source, modeles: tour.modeles, ...tour.usage,
        reel: Number(tour.reel.toFixed(5)), simule: Number(tour.simule.toFixed(5)), base: Number(tour.base.toFixed(5)), quota: quotaPct,
      })
    }
    tour = vide()
    await rafraichir($)
    return fini
  })

  on('session.measure', async ($, e, next) => {
    const pcts = e.rateLimits.map(r => r.percentUsed).filter(n => typeof n === 'number')
    if (pcts.length) quotaPct = Math.max(...pcts)
    if (e.changed.includes('rateLimits')) await rafraichir($)
    return next(e)
  })

  on('classic.PostModelSwitch', async ($, e, next) => {
    if (e.source === 'command' || e.source === 'picker') {
      verrouManuel = true
      await noter($, { ev: 'manuel', quoi: 'model', vers: familleDe(e.to_model) })
      await rafraichir($, { raison: 'modèle choisi à la main : /aiguilleur auto pour rendre la main' })
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'effort' }, async ($, e, next) => {
    const r = await next(e)
    if (e.origin.kind !== 'plugin' && !/ultracode/i.test(e.args) && e.args.trim()) {
      verrouManuel = true
      await noter($, { ev: 'manuel', quoi: 'effort' })
      await rafraichir($, { raison: 'effort choisi à la main : /aiguilleur auto pour rendre la main' })
    }
    if (/ultracode/i.test(e.args)) await rafraichir($, { ultracode: /ultracode on/i.test(r.text ?? '') })
    return r
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'aiguilleur' }, async ($, e) => {
    const a = e.args.trim().toLowerCase()
    if (a === 'actif' || a === 'on') return { text: await changerMode($, 'actif') }
    if (a === 'ombre') return { text: await changerMode($, 'ombre') }
    if (a === 'off') return { text: await changerMode($, 'off') }
    if (a === 'auto') {
      verrouManuel = false
      if (tache) tache = { ...tache, verrou: false }
      await rafraichir($, { raison: 'routage automatique rétabli' })
      return { text: 'AutoMode : routage automatique rétabli.' }
    }
    if (a === 'ultracode on') return { text: await basculerUltracode($, true) }
    if (a === 'ultracode off') return { text: await basculerUltracode($, false) }
    if (a === 'bilan') return { text: await bilan($) }
    if (a && a !== 'statut') return { text: 'Usage : /aiguilleur [actif | ombre | off | auto | ultracode on | ultracode off | bilan]' }
    const s = await read($, affichage)
    return {
      text: `AutoMode ${s.mode} · ${s.libelle} · ${s.raison}${s.verrou ? ' · choix manuel figé' : ''}${s.ultracode ? ' · ultracode allumé' : ''} · quota ${s.quota} %`,
    }
  })

  // Une seule ligne : l’état à gauche (un seul Text, pour éviter les décalages), les boutons à droite.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, affichage)
    if (e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const dessous = await next(e)
    const actif = s.mode === 'actif'
    const coupe = s.mode === 'off'
    // Le nom porte la couleur (le bouton natif du bureau ne colore pas son texte) ; le bouton à côté agit.
    // AutoMode : vert actif, orange ombre, rouge coupé. Ultracode : vert allumé, gris éteint.
    const boutonMode = (
      <Box flexDirection="row" alignItems="center" columnGap={1}>
        <Text bold color={actif ? 'success' : coupe ? 'error' : 'warning'}>AutoMode</Text>
        <Button key="mode" label={actif ? 'On' : 'Off'} onPress={async () => void (await changerMode($, actif ? 'off' : 'actif'))} />
      </Box>
    )
    const boutonUltra = (
      <Box flexDirection="row" alignItems="center" columnGap={1}>
        {s.ultracode ? <Text bold color="success">Ultracode</Text> : <Text dimColor>Ultracode</Text>}
        <Button key="ultra" label={s.ultracode ? 'On' : 'Off'} onPress={async () => void $.ui.toast(await basculerUltracode($, !s.ultracode))} />
      </Box>
    )
    const [nomModele = '', effortTxt = ''] = s.libelle.split(' · ')
    const modele = VERSIONS[nomModele] ? `${nomModele} ${VERSIONS[nomModele]}` : nomModele
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" alignItems="center" justifyContent="space-between" columnGap={2}>
          <Box flexDirection="row" alignItems="center" columnGap={2}>
            {boutonMode}
            {coupe ? null : (
              <Box flexDirection="row" alignItems="center" columnGap={1}>
                <Text>{modele}</Text>
                {effortTxt ? <Text dimColor>{effortTxt}</Text> : null}
              </Box>
            )}
            {!coupe && s.verrou ? <Text dimColor>Manuel</Text> : null}
          </Box>
          <Box flexDirection="row" alignItems="center" columnGap={2}>
            {s.bilanPret ? <Button key="bilan" variant="primary" label="Bilan prêt" onPress={async () => void $.ui.toast('Tape /aiguilleur bilan pour le lire.')} /> : null}
            {boutonUltra}
          </Box>
        </Box>
        {dessous}
      </Box>
    )
  })
}
