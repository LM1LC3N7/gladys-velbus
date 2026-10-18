# Velbus pour Gladys

Cette intégration relie un bus domotique **Velbus** à Gladys Assistant, **en
local** sur votre réseau, par une passerelle réseau : un **Signum** (TLS,
avec son mot de passe) ou une **passerelle TCP** (velserv, une interface USB
partagée par un serveur TCP…).

> **Jamais testé avec une vraie installation.** Le protocole vient de la
> bibliothèque [velbus-aio](https://github.com/Cereal2nd/velbus-aio) (celle
> de l'intégration Velbus de Home Assistant), portée en JavaScript et
> vérifiée seulement contre un bus simulé. Faites vos premiers essais en
> présence et signalez ce qui ne va pas.
>
> Intégration non officielle, sans lien avec Velbus.

## Ce qu'il faut

- Une installation Velbus avec une passerelle réseau joignable depuis
  Gladys :
  - un **Signum** (VMBSIG) : choisissez « Signum (TLS) » ;
  - ou une **passerelle TCP** : une VMBRSUSB / VMB1USB partagée sur le
    réseau par un programme comme velserv ou python-velbus-tcp : choisissez
    « Passerelle TCP ».
- Une interface USB branchée directement sur la machine de Gladys n'est
  **pas** prise en charge.
- Cette intégration n'ouvre **qu'une seule connexion** à la passerelle. Que
  votre passerelle accepte en même temps VelbusLink ou Home Assistant dépend
  de la passerelle (non vérifié).

## Ce que vous obtenez

L'intégration **recherche les modules sur le bus** (une requête à chaque
adresse, de 1 à 254, environ 20 secondes) à sa première connexion, puis lit
les noms et les états des modules. Les appareils apparaissent dans l'onglet
Découverte, un appareil par canal, nommé d'après le module (les noms définis
dans VelbusLink).

- **Relais** (VMB4RYLD, VMB1RYNO, VMB4RYNO-20…) : un **interrupteur**, ou une
  **lumière** pour les relais listés dans « Relais qui sont des lumières ».
- **Variateurs** (VMB4DC, VMBDMI, VMB1DM, VMB4LEDPWM-20…) : une **lumière**
  avec sa **luminosité**. L'allumer remet le dernier niveau quand le module
  le permet.
- **Volets** (VMB1BLE, VMB2BLE, VMB1BLS, VMB2BLE-10/-20, VMB1BL, VMB2BL) : un
  **volet** (ouvrir, fermer, arrêter) et, sur les modules qui la donnent, sa
  **position** (100 = ouvert dans Gladys). Un volet n'est jamais un
  interrupteur : un « éteins tout » ne le fait pas bouger.
- **Thermostats** (VMBGP1/2/4, VMBGPO, VMBEL1/2/4, VMB1TS…) : la
  **température**, la **consigne**, le **mode** (confort, jour, nuit, hors
  gel), chauffage ou refroidissement, et s'il est en marche. Les changer
  depuis Gladys est **désactivé par défaut** (voir plus bas).
- Les modules avec une sonde de température sans thermostat : la
  température.
- **Boutons poussoirs** (VMBGP*, VMB8PB, VMB6IN, VMBEL*…) : pas d'appareil,
  un **déclencheur de scène** « Bouton poussoir Velbus » avec l'adresse du
  module (hexadécimale, comme dans VelbusLink, par ex. `1A`), le canal et
  l'action (appuyé, maintenu, relâché). Laissez un champ vide pour accepter
  toute valeur. La scène reçoit `module`, `channel`, `action` et `name`.

Pas pris en charge dans cette version : les modules DALI (VMBDALI), les
compteurs, les entrées analogiques, la station météo, les détecteurs PIR
comme détecteurs de mouvement, les LED des boutons, l'éclairage de bord des
panneaux VMBEL, les textes mémo, l'horloge.

## Configuration

1. **Adresse de la passerelle** : l'adresse IP (ou le nom) du Signum ou de
   la passerelle TCP. Donnez-lui une adresse fixe dans votre box.
2. **Port** : 27015 sauf si votre passerelle en utilise un autre.
3. **Type de passerelle** : « Signum (TLS) » ou « Passerelle TCP (simple) ».
4. **Mot de passe du Signum** (Signum seulement, s'il en demande un) : un
   champ secret, gardé par Gladys dans sa base, jamais réaffiché dans
   l'interface, envoyé seulement à la passerelle, jamais écrit dans les
   journaux. Il n'est **envoyé qu'en TLS** : avec « Passerelle TCP », il
   n'est jamais envoyé (l'état le signale).
5. **Empreinte du certificat du Signum** (facultatif, conseillé avec un mot
   de passe) : à la première connexion TLS, l'intégration écrit dans ses
   journaux l'empreinte SHA-256 du certificat du Signum. Copiez-la ici :
   désormais, une passerelle avec un autre certificat ne reçoit pas le mot de
   passe et la connexion s'arrête.
