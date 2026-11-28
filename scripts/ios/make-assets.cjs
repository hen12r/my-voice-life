// Renders the iOS app icon (1024×1024, square, opaque: iOS applies its own rounded mask) and the
// launch splash (2732×2732) from public/icon.svg with Chromium. Run: node scripts/ios/make-assets.cjs
const { chromium } = require('playwright'); const fs = require('fs'); const path = require('path');
const root = path.join(__dirname, '../..');
const svg = fs.readFileSync(path.join(root, 'public/icon.svg'), 'utf8').replace('rx="16"', 'rx="0"');
const shot = async (page, html, size, out) => {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:#0b1230">${html}</body></html>`);
  await page.screenshot({ path: out, omitBackground: false, clip: { x: 0, y: 0, width: size, height: size } });
};
(async () => {
  const b = await chromium.launch(); const page = await b.newPage({ deviceScaleFactor: 1 });
  const set = path.join(root, 'ios/App/App/Assets.xcassets');
  await shot(page, svg.replace('<svg ', '<svg width="1024" height="1024" '), 1024, path.join(set, 'AppIcon.appiconset/AppIcon-512@2x.png'));
  const splash = `<div style="width:2732px;height:2732px;display:grid;place-items:center">${svg.replace('<svg ', '<svg width="520" height="520" ')}</div>`;
  for (const f of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) await shot(page, splash, 2732, path.join(set, 'Splash.imageset', f));
  await b.close(); console.log('iOS icon and splash written');
})();
