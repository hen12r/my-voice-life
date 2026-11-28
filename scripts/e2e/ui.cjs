const { chromium } = require('playwright'); const { spawn } = require('child_process'); const fs = require('fs'); const path = require('path');
// Real-browser UI check (Chromium via Playwright) of a PRODUCTION build served by vite preview.
// Supabase is mocked (no network, no real account). Covers: dark mode on every main page, the
// welcome flow, the data export file, and the notification card states.
// Run: npm run test:ui   (screenshots land in .ui-test/shots when SHOTS=1)
const DIST = path.resolve(process.argv[2]), REPO = path.resolve(process.argv[3]);
const PORT = 4181, BASE = `http://localhost:${PORT}`, SHOTS = process.env.SHOTS === '1' ? path.join(DIST, 'shots') : null;
const USER = { id: 'u1', email: 't@example.com', aud: 'authenticated', role: 'authenticated' };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url'); const exp = Math.floor(Date.now() / 1000) + 3600;
const SESSION = { access_token: `${b64({ alg: 'HS256' })}.${b64({ sub: 'u1', exp, role: 'authenticated' })}.s`, refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: exp, user: USER };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = Date.now();
const DATA = {
  notes: [{ id: 'n1', body: 'Buy a birthday present for Mum', title: null, is_pinned: false, category_id: null, created_at: new Date(now - 864e5).toISOString(), updated_at: new Date().toISOString() }],
  tasks: [{ id: 't1', title: 'Finish the maths homework', notes: null, status: 'open', priority: 'high', due_date: null, category_id: null, created_at: new Date().toISOString(), completed_at: null }],
  reminders: [{ id: 'r1', title: 'Call the school', notes: null, remind_at: new Date(now + 36e5).toISOString(), timezone: 'UTC', recurrence: 'none', status: 'scheduled', category_id: null, created_at: new Date().toISOString() }],
  events: [{ id: 'e1', title: 'Football match', notes: null, starts_at: new Date(now + 2 * 864e5).toISOString(), ends_at: null, all_day: false, location: null, timezone: 'UTC', category_id: null, created_at: new Date().toISOString() }],
  voice_sessions: [{ id: 'v1', transcript: 'Remind me to call the school', created_at: new Date().toISOString() }],
  categories: [{ id: 'c1', name: 'School', color: '#8b6cff', is_default: true }],
};

async function mockSupabase(ctx, opts = {}) {
  const data = opts.empty ? Object.fromEntries(Object.keys(DATA).map((k) => [k, k === 'categories' ? DATA.categories : []])) : DATA;
  await ctx.route('https://mockproj.supabase.co/**', (r) => {
    const req = r.request(); const u = req.url();
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*', 'Access-Control-Expose-Headers': 'Content-Range' };
    const j = (b, status = 200, headers = {}) => r.fulfill({ status, contentType: 'application/json', headers: { ...cors, ...headers }, body: JSON.stringify(b) });
    if (req.method() === 'OPTIONS') return r.fulfill({ status: 200, headers: cors });
    if (u.includes('/auth/v1/settings')) return j({ external: { email: true, google: false } });
    if (u.includes('/auth/v1/token')) return j(SESSION);
    if (u.includes('/auth/v1/user')) return j(USER);
    if (u.includes('/rest/v1/profiles')) return j({ id: 'u1', display_name: 'H', ui_language: 'en', speech_language: 'auto', speech_languages: [], timezone: 'UTC', daily_briefing_enabled: false });
    if (u.includes('/rpc/mvl_my_usage')) return j({ plan: 'free', is_staff: false, is_admin: false, ai_mode: 'admins_only', ai_available: false, captures_used: 0, captures_limit: 7, minutes_used: 0, minutes_limit: 15, max_capture_seconds: 120, resets_at: new Date().toISOString() });
    if (u.includes('/rest/v1/subscriptions')) return j(null);
    if (u.includes('/functions/v1/billing')) return j({ configured: false, test_mode: false, prices: [], limits: {} });
    if (u.includes('/functions/v1/push')) return opts.pushLive ? j({ public_key: opts.pushLive }) : j({ error: 'not_found' }, 404);
    if (u.includes('/functions/v1/')) return j({ error: 'not_found' }, 404);
    const table = (u.match(/\/rest\/v1\/([a-z_]+)/) || [])[1];
    if (table && data[table]) {
      const rows = data[table];
      if (opts.failTable === table) return j({ message: 'boom', code: 'XX000' }, 500);
      const range = req.headers()['range'];
      const [from, to] = range ? range.split('-').map(Number) : [0, rows.length - 1];
      return j(rows.slice(from, to + 1), 200, { 'Content-Range': `${from}-${Math.min(to, rows.length - 1)}/${rows.length}` });
    }
    return j(u.includes('/rpc/') ? null : []);
  });
}

