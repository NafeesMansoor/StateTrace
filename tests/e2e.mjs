// End-to-end test: drives the real page in headless Chrome with mouse, keyboard and touch.
// Run with `npm run test:e2e`. Set CHROME_PATH if Chrome is not in a usual place.
import puppeteer from 'puppeteer-core';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../scripts/serve.mjs';

const CHROME = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((file) => file && fs.existsSync(file));
if (!CHROME) throw new Error('Chrome was not found. Set CHROME_PATH to its executable.');

const server = await startServer(0);
const BASE = `http://localhost:${server.address().port}`;
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'statetrace-e2e-')) + path.sep;
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: process.env.CI ? ['--no-sandbox'] : [],
  defaultViewport: { width: 1440, height: 900 },
});
const page = await browser.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) problems.push('console: ' + m.text() + ' ' + (m.location()?.url || '')); });
page.on('response', (r) => { if (r.status() >= 400) problems.push('http ' + r.status() + ' ' + r.url()); });
page.on('dialog', (d) => d.accept());

await page.goto(BASE + '/index.html', { waitUntil: 'networkidle0' });
await page.evaluate(() => { localStorage.removeItem('fsm'); });
await page.reload({ waitUntil: 'networkidle0' });

const box = async () => (await page.$('#canvas')).boundingBox();
const at = async (x, y) => { const b = await box(); return [b.x + x, b.y + y]; };
const dbl = async (x, y) => { const [px, py] = await at(x, y); await page.mouse.click(px, py, { count: 2 }); };
const click = async (x, y) => { const [px, py] = await at(x, y); await page.mouse.click(px, py); };
const drag = async (x1, y1, x2, y2, shift) => {
  const [ax, ay] = await at(x1, y1); const [bx, by] = await at(x2, y2);
  if (shift) await page.keyboard.down('Shift');
  await page.mouse.move(ax, ay); await page.mouse.down();
  await page.mouse.move((ax + bx) / 2, (ay + by) / 2, { steps: 4 });
  await page.mouse.move(bx, by, { steps: 4 });
  await page.mouse.up();
  if (shift) await page.keyboard.up('Shift');
};
const text = (sel) => page.$eval(sel, (e) => e.textContent.trim());
const hidden = (sel) => page.$eval(sel, (e) => e.hidden);
const disabled = (sel) => page.$eval(sel, (e) => e.disabled);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const machine = () => page.evaluate(() => serializeMachine());
const shape = (m) => [m.nodes.map((n) => [n.text, n.isAcceptState]), m.links.map((l) => [l.type, l.node ?? [l.nodeA, l.nodeB], l.text])];
const log = (...a) => console.log(...a);
const settle = () => sleep(900); // let a step's animation finish

// ---- page metadata of the standalone tool ----
assert.equal(await page.title(), 'DFA & NFA Simulator | StateTrace Finite Automata Tool');
assert.equal(await page.$eval('link[rel=canonical]', (e) => e.href), 'https://www.nafees.info/gnu-projects/statetrace');
assert.equal((await page.$$('h1')).length, 1);
assert.equal(await text('h1'), 'StateTrace Interactive DFA & NFA Simulator');
assert.equal(await page.$('meta[name=robots]'), null, 'not blocked from indexing');

// ---- empty board ----
assert.equal(await hidden('#empty-state'), false);
assert.equal(await text('#mode-label'), 'No machine');
assert.deepEqual(await page.$$eval('#sim-reset,#sim-previous,#sim-play,#sim-next,#tool-undo,#tool-redo,#tool-delete,#tool-start,#tool-accept', (b) => b.map((x) => x.disabled)), Array(9).fill(true));
await page.click('#sim-form button[type=submit]');
assert.match(await text('#sim-messages'), /board is empty/);

// ---- draw the NFA "ends in ab" with the original mouse and keyboard gestures ----
await dbl(250, 420); await page.keyboard.type('q0');
await dbl(550, 420); await page.keyboard.type('q1');
await dbl(850, 420); await page.keyboard.type('q2');
await sleep(600); await dbl(850, 420); // second double-click: accepting
await drag(130, 420, 240, 420, true); // start arrow
await drag(250, 420, 550, 420, true); await page.keyboard.type('a');
await drag(550, 420, 850, 420, true); await page.keyboard.type('b');
await drag(250, 410, 250, 395, true); await page.keyboard.type('a,b'); // self loop on q0
let drawn = await machine();
log('drawn:', JSON.stringify(shape(drawn)));
assert.deepEqual(shape(drawn), [[['q0', false], ['q1', false], ['q2', true]], [['StartLink', 0, ''], ['Link', [0, 1], 'a'], ['Link', [1, 2], 'b'], ['SelfLink', 0, 'a,b']]]);
assert.deepEqual(drawn.nodes.map((n) => [n.x, n.y]), [[250, 420], [550, 420], [850, 420]], 'coordinates are board coordinates');
assert.equal(await page.evaluate(() => JSON.stringify(serializeMachine()) === localStorage.fsm), true, 'saved drawing format unchanged');
assert.equal(await hidden('#empty-state'), true);
assert.equal(await text('#mode-label'), 'NFA');
assert.deepEqual([await text('#stat-states'), await text('#stat-transitions'), await text('#stat-alphabet')], ['3', '3', '{a, b}']);

