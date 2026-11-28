import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

import { assertNoSecretsInPublicEnv } from './scripts/env-guard.mjs';

// Fails the build if a VITE_* variable is not on the allow-list or looks like a secret,
// so a misconfigured Vercel project or .env file can never ship a key to users.
function secretGuard(mode: string): Plugin {
  return {
    name: 'mvl-secret-guard',
    config() {
      assertNoSecretsInPublicEnv({ ...loadEnv(mode, process.cwd(), 'VITE_'), ...pickVite(process.env) });
    },
  };
}
function pickVite(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([k, v]) => k.startsWith('VITE_') && typeof v === 'string')) as Record<string, string>;
}

// `vite preview` serves the same security headers as Vercel, so CSP problems show up locally.
function vercelHeaders(): Record<string, string> {
  const cfg = JSON.parse(readFileSync(new URL('./vercel.json', import.meta.url), 'utf8'));
  const rule = cfg.headers.find((h: { source: string }) => h.source === '/(.*)');
  return Object.fromEntries(rule.headers.map((h: { key: string; value: string }) => [h.key, h.value]));
}

// Stamps the service worker with a build id derived from the hashed asset names, so every deploy
// that changes the app gets a new cache (old caches are deleted when the new worker activates).
function swVersion(): Plugin {
  let outDir = 'dist';
  return {
    name: 'mvl-sw-version',
    apply: 'build',
    configResolved(c) { outDir = resolve(c.root, c.build.outDir); },
    closeBundle() {
      const sw = join(outDir, 'sw.js');
      const assets = readdirSync(join(outDir, 'assets')).sort().join('|');
      const build = createHash('sha256').update(assets).digest('hex').slice(0, 12);
      writeFileSync(sw, readFileSync(sw, 'utf8').replace('__MVL_BUILD__', build));
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [secretGuard(mode), react(), tailwindcss(), swVersion()],
  server: { port: 3000, host: '0.0.0.0' },
  preview: { port: 4173, headers: vercelHeaders() },
  test: {
    // Deno-only tests (supabase/functions/<fn>/*.test.ts) run with `npm run test:functions`.
    include: ['src/**/*.test.ts', 'supabase/functions/_shared/**/*.test.ts', 'scripts/**/*.test.ts'],
  },
}));