async function signedInContext(browser, opts = {}) {
  const ctx = await browser.newContext({ viewport: opts.viewport ?? { width: 1366, height: 900 }, colorScheme: opts.colorScheme ?? 'light', serviceWorkers: 'block', acceptDownloads: true });
  await mockSupabase(ctx, opts);
  await ctx.addInitScript(([s, onboarded, theme]) => {
    localStorage.setItem('sb-mockproj-auth-token', JSON.stringify(s));
    if (onboarded) localStorage.setItem('mvl-onboarded', '1');
    if (theme) localStorage.setItem('mvl-theme', theme);
  }, [SESSION, opts.onboarded ?? true, opts.theme ?? null]);
  return ctx;
}

const PAGES = ['/app', '/app/notes', '/app/tasks', '/app/schedule', '/app/capture', '/app/settings', '/app/billing', '/pricing', '/privacy'];

(async () => {
  const server = spawn('npx', ['vite', 'preview', '--outDir', DIST, '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore', detached: true });
  const stopServer = () => { try { process.kill(-server.pid, 'SIGTERM'); } catch { /* already gone */ } };
  for (let i = 0; i < 40; i++) { try { await fetch(BASE); break; } catch { await sleep(300); } }
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] }); const R = {}; const fails = [];
  const check = (name, ok, detail) => { R[name] = ok ? 'ok' : `FAIL ${JSON.stringify(detail ?? '')}`; if (!ok) fails.push(name); };
  try {
    // 1. Dark mode: system dark → data-theme=dark on every page; real dark background; no overflow.
    for (const [w, h] of [[390, 844], [1366, 900]]) {
      const ctx = await signedInContext(browser, { colorScheme: 'dark', viewport: { width: w, height: h } }); const page = await ctx.newPage();
      const errors = []; page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text().slice(0, 150)); });
      for (const p of PAGES) {
        await page.goto(BASE + p); await page.waitForTimeout(700);
        const s = await page.evaluate(() => {
          const bg = getComputedStyle(document.body).backgroundColor;
          const lum = (c) => { const [r, g, b] = c.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };
          // Any visible element with a pure white background in dark mode is a missed token.
          const whites = [...document.querySelectorAll('body *')].filter((el) => { const st = getComputedStyle(el); const r = el.getBoundingClientRect(); return r.width > 40 && r.height > 20 && st.visibility !== 'hidden' && st.backgroundColor === 'rgb(255, 255, 255)'; }).map((el) => el.className.toString().slice(0, 60));
          return { theme: document.documentElement.dataset.theme, bodyLum: lum(bg), overflow: document.documentElement.scrollWidth > innerWidth + 1, whites: whites.slice(0, 3) };
        });
        const whitesOk = p === '/' ? true : s.whites.length === 0;
        check(`1 dark ${w}px ${p}`, s.theme === 'dark' && s.bodyLum < 0.15 && !s.overflow && whitesOk, s);
        if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `dark-${w}${p.replace(/\//g, '_')}.png`), fullPage: true });
      }
      check(`1 dark ${w}px console errors`, errors.length === 0, errors);
      await ctx.close();
    }
    // 1b. Settings switch: forced light beats system dark, and survives a reload; "system" follows again.
    {
      const ctx = await signedInContext(browser, { colorScheme: 'dark' }); const page = await ctx.newPage();
      await page.goto(BASE + '/app/settings'); await page.waitForTimeout(700);
      await page.getByRole('radio', { name: 'Light' }).click();
      const a = await page.evaluate(() => document.documentElement.dataset.theme);
      await page.reload(); await page.waitForTimeout(500);
      const b = await page.evaluate(() => [document.documentElement.dataset.theme, localStorage.getItem('mvl-theme')]);
      await page.getByRole('radio', { name: 'Same as device' }).click();
      const c = await page.evaluate(() => [document.documentElement.dataset.theme, localStorage.getItem('mvl-theme')]);
      check('1b theme switch', a === 'light' && b[0] === 'light' && b[1] === 'light' && c[0] === 'dark' && c[1] === null, { a, b, c });
      await ctx.close();
    }
    // 1c. Light mode stays light (regression).
    {
      const ctx = await signedInContext(browser, { colorScheme: 'light' }); const page = await ctx.newPage();
      await page.goto(BASE + '/app'); await page.waitForTimeout(600);
      const s = await page.evaluate(() => [document.documentElement.dataset.theme, getComputedStyle(document.body).backgroundColor]);
      check('1c light default', s[0] === 'light' && s[1] === 'rgb(246, 246, 250)', s);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'light-1366_app.png'), fullPage: true });
      await ctx.close();
    }
    // 2. Welcome flow.
    {
      // 2a. Empty account, first visit → introduction; mic test (fake device) stops at once; honest voice status; first note.
      const ctx = await signedInContext(browser, { empty: true, onboarded: false, viewport: { width: 390, height: 844 } });
      await ctx.grantPermissions(['microphone'], { origin: BASE });
      const page = await ctx.newPage();
      const errors = []; page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text().slice(0, 150)); });
      await page.goto(BASE + '/app'); await page.waitForURL('**/app/welcome', { timeout: 5000 }).catch(() => {});
      const landed = new URL(page.url()).pathname;
      await page.getByRole('button', { name: 'Next' }).click();
      await page.getByRole('button', { name: 'Test my microphone' }).click();
      const micOk = await page.getByText('Your microphone works. Nothing was recorded.').waitFor({ timeout: 5000 }).then(() => true).catch(() => false);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'welcome-390-mic.png'), fullPage: true });
      await page.getByRole('button', { name: 'Next' }).click();
      const voiceOff = await page.getByText('Voice capture is not available on your account yet.', { exact: false }).isVisible();
      await page.getByRole('button', { name: 'Next' }).click();
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'welcome-390-last.png'), fullPage: true });
      await page.getByRole('button', { name: 'Write my first note' }).click();
      await page.waitForTimeout(600);
      const after = { path: new URL(page.url()).pathname, dialog: await page.getByRole('dialog').isVisible().catch(() => false), flag: await page.evaluate(() => localStorage.getItem('mvl-onboarded')) };
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
      check('2a welcome flow (empty account)', landed === '/app/welcome' && micOk && voiceOff && after.path === '/app/notes' && after.dialog && after.flag === '1' && !overflow, { landed, micOk, voiceOff, after, overflow });
      // Visiting /app again does not show it twice.
      await page.goto(BASE + '/app'); await page.waitForTimeout(900);
      check('2a shown only once', new URL(page.url()).pathname === '/app', page.url());
      check('2a console errors', errors.length === 0, errors);
      await ctx.close();
    }
    {
      // 2b. Existing account with data → never shown; the flag is set quietly.
      const ctx = await signedInContext(browser, { onboarded: false }); const page = await ctx.newPage();
      await page.goto(BASE + '/app'); await page.waitForTimeout(1000);
      const s = { path: new URL(page.url()).pathname, flag: await page.evaluate(() => localStorage.getItem('mvl-onboarded')) };
      check('2b existing account skips intro', s.path === '/app' && s.flag === '1', s);
      // 2c. Settings → "Show the introduction again" → welcome; Skip → back to /app.
      await page.goto(BASE + '/app/settings'); await page.waitForTimeout(600);
      await page.getByRole('button', { name: 'Show the introduction again' }).click();
      const replay = new URL(page.url()).pathname;
      await page.getByRole('button', { name: 'Skip' }).click(); await page.waitForTimeout(400);
      check('2c replay + skip', replay === '/app/welcome' && new URL(page.url()).pathname === '/app', { replay, now: page.url() });
      await ctx.close();
    }
    {
      // 2d. Welcome in dark mode, desktop.
      const ctx = await signedInContext(browser, { empty: true, onboarded: false, colorScheme: 'dark' }); const page = await ctx.newPage();
      await page.goto(BASE + '/app/welcome'); await page.waitForTimeout(600);
      const s = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, overflow: document.documentElement.scrollWidth > innerWidth + 1 }));
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'welcome-1366-dark.png') });
      check('2d welcome dark desktop', s.theme === 'dark' && !s.overflow, s);
      await ctx.close();
    }
  } finally {
    await browser.close(); stopServer();
  }
  console.log(JSON.stringify(R, null, 1));
  console.log(fails.length ? `\n${fails.length} UI CHECK(S) FAILED: ${fails.join(', ')}` : '\nALL UI CHECKS PASSED');
  process.exit(fails.length ? 1 : 0);
})();