// ---- undo / redo with the keyboard, on the board ----
await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
assert.equal((await machine()).links[3].text, 'a,', 'undo removed the last typed character');
await page.keyboard.down('Control'); await page.keyboard.down('Shift'); await page.keyboard.press('z'); await page.keyboard.up('Shift'); await page.keyboard.up('Control');
assert.equal((await machine()).links[3].text, 'a,b', 'redo restored it');
await sleep(50);
assert.equal(await disabled('#tool-undo'), false); assert.equal(await disabled('#tool-redo'), true);

// ---- execute "aab" ----
await page.$eval('#sim-speed', (e) => { e.value = 3; e.oninput(); });
await page.click('#sim-input'); await page.keyboard.type('aab');
assert.equal((await machine()).links[3].text, 'a,b', 'typing in the input must not edit the diagram');
await page.keyboard.press('Enter');
assert.match(await text('#sim-step'), /^Step 0 of 3 · Start in \{q0\}\.$/);
assert.equal(await page.$eval('#sim-play', (e) => e.getAttribute('aria-label')), 'Pause');
assert.equal(await text('#sim-verdict-title'), 'Running');
await page.waitForFunction(() => !document.getElementById('sim-verdict').classList.contains('pending'), { timeout: 5000 });
await settle();
log('verdict:', await text('#sim-verdict-title'), '|', await text('#sim-verdict-text'), '|', await text('#sim-verdict-path'));
assert.equal(await text('#sim-verdict-title'), 'Accepted');
assert.equal(await text('#sim-verdict-text'), 'All 3 symbols were read and the machine can be in {q0, q2}. {q2} is accepting, so at least one computation branch accepts.');
assert.equal(await text('#sim-verdict-path'), 'Accepting path: q0 —a→ q0 —a→ q1 —b→ q2');
assert.equal(await text('#sim-counter'), '3 of 3');
assert.equal(await text('#sim-states-title'), 'Active states (2)');
assert.deepEqual(await page.$$eval('#sim-states li', (l) => l.map((x) => [x.textContent, x.classList.contains('accepting')])), [['q0', false], ['q2', true]]);
assert.equal(await text('#sim-consumed'), 'aab');
const rows = await page.$$eval('#sim-trace-body li', (r) => r.map((x) => [...x.children].map((c) => c.textContent)));
log('trace:'); rows.forEach((r) => log('  ', r.join(' | ')));
assert.deepEqual(rows.map((r) => r[2]), ['{q0}', '{q0, q1}', '{q0, q1}', '{q0, q2}']);
let hl = await page.evaluate(() => simulationHighlight);
assert.deepEqual(Object.keys(hl.nodes), ['0', '2']);
assert.equal(hl.nodes[2].stroke, '#46e0a3'); assert.equal(hl.nodes[2].halo, 1); assert.deepEqual(hl.tokens, []);

// ---- stepping ----
await page.click('#sim-previous');
assert.match(await text('#sim-step'), /^Step 2 of 3 · Read 'a': \{q0, q1\} → \{q0, q1\}$/);
assert.equal(await text('#sim-remaining'), 'b');
assert.equal(await text('#sim-verdict-title'), 'Running');
assert.deepEqual(await page.$$eval('#sim-trace-body li', (r) => r.map((x) => x.hidden)), [false, false, false, true]);
assert.deepEqual(await page.$$eval('#sim-tape .cell', (c) => c.map((x) => x.className)), ['cell done', 'cell current', 'cell todo']);
assert.deepEqual(await page.$$eval('#sim-moves li', (l) => l.map((x) => [x.textContent, x.className])), [['q0 —a→ q1', ''], ['q0 —a→ q0', ''], ["q1 ✗ no transition on 'a'", 'dead']]);
hl = await page.evaluate(() => simulationHighlight);
assert.deepEqual(Object.keys(hl.nodes), ['0', '1']);
assert.deepEqual(Object.keys(hl.links).sort(), ['1', '3']);
const ring = (x, y) => page.evaluate((x, y) => { const d = canvas.getContext('2d').getImageData(Math.round((x * view.scale + view.x) * pixelRatio), Math.round((y * view.scale + view.y) * pixelRatio), 1, 1).data; return [d[0], d[1], d[2]]; }, x, y);
log('q1 ring (active):', await ring(550, 420 - 31), ' q2 ring (inactive, dimmed):', await ring(850, 420 - 31));
assert.deepEqual(await ring(550, 420 - 31), [255, 111, 97], 'active state is drawn in coral');
await page.click('#sim-reset');
assert.match(await text('#sim-step'), /^Step 0 of 3/);
assert.equal(await disabled('#sim-previous'), true);
// Next animates: a dot travels along each transition taken, one per NFA branch
await page.$eval('#sim-speed', (e) => { e.value = 0.25; e.oninput(); });
await page.click('#sim-next');
await sleep(180);
hl = await page.evaluate(() => simulationHighlight);
log('mid-animation tokens:', JSON.stringify(hl.tokens));
assert.equal(hl.tokens.length, 2, 'two branches, two dots');
assert.ok(hl.tokens.every((t) => t.t > 0 && t.t < 1));
await sleep(1100);
hl = await page.evaluate(() => simulationHighlight);
assert.deepEqual(hl.tokens, []); assert.deepEqual(Object.keys(hl.nodes), ['0', '1']);
assert.match(await text('#sim-step'), /^Step 1 of 3 · Read 'a': \{q0\} → \{q0, q1\}$/);
await page.click('#sim-trace-body li:nth-child(1)');
assert.match(await text('#sim-step'), /^Step 0 of 3/);
// play / pause
await page.click('#sim-play');
assert.equal(await page.$eval('#sim-play', (e) => e.getAttribute('aria-label')), 'Pause');
await page.click('#sim-play');
assert.equal(await page.$eval('#sim-play', (e) => e.getAttribute('aria-label')), 'Play');
await sleep(400);
assert.match(await text('#sim-step'), /^Step 0 of 3/, 'paused: no step taken');
await page.$eval('#sim-speed', (e) => { e.value = 3; e.oninput(); });

