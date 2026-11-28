# App iPhone (App Store) : où on en est et ce qu'il reste à faire
*English version below.*

## Ce qui est prêt (dans le code, branche `claude/stripe-billing`)
- **Une vraie app iPhone** construite avec Capacitor à partir de l'app existante (dossier `ios/`).
  - Elle contient tous ses fichiers : ce n'est pas un site web dans une coque.
  - Icône et écran de lancement My Voice Life.
- **Les rappels sonnent sur l'iPhone.** L'iPhone programme lui-même une alerte pour chaque rappel à venir.
  - Pas de serveur de notifications, pas de Google.
  - Cela marche avant même que les notifications web soient activées.
  - Les alertes se mettent à jour quand un rappel est créé, modifié, terminé ou supprimé.
  - Elles sont toutes effacées à la déconnexion.
- **Règles d'Apple respectées :**
  - texte d'autorisation du micro ;
  - autorisation des notifications demandée seulement quand on appuie sur un bouton ;
  - fichier de confidentialité (`PrivacyInfo.xcprivacy`) ;
  - suppression du compte dans l'app ;
  - **aucun achat dans l'app iPhone** : Apple interdit de vendre un abonnement par Stripe dans une app iOS. Les offres sont seulement affichées.
- **Construction automatique** sur les Mac de GitHub (`.github/workflows/ios.yml`). Elle prouve que l'app compile pour iPhone.

## Ce qui n'existe PAS encore
- Aucun fichier d'app installable (`.ipa`), aucune version sur TestFlight, rien sur l'App Store.
- Pour cela, il faut un **compte Apple Developer**. Apple exige un titulaire **majeur** ; l'abonnement est payant chaque année (le prix est indiqué sur developer.apple.com, environ 99 USD).
- Je ne peux ni créer ce compte, ni payer, ni détenir les clés de signature.

## Les étapes, dans l'ordre
### 1. Tester sur ton iPhone avec TestFlight (sans validation d'Apple)
1. **L'adulte** s'inscrit sur **developer.apple.com/programs** (compte personnel « Individual » ; l'inscription peut prendre de 1 à 2 jours).
2. Dans **App Store Connect → Apps → +**, il crée l'app :
   - nom « My Voice Life » ;
   - un **identifiant (bundle ID)** de son choix, par ex. `com.sonnom.myvoicelife`. L'identifiant actuel du code, `com.myvoicelife.app`, est provisoire.
3. Dans **App Store Connect → Utilisateurs et accès → Intégrations → API App Store Connect**, il crée une **clé** (rôle « App Manager ») et télécharge le fichier `.p8`. Il ne s'affiche qu'une fois.
4. Dans **GitHub → dépôt → Settings → Secrets and variables → Actions**, il ajoute.

   **Secrets :**

   | Nom | Valeur |
   |---|---|
   | `APP_STORE_CONNECT_KEY_ID` | l'ID de la clé |
   | `APP_STORE_CONNECT_ISSUER_ID` | l'Issuer ID affiché en haut de la page des clés |
   | `APP_STORE_CONNECT_KEY_P8` | tout le contenu du fichier `.p8` |

   **Variables :**

   | Nom | Valeur |
   |---|---|
   | `APPLE_TEAM_ID` | le Team ID (developer.apple.com → Membership) |
   | `IOS_BUNDLE_ID` | l'identifiant choisi à l'étape 2 |
   | `VITE_SUPABASE_URL` | `https://nwglzabnezhmxfyuxhmg.supabase.co` |
   | `VITE_SUPABASE_PUBLISHABLE_KEY` | la clé publique `sb_publishable_…` (pas un secret) |
   | `IOS_TESTFLIGHT_ENABLED` | `true` |

5. Dans Supabase, il ajoute `capacitor://localhost` au secret `ALLOWED_ORIGINS` des fonctions. Sinon la voix et la facturation refusent l'app iPhone. Les notes, tâches et rappels marchent sans.
6. GitHub → **Actions → iOS → Run workflow**, case « testflight » cochée. La version arrive dans TestFlight après le traitement par Apple (souvent 10 à 30 minutes).
7. App Store Connect → **TestFlight → testeurs internes** : il t'ajoute avec ton adresse Apple.
8. Sur ton iPhone : installe l'app **TestFlight** (de l'App Store), accepte l'invitation, installe **My Voice Life**. **C'est la vraie app**, sans Safari, Chrome ni Google.

