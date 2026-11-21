const { chromium } = require('playwright'); const { spawn } = require('child_process'); const fs = require('fs'); const path = require('path');
// Real-browser PWA check (Chromium via Playwright) against a PRODUCTION build served by vite preview.
// Supabase is mocked (no network, no real account); the service worker, caches, offline mode and
// update flow are real. Run: npm run test:pwa
const DIST = path.resolve(process.argv[2]), OUT = DIST, REPO = path.resolve(process.argv[3]);
const BASE = 'http://localhost:4180';
const USER = { id: 'u1', email: 't@example.com', aud: 'authenticated', role: 'authenticated' };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url'); const exp = Math.floor(Date.now() / 1000) + 3600;
const SESSION = { access_token: `${b64({ alg: 'HS256' })}.${b64({ sub: 'u1', exp, role: 'authenticated' })}.s`, refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: exp, user: USER };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function mockSupabase(ctx) {
  await ctx.route('https://mockproj.supabase.co/**', (r) => {
    const u = r.request().url(); const j = (b) => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }, body: JSON.stringify(b) });
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' } });
    if (u.includes('/auth/v1/settings')) return j({ external: { email: true, google: false } });
    if (u.includes('/auth/v1/token')) return j(SESSION);
    if (u.includes('/auth/v1/user')) return j(USER);
    if (u.includes('/rest/v1/profiles')) return j({ id: 'u1', display_name: 'H', ui_language: 'en', speech_language: 'auto', speech_languages: [], timezone: 'UTC', daily_briefing_enabled: false });
    if (u.includes('/rpc/mvl_my_usage')) return j({ plan: 'free', is_staff: false, is_admin: false, ai_mode: 'admins_only', ai_available: false, captures_used: 0, captures_limit: 7, minutes_used: 0, minutes_limit: 15, max_capture_seconds: 120, resets_at: new Date().toISOString() });
    if (u.includes('/functions/v1/billing')) return j({ configured: false, test_mode: false, prices: [], limits: {} });
    return j(u.includes('/rpc/') ? null : []);
  });
}
(async () => {
  const server = spawn('npx', ['vite', 'preview', '--outDir', DIST, '--port', '4180', '--strictPort'], { cwd: REPO, stdio: 'ignore', detached: true });
  // Stop the whole process group (npx + vite), so no stale server keeps the port.
  const stopServer = () => { try { process.kill(-server.pid, 'SIGTERM'); } catch { /* already gone */ } };
  for (let i = 0; i < 40; i++) { try { await fetch(BASE); break; } catch { await sleep(300); } }
  const browser = await chromium.launch(); const R = {};
  try {
    const ctx = await browser.newContext(); await mockSupabase(ctx); const page = await ctx.newPage();
    const errors = []; page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text().slice(0, 150)); });
    // 1. registration
    await page.goto(BASE + '/login'); await page.waitForTimeout(500);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload(); await page.waitForTimeout(1500);
    R['1 service worker'] = await page.evaluate(async () => ({ controlling: !!navigator.serviceWorker.controller, scope: (await navigator.serviceWorker.getRegistration())?.scope }));
    // 2. cache contents
    await page.goto(BASE + '/pricing'); await page.waitForTimeout(1500);
    R['2 cache'] = await page.evaluate(async () => {
      const out = {}; for (const k of await caches.keys()) { const c = await caches.open(k); out[k] = (await c.keys()).map((r) => r.url); }
      const all = Object.values(out).flat();
      return { caches: Object.keys(out), entries: all.length, allSameOrigin: all.every((u) => u.startsWith(location.origin)), anySupabase: all.some((u) => u.includes('supabase')), anyHtmlPage: all.some((u) => /\/(app|login|pricing)$/.test(u)), sample: all.slice(0, 6).map((u) => u.replace(location.origin, '')) };
    });
    // Look for the REAL session token and user email (the bundle legitimately contains the words "access_token").
    R['2 cache'].realTokenOrEmailInCache = await page.evaluate(async (tok) => { for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) { const t = await (await (await caches.open(k)).match(r)).clone().text().catch(() => ''); if (t.includes(tok) || t.includes('t@example.com')) return r.url; } return false; }, SESSION.access_token);
    R['2 cache'].sessionIsInLocalStorageOnly = await page.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith('sb-')));
    // 3. offline
    await ctx.setOffline(true);
    R['3 offline banner (live page)'] = await page.locator('text=You’re offline').first().waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
    await page.goto(BASE + '/app/notes').catch(() => {}); await page.waitForTimeout(800);
    R['3 offline navigation'] = { offlinePage: (await page.title()).startsWith('Offline'), tryAgainLink: await page.getByRole('link', { name: 'Try again' }).getAttribute('href').catch(() => null) };
    
    await ctx.setOffline(false);
    // 4. update flow
    await page.goto(BASE + '/login'); await page.waitForTimeout(1200);
    const before = await page.evaluate(async () => (await caches.keys()).filter((k) => k.startsWith('mvl-')));
    const swPath = path.join(DIST, 'sw.js'); const orig = fs.readFileSync(swPath, 'utf8');
    fs.writeFileSync(swPath, orig.replace(/const BUILD = '[^']+'/, "const BUILD = 'nextdeploy01'"));
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
    const prompt = page.getByRole('button', { name: 'Reload' });
    const offered = await prompt.waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);
    const stillOldBeforeAccept = await page.evaluate(async () => (await caches.keys()).filter((k) => k.startsWith('mvl-')));
    if (offered) { await Promise.all([page.waitForEvent('load', { timeout: 10000 }).catch(() => null), prompt.click()]); await page.waitForTimeout(1500); }
    const after = await page.evaluate(async () => (await caches.keys()).filter((k) => k.startsWith('mvl-')));
    R['4 update'] = { before, updateOffered: offered, oldCacheKeptUntilAccepted: JSON.stringify(stillOldBeforeAccept).includes(before[0] ?? 'x'), after, oldCacheDeleted: !after.includes(before[0]) && after.includes('mvl-static-nextdeploy01') };
    fs.writeFileSync(swPath, orig);
    // 5. manifest + icons
    R['5 manifest'] = await page.evaluate(async () => {
      const m = await (await fetch('/manifest.webmanifest')).json();
      const icons = await Promise.all(m.icons.filter((i) => i.type === 'image/png').map((i) => new Promise((res) => { const img = new Image(); img.onload = () => res(`${i.src} ${img.naturalWidth}x${img.naturalHeight} ${img.naturalWidth + 'x' + img.naturalHeight === i.sizes ? 'ok' : 'MISMATCH ' + i.sizes}`); img.onerror = () => res(`${i.src} FAILED`); img.src = i.src; })));
      return { id: m.id, display: m.display, start_url: m.start_url, maskable: m.icons.some((i) => i.purpose === 'maskable'), shortcuts: m.shortcuts.map((s) => s.url), icons };
    });
    // 6. installability (Chromium's own check)
    const cdp = await ctx.newCDPSession(page);
    R['6 installability errors'] = (await cdp.send('Page.getInstallabilityErrors')).installabilityErrors;
    R['6 manifest parse errors'] = (await cdp.send('Page.getAppManifest')).errors;
    R.consoleErrors = errors;
    await ctx.close();
    // 7. deep link survives sign-in
    const ctx2 = await browser.newContext(); await mockSupabase(ctx2); const p2 = await ctx2.newPage();
    await p2.goto(BASE + '/app/billing?changed=1'); await p2.waitForTimeout(1200);
    const onLogin = new URL(p2.url()).pathname;
    await p2.fill('input[type=email]', 't@example.com'); await p2.fill('input[type=password]', 'correct-horse-123');
    await p2.getByRole('button', { name: /^Sign in$/ }).click(); await p2.waitForTimeout(2000);
    R['7 deep link'] = { redirectedToLogin: onLogin === '/login', landedOn: new URL(p2.url()).pathname + new URL(p2.url()).search };
    await ctx2.close();
  } finally { await browser.close(); stopServer(); }
  console.log(JSON.stringify(R, null, 1));
  const failures = [];
  const need = (ok, label) => { if (!ok) failures.push(label); };
  need(R['1 service worker']?.controlling, 'service worker controls the page');
  need(R['2 cache']?.allSameOrigin && !R['2 cache']?.anySupabase && !R['2 cache']?.anyHtmlPage && !R['2 cache']?.realTokenOrEmailInCache, 'cache holds only public same-origin files');
  need(R['3 offline banner (live page)'] && R['3 offline navigation']?.offlinePage, 'offline banner and offline page');
  need(R['4 update']?.updateOffered && R['4 update']?.oldCacheDeleted, 'update offered and old cache removed');
  need((R['5 manifest']?.icons ?? []).every((i) => i.endsWith('ok')), 'manifest icons match their sizes');
  need((R['6 installability errors'] ?? ['?']).length === 0 && (R['6 manifest parse errors'] ?? ['?']).length === 0, 'Chromium reports the app installable');
  need(R['7 deep link']?.landedOn === '/app/billing?changed=1', 'deep link survives sign-in');
  need((R.consoleErrors ?? []).length === 0, 'no console errors');
  if (failures.length) { console.error('PWA CHECK FAILED: ' + failures.join('; ')); process.exit(1); }
  console.log('ALL PWA CHECKS PASSED');
})().catch((e) => { console.error(e); process.exit(1); });