// ---- exports: unchanged formats, no simulation colours, mid-simulation ----
await page.click('#sim-next'); await settle();
const svg = await page.evaluate(() => saveAsSVG());
assert.ok(svg.startsWith('<?xml') && svg.includes('<ellipse') && svg.includes('>q2</text>') && svg.includes('stroke="black"'));
assert.ok(!/ff6f61|46e0a3|5b8cff|rgba/.test(svg), 'svg has no board or simulation colours');
log('svg header:', svg.match(/<svg [^>]+>/)[0]);
const tex = await page.evaluate(() => saveAsLaTeX());
assert.ok(tex.includes('\\begin{tikzpicture}') && tex.includes('$q2$') && tex.includes('\\draw [black]') && !tex.includes('ff6f61'));
await page.click('#export-button');
assert.equal(await page.$eval('#export-dialog', (d) => d.open), true);
assert.ok((await page.$eval('#export-preview', (i) => i.src)).startsWith('data:image/png;base64,'));
const grab = () => page.evaluate(() => new Promise((resolve) => {
  const orig = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () { HTMLAnchorElement.prototype.click = orig; resolve({ name: this.download, href: this.href.slice(0, 30) }); };
  document.getElementById('export-download').click();
}));
log('png:', JSON.stringify(await grab()));
for (const [fmt, name, probe] of [['svg', 'state-machine.svg', '<?xml'], ['latex', 'state-machine.tex', '\\documentclass'], ['json', 'state-machine.json', '{\n  "nodes"']]) {
  await page.click(`[data-format=${fmt}]`);
  assert.ok((await page.$eval('#output', (e) => e.value)).startsWith(probe), fmt);
  assert.equal(await hidden('#export-preview'), true);
  const got = await grab(); assert.equal(got.name, name); assert.ok(got.href.startsWith('blob:'));
}
const json = await page.$eval('#output', (e) => e.value);
assert.deepEqual(JSON.parse(json), await machine());
// ---- every PNG and SVG export is signed ----
const SIGNATURE = 'Copyright Nafees Mansoor';
const PNG_FIELD = Buffer.from('tEXtCopyright\0' + SIGNATURE, 'latin1');
const pngBytes = (url) => Buffer.from(url.slice('data:image/png;base64,'.length), 'base64');
// what the browser makes of a signed SVG: where the signature and the drawing really end up
const measureSVG = (target, source) => target.evaluate((source) => {
  const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
  if (doc.querySelector('parsererror')) return { error: doc.querySelector('parsererror').textContent };
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-99999px;top:0';
  const root = host.appendChild(document.importNode(doc.documentElement, true));
  document.body.appendChild(host);
  const rect = (b) => ({ left: b.x, top: b.y, right: b.x + b.width, bottom: b.y + b.height });
  const text = root.querySelector('#statetrace-signature text');
  const drawn = [...root.children].filter((e) => e.id != 'statetrace-signature').map((e) => rect(e.getBBox()));
  const out = {
    viewBox: rect(root.viewBox.baseVal), size: [root.width.baseVal.value, root.height.baseVal.value], last: root.lastElementChild.id,
    signature: rect(text.getBBox()), content: text.textContent, fontSize: parseFloat(text.getAttribute('font-size')),
    drawingBottom: Math.max(...drawn.map((b) => b.bottom)), inspected: ExportProtection.inspectSVG(source).fontSize,
  };
  host.remove();
  return out;
}, source);
const checkSVG = (m, name) => {
  assert.equal(m.error, undefined, name + ': well formed');
  assert.equal(m.content, SIGNATURE, name);
  assert.equal(m.last, 'statetrace-signature', name + ': drawn last, so nothing covers it');
  assert.ok(m.signature.left >= m.viewBox.left && m.signature.right <= m.viewBox.right && m.signature.bottom <= m.viewBox.bottom, name + ': not clipped ' + JSON.stringify(m));
  assert.ok(m.signature.top >= m.drawingBottom, name + ': below the drawing, not over it');
  assert.ok(m.viewBox.right - m.signature.right <= 1.5 * m.fontSize, name + ': at the right edge');
  assert.ok(m.signature.bottom - m.signature.top < 2 * m.fontSize, name + ': one line');
  assert.deepEqual(m.size, [m.viewBox.right - m.viewBox.left, m.viewBox.bottom - m.viewBox.top], name + ': drawn at its own scale');
};
// the pixels of a PNG export: the strip under the drawing, and the ink in each half of it
const measurePNG = (target, url, background) => target.evaluate(async (url, background) => {
  const image = new Image();
  image.src = url;
  await image.decode();
  const c = document.createElement('canvas');
  c.width = image.width; c.height = image.height;
  const g = c.getContext('2d');
  g.drawImage(image, 0, 0);
  const box = contentBounds();
  const drawing = (Math.ceil(box.bottom - box.top) + 48) * 2;
  const strip = g.getImageData(0, drawing, c.width, c.height - drawing);
  const ink = { left: 0, right: 0, minX: Infinity, maxX: -1, minY: Infinity, maxY: -1 };
  for (let y = 0; y < strip.height; y++) for (let x = 0; x < strip.width; x++) {
    const i = (y * strip.width + x) * 4;
    if (background.some((v, k) => Math.abs(strip.data[i + k] - v) > 24)) {
      ink[x < strip.width / 2 ? 'left' : 'right']++;
      ink.minX = Math.min(ink.minX, x); ink.maxX = Math.max(ink.maxX, x); ink.minY = Math.min(ink.minY, y); ink.maxY = Math.max(ink.maxY, y);
    }
  }
  return { width: c.width, height: c.height, drawing, expectedWidth: (Math.ceil(box.right - box.left) + 48) * 2, strip: strip.height, ink, file: ExportProtection.inspectPNG(Uint8Array.from(atob(url.slice(22)), (ch) => ch.charCodeAt(0))) };
}, url, background);
const checkPNG = (m, name) => {
  assert.equal(m.width, m.expectedWidth, name + ': as wide as before');
  assert.ok(m.strip > 0 && m.height == m.drawing + m.strip, name + ': a strip was added under the drawing');
  assert.deepEqual([m.file.width, m.file.height], [m.width, m.height], name);
  assert.ok(m.ink.right > 100, name + ': the signature is visible ' + JSON.stringify(m.ink));
  assert.ok(m.ink.minX > 0 && m.ink.maxX < m.width - 4 && m.ink.minY > 0 && m.ink.maxY < m.strip - 2, name + ': not clipped ' + JSON.stringify(m));
  assert.ok(m.width - m.ink.maxX < m.strip, name + ': at the right edge');
};
const BOARD = [9, 15, 36, 255];
const fullGrab = () => page.evaluate(() => new Promise((resolve) => {
  const orig = HTMLAnchorElement.prototype.click;
  const timer = setTimeout(() => { HTMLAnchorElement.prototype.click = orig; resolve(null); }, 400);
  HTMLAnchorElement.prototype.click = function () {
    HTMLAnchorElement.prototype.click = orig; clearTimeout(timer);
    if (this.href.startsWith('blob:')) fetch(this.href).then((r) => r.text()).then((body) => resolve({ name: this.download, body }));
    else resolve({ name: this.download, body: this.href });
  };
  document.getElementById('export-download').click();
}));
const exportState = () => page.evaluate(() => ({
  status: document.getElementById('export-status').textContent, download: document.getElementById('export-download').disabled, copy: document.getElementById('export-copy').disabled,
  preview: document.getElementById('export-preview').getAttribute('src'), previewHidden: document.getElementById('export-preview').hidden, output: document.getElementById('output').value,
}));

