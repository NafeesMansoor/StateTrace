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

log('problems:', JSON.stringify(problems));
assert.deepEqual(problems, []);
await browser.close();
server.close();
fs.rmSync(OUT, { recursive: true, force: true });
log('E2E OK');