**Mises à jour automatiques.** Une fois `IOS_TESTFLIGHT_ENABLED=true` réglé, **chaque modification de l'app** envoie toute seule une nouvelle version sur TestFlight, en 10 à 30 minutes. Sur ton iPhone, TestFlight affiche « Mettre à jour » ; tu peux aussi y activer les mises à jour automatiques. Pour cela, dans App Store Connect → TestFlight → le groupe de testeurs internes, l'adulte active la **distribution automatique**.

Les versions TestFlight expirent après 90 jours, mais une nouvelle version arrive à chaque changement.

### 2. Publier sur l'App Store (plus tard)
Apple examine l'app avant de la publier. À faire avant de la soumettre :
- **La voix doit fonctionner** (voir `docs/VOICE_TEST_APPROVAL.md`). Une app dont la fonction principale ne marche pas est refusée.
- **La politique de confidentialité** doit être terminée (identité légale, contact), publiée à une adresse publique, et **une adresse de support** doit exister.
- **Le formulaire « confidentialité » d'App Store Connect :** e-mail, contenu utilisateur (notes, transcriptions) et audio, utilisés pour faire fonctionner l'app, sans pistage.
- **L'âge minimum et les captures d'écran.**
- **Les notes pour l'examinateur :** un compte de test, et une explication de la voix (l'audio n'est jamais conservé).
- **Si les offres payantes doivent être vendues dans l'app iPhone**, il faudra l'achat intégré d'Apple (In-App Purchase), un autre chantier. D'ici là, l'app iPhone est gratuite.

---

# iPhone app (App Store): status and remaining steps
**Ready (code):**
- **A real Capacitor app** in `ios/`, with the files bundled, the My Voice Life icon and launch screen.
- **Reminders alert on the iPhone through on-device notifications.**
  - No server and no Google; this works before Web Push goes live.
  - Rescheduled on every change; cleared on sign-out.
- **Apple rules covered:**
  - microphone purpose string;
  - notification permission asked only on a tap;
  - privacy manifest;
  - in-app account deletion;
  - **no purchase UI in the iOS app** (guideline 3.1.1).
- **A GitHub macOS workflow** that builds the app for the Simulator, which proves it compiles.

**Not done yet:** no `.ipa`, no TestFlight build, no App Store listing. They need an **Apple Developer Program** membership: an adult account holder and a yearly fee. Claude cannot enrol, pay or hold signing keys.

**Steps to TestFlight** (internal testers need no App Review):
1. Enrol.
2. Create the app record and choose the bundle ID (`com.myvoicelife.app` in the code is a placeholder).
3. Create an App Store Connect API key (App Manager role).
4. Add the GitHub secrets `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`, `APP_STORE_CONNECT_KEY_P8` and the variables `APPLE_TEAM_ID`, `IOS_BUNDLE_ID`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `IOS_TESTFLIGHT_ENABLED=true`.
5. Add `capacitor://localhost` to the `ALLOWED_ORIGINS` function secret.
6. Run **Actions → iOS → Run workflow** with "testflight" ticked. From then on, **every app change uploads a new TestFlight build automatically**; enable automatic distribution for the internal testers group so the owner's iPhone simply gets an update.
7. Add the owner as an internal tester.
8. The owner installs **TestFlight** from the App Store, then the app.

**Before the public App Store:**
- voice working;
- a completed, public privacy policy and a support URL;
- the App Privacy questionnaire, age rating, screenshots and reviewer notes with a test account;
- In-App Purchase, if plans are ever sold inside the iOS app.