// the SVG from the editor itself
assert.equal(svg.split(SIGNATURE).length, 2, 'the SVG is signed once');
const svgSeen = await measureSVG(page, svg);
checkSVG(svgSeen, 'svg');
log('svg signature:', JSON.stringify(svgSeen.signature), 'font', svgSeen.fontSize, 'in', JSON.stringify(svgSeen.viewBox));

// PNG: the preview and the downloaded file are the same signed image
await page.click('[data-format=png]');
const preview = await page.$eval('#export-preview', (i) => i.src);
assert.ok(pngBytes(preview).includes(PNG_FIELD), 'the PNG file carries the copyright field');
const pngSeen = await measurePNG(page, preview, BOARD);
checkPNG(pngSeen, 'png');
assert.equal(pngSeen.ink.left, 0, 'the signature is on the right');
log('png:', pngSeen.width + 'x' + pngSeen.height, 'strip', pngSeen.strip, 'ink', JSON.stringify(pngSeen.ink));
let got = await fullGrab();
assert.equal(got.name, 'state-machine.png'); assert.equal(got.body, preview, 'download gives the signed preview');
assert.match((await exportState()).status, /^Downloaded/);

// SVG: shown, downloaded and copied signed
await page.click('[data-format=svg]');
const shown = await page.$eval('#output', (e) => e.value);
checkSVG(await measureSVG(page, shown), 'svg in the dialog');
got = await fullGrab();
assert.equal(got.name, 'state-machine.svg'); assert.equal(got.body, shown, 'download gives the signed SVG');
await page.evaluate(() => { navigator.clipboard.writeText = (t) => { window.copied = t; return Promise.resolve(); }; });
await page.click('#export-copy');
assert.equal(await page.evaluate(() => window.copied), shown, 'copy gives the signed SVG');

// an image that did not come from the last signed export is not handed out
await page.evaluate(() => ExportProtection.svg('<svg width="300" height="200" viewBox="0 0 300 200" xmlns="http://www.w3.org/2000/svg"></svg>'));
assert.equal(await fullGrab(), null, 'nothing is downloaded');
let state = await exportState();
assert.match(state.status, /^Export blocked: the image did not come from the signed export/);
assert.deepEqual([state.download, state.copy, state.output], [true, true, '']);
await page.click('[data-format=svg]');
assert.equal((await fullGrab()).body, shown, 'exporting again works');

