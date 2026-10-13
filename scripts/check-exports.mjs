// Static check of the export pipeline. Run with `npm run check:exports`; CI runs it too.
//
// It fails when a PNG or SVG could leave the app without going through
// export-protection.js, and when a protected function no longer matches the hash
// recorded in tests/export-integrity.json. After changing a protected function on
// purpose, review the export tests and run `npm run check:exports -- --update`.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = 'tests/export-integrity.json';
const MODULE = 'export-protection.js';
// ways a browser turns a canvas or a document into an image file
const SINKS = ['toDataURL', 'toBlob', 'convertToBlob', 'XMLSerializer', 'transferToImageBitmap'];
// the call each export route has to make, inside the named function
const ROUTES = [
  { file: 'fsm.js', function: 'saveAsSVG', needs: 'ExportProtection.svg(exporter.toSVG())' },
  { file: 'workspace.js', function: 'renderPNG', needs: 'return ExportProtection.png(' },
  { file: 'workspace.js', function: 'verified', needs: 'ExportProtection.verify(format, exported)' },
  { file: 'workspace.js', function: 'download', needs: 'if(!verified()) return;' },
  { file: 'workspace.js', function: 'copy', needs: 'if(!verified()) return;' },
];

const sha256 = (text) => createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');

// the source of `function name(...) { ... }`, or null; skips braces inside strings and comments
export function functionSource(source, name) {
  const start = source.search(new RegExp('\\bfunction ' + name + '\\s*\\('));
  if (start < 0) return null;
  let depth = 0;
  for (let i = source.indexOf('{', start); i >= 0 && i < source.length; i++) {
    const c = source[i];
    if (c === '/' && source[i + 1] === '/') i = source.indexOf('\n', i);
    else if (c === '/' && source[i + 1] === '*') i = source.indexOf('*/', i) + 1;
    else if (c === "'" || c === '"' || c === '`') {
      for (i++; source[i] !== c; i++) if (source[i] === '\\') i++;
    } else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return source.slice(start, i + 1);
    if (i < 0) break;
  }
  return null;
}

const withoutComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function hashOf(entry, read) {
  const source = read(entry.file);
  const part = entry.function ? functionSource(source, entry.function) : source;
  return part == null ? null : sha256(part);
}

// returns a list of problems; empty when every export is protected.
// `read` maps a path inside the project to its text, so tests can hand in altered files.
export function checkExports(read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8'), scripts = null) {
  const problems = [];
  const html = read('index.html');
  const loaded = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
  scripts = scripts || loaded.filter((src) => !/^[a-z]+:|^\/\//.test(src));

  // the module is on the page, ahead of everything that exports
  if (!loaded.includes(MODULE)) problems.push(`index.html does not load ${MODULE}.`);
  for (const file of ['fsm.js', 'workspace.js']) {
    if (loaded.indexOf(MODULE) > loaded.indexOf(file)) problems.push(`index.html loads ${MODULE} after ${file}.`);
  }

  // nothing but the module turns a canvas or a document into an image
  const inline = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
  for (const [file, source] of [['index.html', inline], ...scripts.filter((f) => f !== MODULE).map((f) => [f, read(f)])]) {
    const code = withoutComments(source);
    for (const sink of SINKS) {
      if (code.includes(sink)) problems.push(`${file} uses ${sink}: images may only be made in ${MODULE}.`);
    }
    if (file !== 'workspace.js' && /image\/(png|svg\+xml)/.test(code)) problems.push(`${file} names an image type: images may only be made in ${MODULE}.`);
  }

  // the SVG writer is used once, by the protected function
  const all = scripts.map((f) => withoutComments(read(f))).join('\n');
  for (const [what, pattern] of [['new ExportAsSVG', /new ExportAsSVG\b/g], ['.toSVG(', /\.toSVG\(/g], ['renderPNG(', /(?<!function )\brenderPNG\(/g], ['saveAsSVG(', /(?<!function )\bsaveAsSVG\(/g]]) {
    const uses = (all.match(pattern) || []).length;
    if (uses !== 1) problems.push(`${what} is used ${uses} times; it must be used exactly once, in the protected export.`);
  }

  for (const route of ROUTES) {
    const body = functionSource(read(route.file), route.function);
    if (body == null) problems.push(`${route.file} has no function ${route.function}.`);
    else if (!withoutComments(body).includes(route.needs)) problems.push(`${route.function} in ${route.file} no longer calls ${route.needs}`);
  }

  // the module still signs: run it as shipped on a small drawing
  let signature = null;
  try {
    const api = vm.runInNewContext(read(MODULE) + '\n;ExportProtection', { atob, btoa });
    signature = api.SIGNATURE;
    const signed = api.svg('<svg width="300" height="200" viewBox="0 0 300 200" version="1.1" xmlns="http://www.w3.org/2000/svg">\n</svg>\n');
    if (!signed.includes('>' + signature + '</text>')) problems.push(`${MODULE} does not write the signature into an SVG.`);
    api.verify('svg', signed);
  } catch (error) {
    problems.push(`${MODULE} cannot sign an SVG: ${error.message}`);
  }
  for (const needed of ['c.fillText(SIGNATURE,', "refuse('the signature could not be drawn.')", 'stampPNG(bytesOfDataURL(image.toDataURL(', 'inspectPNG(bytes)']) {
    if (!withoutComments(read(MODULE)).includes(needed)) problems.push(`${MODULE} no longer contains ${needed}`);
  }

  // protected code matches what the tests were last reviewed against
  let manifest = null;
  try {
    manifest = JSON.parse(read(MANIFEST));
  } catch (error) {
    problems.push(`${MANIFEST} is missing or unreadable.`);
  }
  if (manifest) {
    if (manifest.signature !== signature) problems.push(`The signature is "${signature}" but ${MANIFEST} expects "${manifest.signature}".`);
    const listed = new Set(manifest.protected.map((e) => e.file + ':' + (e.function || '')));
    for (const route of ROUTES) {
      if (!listed.has(route.file + ':' + route.function)) problems.push(`${MANIFEST} does not list ${route.function} in ${route.file}.`);
    }
    if (!listed.has(MODULE + ':')) problems.push(`${MANIFEST} does not list ${MODULE}.`);
    for (const entry of manifest.protected) {
      const name = entry.function ? `${entry.function} in ${entry.file}` : entry.file;
      const hash = hashOf(entry, read);
      if (hash == null) problems.push(`Protected code is gone: ${name}.`);
      else if (hash !== entry.sha256) problems.push(`Protected code changed: ${name}. Review the export tests, then run "npm run check:exports -- --update".`);
    }
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--update')) {
    const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
    const manifest = JSON.parse(read(MANIFEST));
    for (const entry of manifest.protected) entry.sha256 = hashOf(entry, read);
    fs.writeFileSync(path.join(ROOT, MANIFEST), JSON.stringify(manifest, null, 2) + '\n');
    console.log(`Updated ${MANIFEST}.`);
  }
  const problems = checkExports();
  for (const problem of problems) console.error('✗ ' + problem);
  if (problems.length > 0) process.exit(1);
  console.log('Export protection is intact: every PNG and SVG export is signed.');
}