6. **Relais qui sont des lumières** (facultatif), par exemple
   `1A-1, 1A-3, 2B-2` (adresse en hexadécimal, canal). Changer le type d'un
   relais déjà créé dans Gladys ajoute une nouvelle fonctionnalité et garde
   l'ancienne (et son historique) : supprimez l'ancienne à la main si vous
   n'en voulez plus.
7. **Autoriser le réglage des thermostats depuis Gladys** : désactivé par
   défaut.
8. **Langue des noms** : français ou anglais (utilisée quand un module ne
   donne pas de nom).

Le bouton **Tester la connexion** se connecte tout de suite quand aucune
connexion n'est en cours, sinon attend celle en cours et la recherche des
modules, et indique combien de modules et de canaux ont été trouvés (et
quels modules ne sont pas pris en charge).

**Scanner** dans l'onglet Découverte relance la recherche des modules
(nouveaux modules, module déplacé à une autre adresse). Une reconnexion ne
relance pas la recherche : elle relit les états des modules connus.

## Fonctionnement des commandes

- Une commande est écrite sur le bus dans les 3,5 s qui suivent la demande,
  ou refusée avec « rien n'a été envoyé » (bus trop occupé, passerelle non
  connectée).
- L'intégration attend ensuite que le module la confirme (un état de ce
  canal sur le bus) jusqu'à 4,5 s. Sans confirmation, la commande est
  annoncée « envoyée, sans confirmation » et le canal est relu deux secondes
  plus tard : elle n'est jamais annoncée « non envoyée ».
- Les commandes d'un même canal passent une par une ; la recherche des
  modules ne retarde jamais une commande.
- Chaque commande est écrite dans les journaux de l'intégration.

## Thermostats

- Changer la consigne ou le mode **pilote le chauffage** : c'est désactivé
  par défaut. Une fois autorisé, **tout utilisateur de Gladys, toute scène et
  l'application Gladys peuvent les changer**.
- L'option est relue juste avant chaque envoi : décochée pendant qu'une
  commande attend, cette commande s'arrête (« rien n'a été envoyé »).
- Avant chaque changement, l'intégration **relit le thermostat sur le bus**
  et décide sur cette lecture, jamais sur ce qu'elle a en mémoire : déjà à
  la valeur, rien n'est envoyé ; pas de réponse à temps, rien n'est envoyé.
- Les consignes sont acceptées de 5 à 30 °C, par demi-degré (le pas
  Velbus). La consigne changée est celle du mode en cours.
- Les modes : « comfort » Velbus est **Confort** dans Gladys, « night »
  **Nuit**, « safe » **Hors gel** ; « day » (entre nuit et confort) n'a pas
  d'équivalent dans Gladys et apparaît comme **Éco**, avec le libellé
  « Jour ». Quand le mode change, le thermostat garde son état de programme
  (suit son programme, manuel, ou minuterie), comme le fait velbus-aio.

## Connexion

- Après une coupure, les nouveaux essais sont espacés : 10 s, 30 s, 1 min,
  2 min, puis toutes les 5 minutes.
- Quand rien ne vient du bus pendant 2 minutes, l'intégration envoie une
  demande de type à un module connu ; rien dans les 10 s : la connexion est
  coupée puis rouverte.
- **Si la passerelle ferme la connexion juste après le mot de passe, deux
  fois de suite, l'intégration s'arrête** et ne réessaie pas d'elle-même,
  même après un redémarrage (un mauvais mot de passe n'est pas essayé en
  boucle). Corrigez le mot de passe puis enregistrez, ou cliquez sur
  « Tester la connexion ». Le fichier `/data/velbus-state.json` ne garde que
  l'endroit concerné (`tls://adresse:port`), jamais le mot de passe.
- De même quand le certificat n'est pas celui épinglé.

## Limites connues

- Jamais testé avec une vraie installation (voir plus haut) : les trames
  sont celles que décrit velbus-aio.
- Une passerelle TCP simple fait tout passer en clair sur votre réseau :
  n'importe quel appareil de ce réseau peut lire et envoyer des trames
  Velbus. Préférez un Signum en TLS.
- Sans empreinte épinglée, le certificat TLS du Signum n'est pas vérifié
  (il est auto-signé) : un appareil de votre réseau pourrait se faire passer
  pour la passerelle et recevoir le mot de passe. Épinglez-le.
- Les noms des canaux sont lus en ASCII simple (les accents disparaissent).
- Les appareils sont identifiés par l'adresse et le canal : un module
  déplacé à une autre adresse dans VelbusLink donne de nouveaux appareils.

## Confidentialité

Tout reste sur votre réseau : l'intégration ne parle qu'à la passerelle.

## Licence

Apache-2.0. Logique du protocole portée depuis velbus-aio (Maikel Punie,
Apache-2.0 / MIT) : voir `THIRD_PARTY_NOTICES.md`.