// the signature cannot be drawn: no PNG
await page.evaluate(() => { window.realFillText = CanvasRenderingContext2D.prototype.fillText; });
await page.evaluate(() => { CanvasRenderingContext2D.prototype.fillText = function (t) { if (t != 'Copyright Nafees Mansoor') return window.realFillText.apply(this, arguments); }; });
await page.click('[data-format=png]');
state = await exportState();
assert.match(state.status, /^Export blocked: the signature could not be drawn/);
assert.deepEqual([state.download, state.copy, state.preview, state.previewHidden], [true, true, null, true], 'no unsigned image is shown or offered');
assert.equal(await fullGrab(), null, 'nothing is downloaded');
await page.evaluate(() => { CanvasRenderingContext2D.prototype.fillText = window.realFillText; });
await page.click('[data-format=png]');
assert.equal((await fullGrab()).body, preview, 'and it works again once the signature can be drawn');

// the signing module is not there: no PNG and no SVG
await page.evaluate(() => { window.realProtection = ExportProtection; ExportProtection = undefined; });
for (const fmt of ['svg', 'png']) {
  await page.click(`[data-format=${fmt}]`);
  state = await exportState();
  assert.match(state.status, /^Export blocked: the image could not be signed/, fmt);
  assert.deepEqual([state.download, state.copy, state.preview, state.output], [true, true, null, ''], fmt);
  assert.equal(await fullGrab(), null, fmt + ': nothing is downloaded');
}
await page.click('[data-format=json]');
assert.deepEqual(JSON.parse(await page.$eval('#output', (e) => e.value)), await machine(), 'formats that are not images are unaffected');
assert.equal((await exportState()).download, false);
await page.evaluate(() => { ExportProtection = window.realProtection; });
await page.click('[data-format=svg]');
assert.equal(await page.$eval('#output', (e) => e.value), shown);
await page.click('[data-format=png]');
assert.equal(await page.$eval('#export-preview', (i) => i.src), preview, 'the same drawing exports to the same image');

// a PNG without a background stays transparent everywhere but the signature
const clear = await page.evaluate(async () => {
  const source = document.createElement('canvas');
  source.width = 600; source.height = 300;
  const s = source.getContext('2d');
  s.strokeStyle = '#3366ff'; s.lineWidth = 6; s.beginPath(); s.arc(300, 150, 90, 0, 2 * Math.PI); s.stroke();
  const image = new Image();
  image.src = ExportProtection.png(source);
  await image.decode();
  const c = document.createElement('canvas');
  c.width = image.width; c.height = image.height;
  const g = c.getContext('2d');
  g.drawImage(image, 0, 0);
  const before = s.getImageData(0, 0, 600, 300).data, after = g.getImageData(0, 0, 600, 300).data;
  let changed = 0;
  for (let i = 0; i < before.length; i++) if (before[i] != after[i]) changed++;
  const strip = g.getImageData(0, 300, c.width, c.height - 300).data;
  let inked = 0, inkedLeft = 0;
  for (let i = 3; i < strip.length; i += 4) if (strip[i] > 0) { inked++; if (((i - 3) / 4) % c.width < 300) inkedLeft++; }
  return { size: [c.width, c.height], changed, inked, inkedLeft, corner: [...g.getImageData(0, 0, 1, 1).data] };
});
log('transparent png:', JSON.stringify(clear));
assert.equal(clear.changed, 0, 'the drawing and its transparency are untouched');
assert.deepEqual(clear.corner, [0, 0, 0, 0]);
assert.ok(clear.size[0] == 600 && clear.size[1] > 300 && clear.inked > 100 && clear.inkedLeft == 0, 'only the signature is added, bottom right');

await page.keyboard.press('Escape');
assert.equal(await page.$eval('#export-dialog', (d) => d.open), false);
assert.ok(await page.evaluate(() => simulationHighlight != null), 'the trace is still on screen after exporting');
assert.deepEqual(await page.evaluate(() => [view.scale, view.x, view.y, canvas.id]), [1, 0, 0, 'canvas'], 'export leaves the view alone');

// ---- help ----
await page.click('#help-button');
assert.equal(await page.$eval('#help-dialog', (d) => d.open), true);
assert.equal(await text('#help-title'), 'How to use StateTrace');
await page.click('#help-dialog [data-close]');
assert.equal(await page.$eval('#help-dialog', (d) => d.open), false);

// ---- the same verdicts as before the redesign ----
const exec = async (input) => {
  await page.click('#sim-input', { count: 3 }); await page.keyboard.press('Backspace');
  if (input) await page.keyboard.type(input);
  await page.click('#sim-form button[type=submit]');
  await page.waitForFunction(() => !document.getElementById('sim-verdict').classList.contains('pending'), { timeout: 8000 });
  await settle();
  return [await text('#sim-verdict-title'), await text('#sim-verdict-text')];
};
assert.deepEqual(await exec('aba'), ['Rejected', 'All 3 symbols were read, but none of the states the machine can be in, {q0, q1}, is accepting, so no computation branch accepts.']);
assert.deepEqual(await exec(''), ['Rejected', 'The empty string is rejected because the start state q0 is not an accepting state.']);
assert.equal(await disabled('#sim-play'), true); assert.equal(await text('#sim-counter'), '0 of 0');
assert.deepEqual(await exec('abc'), ['Rejected', "The symbol 'c' at position 3 is not in the alphabet of this machine, {a, b}, so no transition can read it."]);
assert.deepEqual(await page.$$eval('#sim-tape .cell', (c) => c.map((x) => x.className)), ['cell done', 'cell done', 'cell fail']);
assert.equal(await text('#sim-states'), 'None: every branch died');

