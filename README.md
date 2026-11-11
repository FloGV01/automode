# AutoMode

A Claude Code mod (desktop app and terminal, version 2.1.321 or later) that picks **the model and the effort level** for each prompt: stronger on hard tasks, lighter on your quota for simple ones.

## Install

```
/plugin install aiguilleur --marketplace FloGV01/automode
```

Then run `/reload-plugins`.

## What it does

- Sorts each prompt into six tiers: Haiku low, Sonnet medium, Sonnet high, Opus high, Opus max, then Fable only on evidence of failure or on request (`@fable`).
- Local rules first; a fast Haiku judge settles unclear cases; falls back to a safe default (Sonnet high) if the judge does not answer.
- Escalates on its own when there is evidence of failure: repeated failing tests or a correction from the user.
- Protects the prompt cache: no model switch in the middle of a task while the context is warm.
- Risk floors: private data, financial models, secrets, migrations, requested reviews.
- Never touches subagents.

## The band above the input

`AutoMode [On|Off]   Sonnet 5.5 medium   Ultracode [On|Off]`

- **AutoMode** in green: active. In orange: shadow mode. In red: off.
- **Ultracode** in green: on. In grey: off.

## Shadow mode

By default AutoMode starts in **shadow** mode: it decides and logs without applying anything. After 7 days, `/aiguilleur bilan` reports the simulated savings and how choices were spread, so you can decide whether to turn it on.

## Commands

`/aiguilleur [actif | ombre | off | auto | ultracode on|off | bilan | statut]`

(`actif` = active, `ombre` = shadow, `bilan` = report, `statut` = status.)

Prompt prefixes: `@haiku`, `@sonnet`, `@opus`, `@max`, `@fable`, `@auto`, `effort bas|moyen|haut|max` (low, medium, high, max).

## Privacy

The log stays local in `~/.claude/aiguilleur/` and never contains prompt text: only the choice, the reason, token counts and cost.

## License

MIT
