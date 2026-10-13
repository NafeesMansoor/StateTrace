// Tests for the export signature (export-protection.js) and for the static check that
// keeps every export behind it (scripts/check-exports.mjs).
// The module is a classic browser script, so it is evaluated here exactly as shipped.
// What needs a real canvas (the PNG pixels, the dialog) is in e2e.mjs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { checkExports, functionSource } from '../scripts/check-exports.mjs';

const read = (file) => readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const source = read('export-protection.js');
const load = (text) => vm.runInNewContext(text + '\n;ExportProtection', { atob, btoa });
const EP = load(source);
const SIGNATURE = 'Copyright Nafees Mansoor';

// an SVG as fsm.js writes it
const drawing = (width, height, left = 0, top = 0, body = '\t<ellipse stroke="black" stroke-width="1" fill="none" cx="50" cy="50" rx="30" ry="30"/>\n') =>
  `<?xml version="1.0" standalone="no"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n\n<svg width="${width}" height="${height}" viewBox="${left} ${top} ${width} ${height}" version="1.1" xmlns="http://www.w3.org/2000/svg">\n${body}</svg>\n`;
const blocked = (fn, pattern) => assert.throws(fn, (error) => /^Export blocked: /.test(error.message) && pattern.test(error.message));

test('the signature is the required text', () => {
  assert.equal(EP.SIGNATURE, SIGNATURE);
  assert.ok(Object.isFrozen(EP), 'the module cannot be patched by accident');
});

test('an exported SVG carries the signature as its last element', () => {
  const raw = drawing(552, 180, -116, -70);
  const signed = EP.svg(raw);
  assert.ok(signed.includes(`>${SIGNATURE}</text>`));
  assert.match(signed, /<g id="statetrace-signature">\s*<text [^>]*>Copyright Nafees Mansoor<\/text>\s*<\/g>\s*<\/svg>\s*$/);
  assert.equal(signed.split(SIGNATURE).length, 2, 'once');
  assert.ok(signed.includes('<ellipse stroke="black" stroke-width="1" fill="none" cx="50" cy="50" rx="30" ry="30"/>'), 'the drawing is untouched');
  assert.ok(signed.startsWith('<?xml version="1.0" standalone="no"?>\n<!DOCTYPE svg'));
  assert.equal(EP.verify('svg', signed), true);
});

test('the signature sits bottom-right in a strip added under the drawing', () => {
  const signed = EP.svg(drawing(552, 180, -116, -70));
  const { x, y, fontSize, viewBox } = EP.inspectSVG(signed);
  assert.deepEqual([viewBox.x, viewBox.y, viewBox.width], [-116, -70, 552], 'the drawing keeps its place and width');
  assert.ok(viewBox.height > 180, 'the image grew downwards');
  assert.match(signed, new RegExp(`<svg width="552" height="${viewBox.height}" viewBox="-116 -70 552 ${viewBox.height}"`), 'same scale as before');
  assert.ok(y - fontSize >= -70 + 180, 'the text is below the drawing, not over it');
  assert.ok(y < viewBox.y + viewBox.height, 'and above the bottom edge');
  const right = viewBox.x + viewBox.width;
  assert.ok(x < right && right - x >= fontSize * 0.5 && right - x <= fontSize * 1.5, 'padded from the right edge');
});

test('the signature scales with the drawing and always fits', () => {
  let last = 0;
  for (const [width, height] of [[112, 112], [200, 120], [552, 180], [900, 600], [2400, 1600], [6000, 4000], [20000, 12000]]) {
    const place = EP.layout(width, height);
    assert.ok(place.fontSize >= last, `${width}x${height}: no smaller than on a smaller drawing`);
    assert.ok(place.fontSize >= 6 && place.fontSize <= 40, `${width}x${height}: legible, not dominant`);
    assert.ok(13 * place.fontSize + 2 * place.padding <= width + 1e-9, `${width}x${height}: fits in one line`);
    assert.ok(place.band >= place.fontSize + place.padding, `${width}x${height}: the strip holds the text`);
    EP.inspectSVG(EP.svg(drawing(width, height, -40, 25)));
    last = place.fontSize;
  }
  assert.ok(EP.layout(112, 112).fontSize < EP.layout(900, 600).fontSize);
  assert.ok(EP.layout(900, 600).fontSize < EP.layout(6000, 4000).fontSize);
});

test('an SVG that cannot be signed is refused', () => {
  blocked(() => EP.svg(drawing(40, 40)), /too narrow/);
  blocked(() => EP.svg('<svg width="10" height="10" xmlns="http://www.w3.org/2000/svg"></svg>'), /viewBox/);
  blocked(() => EP.svg(drawing(0, 0)), /viewBox/);
  blocked(() => EP.svg('not an image'), /not an SVG/);
  blocked(() => EP.svg(undefined), /not an SVG/);
  blocked(() => EP.svg(EP.svg(drawing(300, 200))), /already signed/);
});