// ---- editing after using the input clears the stale trace; moving does not ----
await click(250, 420); await page.keyboard.type('x');
assert.equal((await machine()).nodes[0].text, 'q0x');
assert.equal(await hidden('#sim-panel'), true);
assert.equal(await page.evaluate(() => simulationHighlight), null);
assert.match(await text('#sim-messages'), /machine was edited/);
await page.keyboard.press('Backspace');
await exec('ab');
await drag(550, 420, 550, 520);
assert.equal((await machine()).nodes[1].y, 520);
assert.equal(await hidden('#sim-panel'), false, 'moving a state keeps the trace');

// ---- label box ----
await click(400, 470);
assert.equal(await page.evaluate(() => links.indexOf(selectedObject)), 1);
assert.equal(await hidden('#label-editor'), false);
assert.equal(await text('#label-caption'), 'Transition label');
assert.equal(await page.$eval('#label-input', (e) => e.value), 'a');
await page.click('#label-input', { count: 3 }); await page.keyboard.type('\\epsilon'); await page.keyboard.press('Enter');
assert.equal((await machine()).links[1].text, '\\epsilon');
assert.equal(await text('#mode-label'), 'ε-NFA');
assert.equal(await page.evaluate(() => document.activeElement.id), 'canvas', 'Enter returns to the board');
let v = await exec('b');
assert.equal(v[0], 'Accepted'); assert.equal(await text('#sim-verdict-path'), 'Accepting path: q0 —ε→ q1 —b→ q2');
await page.click('#sim-reset');
assert.match(await text('#sim-step'), /Start in \{q0, q1\}, the start state and everything reachable by ε-moves\./);

// ---- malformed machine: reported live and on Execute ----
await click(400, 470); await page.keyboard.press('Backspace');
assert.equal(await text('#mode-label'), 'Not runnable');
assert.match(await text('#machine-problems'), /labelled "\\epsilo"/);
await page.click('#sim-form button[type=submit]');
assert.match(await text('#sim-messages'), /labelled "\\epsilo"/);
assert.equal(await hidden('#sim-panel'), true);
await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
await click(400, 470);

// ---- toolbar: build without keyboard modifiers ----
const before = await machine();
await page.click('#tool-state');
await page.keyboard.type('q3');
let m = await machine();
assert.equal(m.nodes.length, 4); assert.equal(m.nodes[3].text, 'q3');
const center = await page.evaluate(() => viewCenter());
assert.deepEqual([m.nodes[3].x, m.nodes[3].y], [center.x, center.y]);
await page.click('#tool-accept'); assert.equal((await machine()).nodes[3].isAcceptState, true);
assert.equal(await page.$eval('#tool-accept', (e) => e.getAttribute('aria-pressed')), 'true');
await page.click('#tool-transition');
assert.equal(await page.$eval('#tool-transition', (e) => e.getAttribute('aria-pressed')), 'true');
await drag(850, 420, m.nodes[3].x, m.nodes[3].y); // no shift
await page.keyboard.type('a');
m = await machine();
assert.deepEqual(shape(m)[1].at(-1), ['Link', [2, 3], 'a']);
assert.equal(await page.$eval('#tool-transition', (e) => e.getAttribute('aria-pressed')), 'false', 'tool switches off after one transition');
await click(m.nodes[3].x, m.nodes[3].y);
await page.click('#tool-start');
m = await machine();
assert.deepEqual(m.links.filter((l) => l.type === 'StartLink').map((l) => l.node), [3], 'start moved to q3');
await page.click('#tool-undo');
assert.deepEqual((await machine()).links.filter((l) => l.type === 'StartLink').map((l) => l.node), [0]);
await click(m.nodes[3].x, m.nodes[3].y);
await page.click('#tool-delete');
assert.deepEqual(shape(await machine()), shape(before), 'deleting q3 also removes its transition');
// Delete key still works
await page.click('#tool-state'); assert.equal((await machine()).nodes.length, 4);
await page.keyboard.press('Delete'); assert.equal((await machine()).nodes.length, 3);

// ---- zoom, pan, fit: drawing coordinates stay right ----
await page.click('#zoom-in');
assert.equal(await text('#zoom-level'), '125%');
const v1 = await page.evaluate(() => ({ ...view }));
await dbl(700, 200);
m = await machine();
assert.ok(Math.abs(m.nodes[3].x - (700 - v1.x) / 1.25) < 0.01 && Math.abs(m.nodes[3].y - (200 - v1.y) / 1.25) < 0.01, 'a state lands under the pointer when zoomed');
await page.keyboard.press('Delete');
await drag(700, 700, 760, 640); // drag empty board: pan
const v2 = await page.evaluate(() => ({ ...view }));
assert.deepEqual([v2.x - v1.x, v2.y - v1.y], [60, -60]);
assert.deepEqual((await machine()).nodes.map((n) => [n.x, n.y]), before.nodes.map((n) => [n.x, n.y]), 'panning moves the view, not the states');
{ const [px, py] = await at(600, 400); await page.mouse.move(px, py); await page.keyboard.down('Control'); await page.mouse.wheel({ deltaY: -40 }); await page.keyboard.up('Control'); }
assert.ok((await page.evaluate(() => view.scale)) > 1.25, 'ctrl + wheel zooms in');
await page.click('#zoom-fit');
assert.equal(await page.evaluate(() => contentIsVisible()), true);
await page.click('#zoom-level');
assert.deepEqual(await page.evaluate(() => [view.scale, view.x, view.y]), [1, 0, 0]);
assert.equal(await text('#zoom-level'), '100%');

