# AutoMode

Mod Claude Code (application de bureau et terminal, version 2.1.321 ou plus récente) qui choisit **le modèle et l'effort** de chaque demande, pour être plus performant sur les tâches difficiles et économiser le quota sur les simples.

## Installation

```
/plugin install aiguilleur --marketplace FloGV01/automode
```

Puis `/reload-plugins`.

## Ce qu'il fait

- Classe chaque demande sur six crans : Haiku bas, Sonnet moyen, Sonnet haut, Opus haut, Opus max, puis Fable seulement sur preuve d'échec ou sur demande (`@fable`).
- Règles locales d'abord ; un juge Haiku rapide tranche les cas flous ; défaut sûr Sonnet haut s'il ne répond pas.
- Monte tout seul sur preuve d'échec : tests rouges répétés ou correction de l'utilisateur.
- Protège le cache : pas de changement de modèle en pleine tâche quand le contexte est chaud.
- Planchers de risque : données privées, modèle financier, secret, migration, revue demandée.
- Ne touche jamais aux sous-agents.

## La bande au-dessus de la saisie

`AutoMode [On|Off]   Sonnet 5.5 moyen   Ultracode [On|Off]`

- **AutoMode** en vert : actif. En orange : mode ombre. En rouge : coupé.
- **Ultracode** en vert : allumé. En gris : éteint.

## Mode ombre

Par défaut, AutoMode démarre en **ombre** : il décide et journalise sans rien appliquer. Au bout de 7 jours, `/aiguilleur bilan` donne l'économie simulée et la répartition des choix, pour décider de l'activer.

## Commandes

`/aiguilleur [actif | ombre | off | auto | ultracode on|off | bilan | statut]`

Ordres en tête de message : `@haiku`, `@sonnet`, `@opus`, `@max`, `@fable`, `@auto`, `effort bas|moyen|haut|max`.

## Vie privée

Le journal reste en local dans `~/.claude/aiguilleur/`, sans aucun texte de demande : seulement le choix, la raison, les volumes de tokens et le coût.

## Licence

MIT
