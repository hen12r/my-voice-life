# Test de la voix : demande d'accord (pour l'adulte responsable)
*English version below.*

**But :** faire marcher la voix pour la première fois, **uniquement pour le compte de test du propriétaire**, afin de vérifier le vrai service OpenAI avant tout lancement. Aujourd'hui, la voix n'a jamais fonctionné : 0 enregistrement.

## Ce qui serait fait (une seule action)
- **Remplacer une fonction serveur :** `process-voice` sur le projet Supabase `nwglzabnezhmxfyuxhmg`.
  - La version en ligne v2 est remplacée par le code du commit `3d8824e` (11 fichiers, tests verts).
- **Changements apportés :**
  - la clé est lue proprement (espaces ou retours à la ligne collés par erreur retirés) ;
  - les messages d'erreur d'OpenAI sont nettoyés avant d'être écrits dans les journaux ;
  - une erreur de clé donne un message clair ;
  - les autres sites ne peuvent plus appeler la fonction (CORS).

## Ce qui ne change PAS
- Aucune migration de base de données, aucune donnée modifiée.
- Aucun secret créé ni lu. **Claude ne voit jamais la clé OpenAI.**
- Pas de paiement (Stripe reste non configuré), pas de production, pas de `main`, pas de lancement public.
- `ai_mode` reste `admins_only` : **seul le compte du propriétaire** peut utiliser la voix.

## Coût maximum
- La base de données bloque toute dépense au-delà de **2 $ par jour et 20 $ par mois**.
- Un test de 10 secondes coûte quelques dixièmes de centime.
- Conseillé : fixer aussi une limite de dépense dans le compte OpenAI.

## Ce que l'adulte doit faire lui-même
1. Dans **Supabase → Edge Functions → Secrets**, vérifier qu'un secret **`OPENAI_API_KEY`** existe (le créer si besoin). Ne jamais envoyer la clé dans une discussion.
2. Le compte OpenAI de cette clé doit avoir :
   - la facturation activée ;
   - une limite de dépense ;
   - l'accès aux modèles `gpt-transcribe` et `gpt-6-luna`.
3. Envoyer cette phrase exacte :
   > **« J'approuve le déploiement de process-voice depuis 3d8824e pour le test vocal administrateur uniquement. »**

## Retour en arrière
- Si quelque chose ne va pas, la version actuelle est redéployée en environ 2 minutes, à partir d'une copie identique octet par octet (`supabase/rollback/process-voice-v2/`).
- Aucune donnée n'est concernée.

## Vérifications faites le 23 nov. 2026 à 19 h 23 UTC (lecture seule)
| Contrôle | Résultat |
|---|---|
| `process-voice` en ligne | v2, ACTIVE, connexion obligatoire |
| Copie de retour en arrière | 10/10 fichiers identiques à la version en ligne |
| Fonctions de comptage IA (réservation, transcription, appel, fin) | Présentes, mêmes paramètres que le code, appelables seulement par le serveur |
| Tarifs des modèles OpenAI | Présents, donc l'IA ne se bloque pas par sécurité |
| `ai_mode` / testeurs | `admins_only` / 1 testeur = le compte du propriétaire |
| Budgets | 2 $/jour, 20 $/mois |
| Migrations | 5 appliquées ; la migration 6 n'est PAS appliquée, et elle n'est pas nécessaire pour ce test |
| Enregistrements vocaux / lignes d'usage IA | 0 / 0 |
| Clé OpenAI | **Inconnue.** Aucun journal ces dernières 24 h ; seul l'adulte peut confirmer qu'elle est en place |

**Important :** le code le plus récent de `process-voice` (HEAD de la branche) a besoin de la migration 6. **Il ne doit pas être déployé pour ce test.** La cible reste `3d8824e`.

---

# Voice test: approval request (for the responsible adult)
**Goal:** make voice work for the first time, **for the owner's test account only**, to check the real OpenAI service before any launch.

- **One action:** redeploy `process-voice` (Supabase project `nwglzabnezhmxfyuxhmg`), replacing live v2 with commit `3d8824e`. 11 files, tests green.
- **Not changed:** no migration, no data, no secret read or created (Claude never sees the key), no Stripe, no production, no `main`, no public launch. `ai_mode` stays `admins_only`, so only the owner can use voice.
- **Cost:** capped by the database at $2/day and $20/month. A 10-second test costs a fraction of a cent.
- **The adult does:**
  1. Ensure the Supabase secret `OPENAI_API_KEY` exists, from an OpenAI account with billing, a spending limit and access to `gpt-transcribe` + `gpt-6-luna`.
  2. Send: *"I approve deploying process-voice from 3d8824e for the admin-only voice test."*
- **Rollback:** about 2 minutes, from a byte-exact snapshot of v2. No data involved.
- **Read-only checks (23 Nov 2026, 19:23 UTC):** see the table above.
- **Do NOT deploy HEAD's `process-voice`:** it needs migration 6.

After deployment, the owner runs the 6 tests in `docs/PROCESS_VOICE_DEPLOY_CHECKLIST.md` → "Short owner test".