// ---- JSON round trip, clear, import, bad import ----
fs.writeFileSync(OUT + 'machine.json', json);
fs.writeFileSync(OUT + 'bad.json', JSON.stringify({ nodes: [{ x: 1, y: 2, text: 'a' }], links: [{ type: 'Link', nodeA: 0, nodeB: 7, text: 'x' }] }));
fs.writeFileSync(OUT + 'notjson.json', 'hello');
await page.click('#tool-clear');
assert.deepEqual(await machine(), { nodes: [], links: [] });
assert.equal(await hidden('#empty-state'), false);
const upload = async (file) => { await (await page.$('#import-file')).uploadFile(OUT + file); await sleep(250); };
await upload('bad.json');
assert.match(await text('#sim-messages'), /Transition 1 in the file points to a state that does not exist/);
assert.deepEqual(await machine(), { nodes: [], links: [] }, 'a bad file changes nothing');
await upload('notjson.json');
assert.match(await text('#sim-messages'), /not valid JSON/);
await upload('machine.json');
assert.deepEqual(await machine(), JSON.parse(json));
assert.deepEqual(await exec('aab'), ['Accepted', 'All 3 symbols were read and the machine can be in {q0, q2}. {q2} is accepting, so at least one computation branch accepts.']);
// example
await page.click('#tool-clear'); await page.click('#example-button');
assert.equal(await text('#mode-label'), 'NFA');
assert.equal((await exec('bab'))[0], 'Accepted');
// a DFA reports one current state
await page.click('#tool-clear');
await dbl(300, 400); await page.keyboard.type('E'); await sleep(600); await dbl(300, 400);
await dbl(600, 400); await page.keyboard.type('O');
await drag(180, 400, 290, 400, true);
await drag(300, 400, 600, 400, true); await page.keyboard.type('1');
await drag(450, 400, 450, 350);
await drag(600, 400, 300, 400, true); await page.keyboard.type('1');
await drag(450, 400, 450, 450);
await drag(300, 390, 300, 375, true); await page.keyboard.type('0');
await drag(600, 390, 600, 375, true); await page.keyboard.type('0');
assert.equal(await text('#mode-label'), 'DFA');
assert.deepEqual(await exec('0110'), ['Accepted', 'All 4 symbols were read and the machine stopped in E, which is an accepting state.']);
assert.equal(await text('#sim-states-title'), 'Current state');
assert.deepEqual(await exec('0111'), ['Rejected', 'All 4 symbols were read, but the machine stopped in O, which is not an accepting state.']);

// ---- keyboard reachability and names of icon buttons ----
const unnamed = await page.$$eval('button', (b) => b.filter((x) => !(x.getAttribute('aria-label') || x.textContent.trim())).length);
assert.equal(unnamed, 0, 'every button has an accessible name');

// ---- laptop size: no page overflow ----
for (const [w, h] of [[1280, 720], [1024, 768], [820, 1180], [390, 844]]) {
  await page.setViewport({ width: w, height: h });
  await sleep(250);
  const o = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth, canvas.clientWidth, canvas.clientHeight, contentIsVisible()]);
  log(`viewport ${w}x${h}: scrollWidth ${o[0]}, board ${o[2]}x${o[3]}`);
  assert.ok(o[0] <= o[1], 'no horizontal overflow at ' + w);
  assert.ok(o[2] >= 300 && o[3] >= 400);
}

