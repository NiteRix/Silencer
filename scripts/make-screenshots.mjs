/*
 * Screenshots the real panel. The page, its CSS and all six of its scripts are
 * the shipped files; only the CEP bridge is stubbed, so the waveform below is
 * genuine output from analyzer.js decoding a genuine wav.
 */
// Needs playwright-core and a Chromium build:
//   npm i playwright-core
//   CHROMIUM_PATH=/path/to/chrome node scripts/make-screenshots.mjs /tmp/fixture.wav
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(new URL('..', import.meta.url).pathname);
const OUT = path.join(REPO, 'docs/screenshots');
const MEDIA = process.argv[2];
if (!MEDIA) {
  console.error('Usage: node scripts/make-screenshots.mjs /absolute/path/to/fixture.wav');
  console.error('Generate one with: python3 scripts/make-fixture-wav.py /tmp/fixture.wav');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const SEQUENCE = {
  ok: true,
  name: 'EP12 – Interview Master',
  sequenceID: '1a2b3c',
  fps: 29.97,
  duration: 42.0,
  videoTrackCount: 2,
  warnings: [],
  audioTracks: [
    {
      index: 0, name: 'Dialogue', muted: false, locked: false,
      clips: [{
        kind: 'audio', track: 0, index: 0, name: 'interview-take.wav',
        start: 0, end: 42.0, inPoint: 0, outPoint: 42.0,
        speed: 1, disabled: false, mediaPath: MEDIA
      }]
    },
    { index: 1, name: 'Music bed', muted: true, locked: false,
      clips: [{
        kind: 'audio', track: 1, index: 0, name: 'bed_loop.wav',
        start: 0, end: 42.0, inPoint: 0, outPoint: 42.0,
        speed: 1, disabled: false, mediaPath: MEDIA
      }] }
  ]
};

const stub = (sequence) => {
  window.__adobe_cep__ = {
    getExtensionId: () => 'com.niterix.silencer.panel',
    getSystemPath: () => '/Users/you/Library/Application Support/Adobe/CEP/extensions/com.niterix.silencer',
    getHostEnvironment: () => JSON.stringify({
      appName: 'PPRO', appVersion: '25.3.0',
      appSkinInfo: { panelBackgroundColor: { color: { red: 30, green: 31, blue: 34, alpha: 255 } } }
    }),
    evalScript: (script, cb) => {
      const fn = (script.match(/\$\.silencer\.(\w+)\(/) || [])[1];
      const answers = {
        ping: { ok: true, app: '25.3.0', hasSequence: true, sequenceName: sequence.name, scriptVersion: '1.0.0', log: [] },
        getSequenceInfo: { ...sequence, log: [] },
        applyCuts: { ok: true, backup: sequence.name + ' [BACKUP 2026-09-19 143022]', cuts: 4,
                     skipped: 0, segmentsRemoved: 8, clipsMoved: 8, removedDuration: 9.7, warnings: [], log: [] },
        addMarkers: { ok: true, markers: 4, log: [] }
      };
      setTimeout(() => cb(JSON.stringify(answers[fn] || { ok: false, error: 'unknown call', log: [] })), 30);
    }
  };
};

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--allow-file-access-from-files', '--autoplay-policy=no-user-gesture-required']
});

const page = await browser.newPage({
  viewport: { width: 380, height: 760 },
  deviceScaleFactor: 2
});
page.on('console', m => console.log('  [panel]', m.text()));
page.on('pageerror', e => console.log('  [error]', e.message));

await page.addInitScript(stub, SEQUENCE);
await page.goto('file://' + path.join(REPO, 'extension/index.html'));
await page.waitForFunction(() => !document.getElementById('analyze').disabled, null, { timeout: 15000 });
await page.waitForTimeout(400);

await page.screenshot({ path: path.join(OUT, '1-ready.png') });
console.log('1-ready.png');

// Run the real analysis.
await page.click('#analyze');
await page.waitForFunction(() => !document.getElementById('results').classList.contains('hidden'), null, { timeout: 60000 });
await page.waitForTimeout(600);
await page.screenshot({ path: path.join(OUT, '2-analyzed.png') });
console.log('2-analyzed.png  ->', await page.textContent('#status'));

// Settings open.
await page.evaluate(() => {
  document.getElementById('settings-card').open = true;
  document.getElementById('autoThreshold').checked = false;
  document.getElementById('autoThreshold').dispatchEvent(new Event('change'));
});
await page.waitForTimeout(900);
await page.evaluate(() => window.scrollTo(0, 260));
await page.waitForTimeout(200);
await page.screenshot({ path: path.join(OUT, '3-settings.png') });
console.log('3-settings.png');

// Details / log, after a cut.
await page.evaluate(() => {
  document.getElementById('settings-card').open = false;
  document.getElementById('autoThreshold').checked = true;
  document.getElementById('autoThreshold').dispatchEvent(new Event('change'));
});
await page.waitForTimeout(900);
await page.evaluate(() => { window.confirm = () => true; });
await page.click('#cut');
await page.waitForTimeout(900);
await page.evaluate(() => { document.getElementById('log-card').open = true; window.scrollTo(0, 99999); });
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(OUT, '4-after-cut.png') });
console.log('4-after-cut.png ->', await page.textContent('#status'));

// A wider view for the README hero shot.
await page.setViewportSize({ width: 460, height: 1130 });
await page.evaluate(() => { document.getElementById('log-card').open = false; window.scrollTo(0, 0); });
await page.reload();
await page.waitForFunction(() => !document.getElementById('analyze').disabled, null, { timeout: 15000 });
await page.click('#analyze');
await page.waitForFunction(() => !document.getElementById('results').classList.contains('hidden'), null, { timeout: 60000 });
await page.evaluate(() => { document.getElementById('settings-card').open = true; });
await page.waitForTimeout(700);
await page.screenshot({ path: path.join(OUT, '0-panel.png') });
console.log('0-panel.png');

await browser.close();
