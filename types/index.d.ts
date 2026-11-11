export type ModeAiguilleur = 'ombre' | 'actif' | 'off'

// Ce que la bande au-dessus de la saisie affiche.
export type Affichage = {
  mode: ModeAiguilleur
  libelle: string // « Opus · haut »
  raison: string
  verrou: boolean // un choix manuel (/model, @opus…) fige le routage
  ultracode: boolean
  quota: number // le plus haut des quotas 5 h et 7 j, en %
  bilanPret: boolean // les 7 jours d’ombre sont écoulés
}

declare module 'claude-code' {
  interface PluginState {
    aiguilleur: { affichage: Shaped<Affichage> }
  }
}