// ---- touch: taps, double tap, drag, with the toolbar for transitions ----
const phone = await browser.newPage();
phone.on('pageerror', (e) => problems.push('phone pageerror: ' + e.message));
phone.on('dialog', (d) => d.accept());
await phone.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
await phone.goto(BASE + '/index.html', { waitUntil: 'networkidle0' });
await phone.evaluate(() => { localStorage.removeItem('fsm'); }); await phone.reload({ waitUntil: 'networkidle0' });
// The page may scroll when a field is focused, so find the board again before every touch.
// After a swipe, wait: Chrome ignores a tap that lands while the swipe's fling is still running.
const pbox = async () => (await phone.$('#canvas')).boundingBox();
const tap = async (x, y) => { const pb = await pbox(); await phone.touchscreen.tap(pb.x + x, pb.y + y); };
const swipe = async (x1, y1, x2, y2) => { const pb = await pbox(); await phone.touchscreen.touchStart(pb.x + x1, pb.y + y1); for (let i = 1; i <= 5; i++) await phone.touchscreen.touchMove(pb.x + x1 + (x2 - x1) * i / 5, pb.y + y1 + (y2 - y1) * i / 5); await phone.touchscreen.touchEnd(); await sleep(700); };
const pm = () => phone.evaluate(() => serializeMachine());
await tap(90, 200); await sleep(60); await tap(90, 200); // double tap: new state
assert.equal((await pm()).nodes.length, 1);
await phone.tap('#label-input'); await phone.keyboard.type('s');
await sleep(500);
await tap(280, 200); await sleep(60); await tap(280, 200);
await phone.tap('#label-input'); await phone.keyboard.type('t');
await phone.tap('#tool-accept');
await swipe(280, 200, 280, 330); // drag the state
let p = await pm();
assert.deepEqual(p.nodes.map((n) => [n.text, n.isAcceptState]), [['s', false], ['t', true]]);
assert.ok(Math.abs(p.nodes[1].y - p.nodes[0].y - 130) < 2, 'dragging with a finger moves a state');
await phone.tap('#tool-transition'); await swipe(90, 200, 280, 330);
await phone.tap('#label-input'); await phone.keyboard.type('a');
await sleep(400); await tap(90, 200); await phone.tap('#tool-start');
p = await pm();
assert.deepEqual(p.links.map((l) => [l.type, l.text]), [['Link', 'a'], ['StartLink', '']]);
await phone.tap('#sim-input'); await phone.keyboard.type('a'); await phone.tap('#sim-form button[type=submit]');
await phone.waitForFunction(() => !document.getElementById('sim-verdict').classList.contains('pending'), { timeout: 8000 });
assert.equal(await phone.$eval('#sim-verdict-title', (e) => e.textContent), 'Accepted');
const po = await phone.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth, canvas.width, canvas.clientWidth]);
log('phone: scrollWidth', po[0], 'of', po[1], '| canvas backing', po[2], 'for', po[3], 'css px');
assert.ok(po[0] <= po[1]); assert.equal(po[2], po[3] * 2, 'sharp on a 2x screen');
const small = await phone.$$eval('button:not([hidden])', (b) => b.filter((x) => x.offsetParent && (x.offsetWidth < 36 || x.offsetHeight < 36)).map((x) => x.id || x.textContent.trim()));
log('buttons under 36px on the phone:', JSON.stringify(small));

// ---- reduced motion: steps apply at once ----
const calm = await browser.newPage();
await calm.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
await calm.setViewport({ width: 1280, height: 800 });
await calm.goto(BASE + '/index.html', { waitUntil: 'networkidle0' });
await calm.evaluate(() => { localStorage.removeItem('fsm'); }); await calm.reload({ waitUntil: 'networkidle0' });
await calm.click('#example-button');
await calm.click('#sim-input'); await calm.keyboard.type('ab'); await calm.keyboard.press('Enter');
await calm.click('#sim-play'); // pause
await calm.click('#sim-reset'); await calm.click('#sim-next');
assert.deepEqual(await calm.evaluate(() => simulationHighlight.tokens), [], 'no travelling dots with reduced motion');
assert.deepEqual(await calm.evaluate(() => Object.keys(simulationHighlight.nodes)), ['0', '1']);

// ---- the signature on the smallest and on a very large drawing ----
const sizes = await browser.newPage();
await sizes.setViewport({ width: 1280, height: 800 });
await sizes.goto(BASE + '/index.html', { waitUntil: 'networkidle0' });
await sizes.evaluate(() => { localStorage.removeItem('fsm'); }); await sizes.reload({ waitUntil: 'networkidle0' });
const fonts = [];
for (const [name, nodes] of [
  ['one state', [{ x: 0, y: 0, text: 'q0', isAcceptState: true }]],
  ['large machine', [{ x: 0, y: 0, text: 'q0', isAcceptState: false }, { x: 2600, y: 0, text: 'q1', isAcceptState: false }, { x: 2600, y: 1700, text: 'q2', isAcceptState: true }, { x: 0, y: 1700, text: 'q3', isAcceptState: false }]],
]) {
  const stored = await sizes.evaluate((nodes) => { loadMachine({ nodes, links: [] }); return JSON.stringify(serializeMachine()); }, nodes);
  const seen = await measureSVG(sizes, await sizes.evaluate(() => saveAsSVG()));
  checkSVG(seen, name + ' svg');
  await sizes.click('#export-button');
  const url = await sizes.$eval('#export-preview', (i) => i.src);
  assert.ok(pngBytes(url).includes(PNG_FIELD), name);
  const pixels = await measurePNG(sizes, url, BOARD);
  checkPNG(pixels, name + ' png');
  await sizes.keyboard.press('Escape');
  assert.equal(await sizes.evaluate(() => JSON.stringify(serializeMachine())), stored, name + ': exporting does not change the machine');
  log(name + ':', 'svg', JSON.stringify(seen.size), 'font', seen.fontSize, '| png', pixels.width + 'x' + pixels.height, 'signature', (pixels.ink.maxX - pixels.ink.minX + 1) + 'x' + (pixels.ink.maxY - pixels.ink.minY + 1));
  fonts.push([seen.fontSize, pixels.ink.maxY - pixels.ink.minY]);
}
assert.ok(fonts[0][0] >= 6 && fonts[0][0] < fonts[1][0] && fonts[0][1] < fonts[1][1], 'the signature grows with the drawing');
await sizes.close();

log('problems:', JSON.stringify(problems));
assert.deepEqual(problems, []);
await browser.close();
server.close();
fs.rmSync(OUT, { recursive: true, force: true });
log('E2E OK');
