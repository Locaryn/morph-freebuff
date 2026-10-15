# morph-freebuff (expérimental)

> Freebuff — la version gratuite de Codebuff — dans Locaryn.

## État actuel : en attente d'un mode non interactif

Le CLI `freebuff` est aujourd'hui **uniquement interactif** : pas de `--print`,
pas de sortie JSON, et une entrée par tuyau attend un terminal
([CodebuffAI/freebuff#947](https://github.com/CodebuffAI/freebuff/issues/947)).
Aucun programme ne peut donc encore lui confier une conversation.

Ce morph est prêt pour le jour où cela change :

- le pont lit l'aide de la version installée à chaque démarrage ; **dès qu'une
  version accepte `--print`, le dossier « Freebuff » se remplit tout seul**,
  sans nouvelle version du morph ;
- en attendant, la carte de Réglages → Compte installe Freebuff, ouvre sa
  connexion (`freebuff login`) et explique pourquoi le dossier reste vide.

## Comment ça marchera

Comme les morphs Claude Code et Codex : un pont local (`bridge/server.mjs`,
`127.0.0.1:20133`) traduit le dialecte OpenAI de Locaryn vers le CLI ; les
outils restent ceux de Locaryn.

Freebuff étant gratuit (financé par la publicité), il n'y a pas de jauge de
limites.

## Licence

Apache-2.0. Freebuff et Codebuff appartiennent à leurs auteurs.