test('an SVG whose signature was removed, changed or hidden does not pass', () => {
  const signed = EP.svg(drawing(600, 400));
  const group = signed.match(/\t<g id="statetrace-signature">[\s\S]*<\/g>\n/)[0];
  blocked(() => EP.inspectSVG(signed.replace(group, '')), /exactly one signature/);
  blocked(() => EP.inspectSVG(signed.replace(SIGNATURE, 'Copyright Someone Else')), /missing or altered/);
  blocked(() => EP.inspectSVG(signed.replace(SIGNATURE, '')), /missing or altered/);
  blocked(() => EP.inspectSVG(signed.replace('fill="#555555"', 'fill="#555555" opacity="0"')), /not styled/);
  blocked(() => EP.inspectSVG(signed.replace('fill="#555555"', 'fill="none"')), /not styled/);
  blocked(() => EP.inspectSVG(signed.replace('text-anchor="end"', 'display="none"')), /not styled/);
  blocked(() => EP.inspectSVG(signed.replace(/font-size="[^"]+"/, 'font-size="0.01"')), /does not fit/);
  blocked(() => EP.inspectSVG(signed.replace(/ y="[^"]+" text-anchor/, ' y="99999" text-anchor')), /does not fit/);
  // moved under the drawing, where a shape could cover it
  blocked(() => EP.inspectSVG(signed.replace(group, '').replace('\t<ellipse', group + '\t<ellipse')), /missing or altered/);
  // a state that happens to be labelled with the same words is not a signature
  blocked(() => EP.inspectSVG(drawing(600, 400, 0, 0, `\t<text x="10" y="20" font-family="Times New Roman" font-size="20">${SIGNATURE}</text>\n`)), /exactly one signature/);
});

test('only the image the export made can be downloaded or copied', () => {
  const signed = EP.svg(drawing(600, 400));
  assert.equal(EP.verify('svg', signed), true);
  blocked(() => EP.verify('svg', drawing(600, 400)), /did not come from the signed export/);
  blocked(() => EP.verify('svg', signed + ' '), /did not come from the signed export/);
  blocked(() => EP.verify('svg', ''), /did not come from the signed export/);
  blocked(() => EP.verify('png', signed), /did not come from the signed export/);
  blocked(() => EP.verify('pdf', signed), /unknown image format/);
  EP.svg(drawing(300, 200));
  blocked(() => EP.verify('svg', signed), /did not come from the signed export/);
});

test('a PNG export needs a canvas and is refused without one', () => {
  blocked(() => EP.png(null), /no canvas/);
  blocked(() => EP.png({ width: 100, height: 100 }), /no canvas/);
});

// a real one-pixel-high PNG, built by hand
function tinyPNG(width) {
  const chunk = (name, data) => {
    const body = Buffer.concat([Buffer.from(name, 'latin1'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(zlib.crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(1, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  const pixels = zlib.deflateSync(Buffer.alloc(1 + width * 4));
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', pixels), chunk('IEND', Buffer.alloc(0))]));
}

test('a PNG file carries the signature in its Copyright field', () => {
  const plain = tinyPNG(7);
  blocked(() => EP.inspectPNG(plain), /copyright field/);
  const stamped = EP.stampPNG(plain);
  assert.deepEqual({ ...EP.inspectPNG(stamped) }, { width: 7, height: 1 });
  assert.ok(Buffer.from(stamped).includes(Buffer.from('tEXtCopyright\0' + SIGNATURE, 'latin1')));
  assert.equal(Buffer.from(stamped.subarray(12, 16)).toString('latin1'), 'IHDR', 'the header chunk still comes first');

  // the field cannot be edited or cut out without the file failing the check
  const at = Buffer.from(stamped).indexOf('Nafees');
  const edited = Uint8Array.from(stamped);
  edited[at] = 'M'.charCodeAt(0);
  blocked(() => EP.inspectPNG(edited), /damaged/);
  blocked(() => EP.inspectPNG(stamped.subarray(0, stamped.length - 5)), /damaged/);
  blocked(() => EP.inspectPNG(EP.stampPNG(stamped)), /copyright field/);
  blocked(() => EP.inspectPNG(new Uint8Array([1, 2, 3])), /not a PNG/);
});

test('if the signing logic is taken out, exporting stops working', () => {
  // each of these is the module with one piece of the signature removed
  const withoutText = source.replace("'\" font-style=\"italic\" font-size=\"' + trim(place.fontSize) + '\" fill=\"#555555\">' + SIGNATURE + '</text>\\n' +", "'\" font-style=\"italic\" font-size=\"' + trim(place.fontSize) + '\" fill=\"#555555\"></text>\\n' +");
  const withoutGroup = source.replace('return text.slice(0, end).replace(tag, function() { return newTag; }) + signature + text.slice(end);', 'return text;');
  const otherName = source.replace("var SIGNATURE = 'Copyright Nafees Mansoor';", "var SIGNATURE = 'Copyright Someone Else';");
  for (const altered of [withoutText, withoutGroup, otherName]) assert.notEqual(altered, source, 'the test still matches the module');

  blocked(() => load(withoutText).svg(drawing(600, 400)), /missing or altered/);
  blocked(() => load(withoutGroup).svg(drawing(600, 400)), /exactly one signature/);
  assert.ok(!load(otherName).svg(drawing(600, 400)).includes(SIGNATURE));
  for (const altered of [withoutText, withoutGroup, otherName]) {
    const problems = checkExports((file) => (file === 'export-protection.js' ? altered : read(file)));
    assert.ok(problems.length > 0, 'the static check notices');
  }
});

test('every export route in the shipped code goes through the protection', () => {
  assert.deepEqual(checkExports(), []);
});

// the shipped files with one of them altered
const withChange = (file, from, to) => {
  const original = read(file);
  const altered = original.replace(from, to);
  assert.notEqual(altered, original, `the test still matches ${file}`);
  return checkExports((name) => (name === file ? altered : read(name)));
};
const mentions = (problems, pattern) => assert.ok(problems.some((p) => pattern.test(p)), 'expected a problem like ' + pattern + ' in ' + JSON.stringify(problems));

test('going around the protection is caught by the static check', () => {
  // the SVG writer used directly
  mentions(withChange('fsm.js', 'ExportProtection.svg(exporter.toSVG())', 'exporter.toSVG()'), /saveAsSVG in fsm\.js no longer calls/);
  // a second, unsigned SVG route
  mentions(withChange('workspace.js', 'function download() {', 'function rawSVG() { var e = new ExportAsSVG(); drawPlain(e); return e.toSVG(); }\n\tfunction download() {'), /\.toSVG\( is used 2 times/);
  // the PNG made straight from a canvas
  mentions(withChange('workspace.js', "return ExportProtection.png(layer, { 'scale': scale, 'background': BOARD_COLOR });", "return layer.toDataURL('image/png');"), /workspace\.js uses toDataURL/);
  mentions(withChange('simulator-ui.js', /$/, "\nfunction snapshot() { return canvas.toDataURL(); }\n"), /simulator-ui\.js uses toDataURL/);
  mentions(withChange('index.html', '</body>', '<script>canvas.toBlob(function(b) {});</script></body>'), /index\.html uses toBlob/);
  // the last check before a download or a copy taken out
  mentions(withChange('workspace.js', 'function download() {\n\t\tif(!verified()) return;', 'function download() {'), /download in workspace\.js no longer calls/);
  mentions(withChange('workspace.js', 'function copy() {\n\t\tif(!verified()) return;', 'function copy() {'), /copy in workspace\.js no longer calls/);
  mentions(withChange('workspace.js', 'return ExportProtection.verify(format, exported);', 'return true;'), /verified in workspace\.js no longer calls/);
  // the module not loaded, or loaded too late
  mentions(withChange('index.html', '  <script src="export-protection.js" defer></script>\n', ''), /does not load export-protection\.js/);
  mentions(withChange('index.html', /  <script src="export-protection\.js" defer><\/script>\n([\s\S]*<script src="workspace\.js" defer><\/script>\n)/, '$1  <script src="export-protection.js" defer></script>\n'), /after fsm\.js/);
});

test('changing protected code without updating the integrity manifest is caught', () => {
  mentions(withChange('export-protection.js', 'var MIN_FONT = 6;', 'var MIN_FONT = 0;'), /Protected code changed: export-protection\.js/);
  mentions(withChange('export-protection.js', "c.fillText(SIGNATURE, image.width - padding, image.height - padding);", ''), /no longer contains c\.fillText/);
  mentions(withChange('workspace.js', "el.download.disabled = el.copy.disabled = true;", ''), /Protected code changed: blockExport in workspace\.js/);
  mentions(withChange('fsm.js', 'function drawPlain(c) {', 'function drawPlain(c) {\n\treturn;'), /Protected code changed: drawPlain in fsm\.js/);
  mentions(withChange('fsm.js', /function saveAsSVG\(\) \{[\s\S]*?\n\}\n/, ''), /Protected code is gone: saveAsSVG in fsm\.js/);
  mentions(withChange('tests/export-integrity.json', /\s*\{\s*"file": "workspace\.js",\s*"function": "download",[\s\S]*?\},/, ''), /does not list download in workspace\.js/);
  mentions(withChange('tests/export-integrity.json', '"signature": "Copyright Nafees Mansoor"', '"signature": "Copyright Someone Else"'), /expects "Copyright Someone Else"/);
  // an edit outside the protected functions is not anyone's business here
  assert.deepEqual(withChange('workspace.js', "var BOARD_COLOR = '#090f24';", "var BOARD_COLOR = '#0a1026';"), []);
});

test('the check reads whole functions', () => {
  const sample = "function a() { var s = '}'; /* } */ if(s) { return \"{\"; } // }\n}\nfunction b() {}";
  assert.equal(functionSource(sample, 'a'), sample.slice(0, sample.indexOf('\nfunction b')));
  assert.equal(functionSource(sample, 'b'), 'function b() {}');
  assert.equal(functionSource(sample, 'c'), null);
});
