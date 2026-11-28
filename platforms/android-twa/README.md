# Android (Trusted Web Activity), template only

Not built and not published. See `docs/PLATFORMS.md` → "Android" for the decision and the full steps.

- `twa-manifest.json`: Bubblewrap configuration. Replace every `<...>` value.
- `assetlinks.template.json`: once you have the signing certificate fingerprint, copy it to `public/.well-known/assetlinks.json`, filled in, and deploy it on the production domain. Don't add a placeholder version to `public/`: a wrong fingerprint makes Android show a browser bar.

Never commit the keystore or its passwords.
