'use strict';

/**
 * Font pipeline.
 *
 * Reads the source fonts from ./font, decodes the sfnt `name` and `OS/2` tables to
 * learn each file's real family, weight and slope, copies the files into the
 * renderer and writes renderer/fonts.css with the @font-face rules.
 *
 * Reading the tables rather than trusting filenames matters: Google's builds often
 * register each weight as its own family ("Google Sans Medium"), which would leave
 * `font-weight: 500` unmatched if the CSS were written by hand.
 *
 * Run with: npm run fonts
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'font');
const OUT_DIR = path.join(ROOT, 'renderer', 'fonts');
const CSS_FILE = path.join(ROOT, 'renderer', 'fonts.css');

const EXTENSIONS = new Set(['.ttf', '.otf', '.woff', '.woff2']);
const FORMAT_BY_EXT = { '.ttf': 'truetype', '.otf': 'opentype', '.woff': 'woff', '.woff2': 'woff2' };

const NAMES_OF_INTEREST = {
  1: 'family',
  2: 'subfamily',
  4: 'fullName',
  6: 'postscript',
  16: 'typographicFamily',
  17: 'typographicSubfamily'
};

function readNameTable(buf, tableOffset) {
  const format = buf.readUInt16BE(tableOffset);
  const count = buf.readUInt16BE(tableOffset + 2);
  const stringOffset = buf.readUInt16BE(tableOffset + 4);
  const storage = tableOffset + stringOffset;
  const out = {};

  // Format 1 has a language-tag array after the name records; the records
  // themselves are identical between formats 0 and 1.
  for (let i = 0; i < count; i++) {
    const rec = tableOffset + 6 + i * 12;
    const platformID = buf.readUInt16BE(rec);
    const encodingID = buf.readUInt16BE(rec + 2);
    const languageID = buf.readUInt16BE(rec + 4);
    const nameID = buf.readUInt16BE(rec + 6);
    const length = buf.readUInt16BE(rec + 8);
    const offset = buf.readUInt16BE(rec + 10);
    if (!NAMES_OF_INTEREST[nameID]) continue;

    const start = storage + offset;
    if (start + length > buf.length) continue;

    let value;
    if (platformID === 3 || (platformID === 0 && encodingID >= 3)) {
      // UTF-16BE
      let s = '';
      for (let p = start; p < start + length; p += 2) {
        s += String.fromCharCode(buf.readUInt16BE(p));
      }
      value = s;
    } else {
      value = buf.toString('latin1', start, start + length);
    }
    value = value.replace(/\0/g, '').trim();
    if (!value) continue;

    const key = NAMES_OF_INTEREST[nameID];
    const score = (platformID === 3 ? 100 : 0) + (languageID === 0x409 ? 50 : 0) + (languageID === 0 ? 30 : 0);
    if (!out[key] || score > out[key].score) out[key] = { value, score };
  }

  const flat = {};
  for (const [k, v] of Object.entries(out)) flat[k] = v.value;
  return flat;
}

function readOs2(buf, tableOffset, tableLength) {
  if (tableLength < 64) return null;
  const weightClass = buf.readUInt16BE(tableOffset + 4);
  const fsSelection = buf.readUInt16BE(tableOffset + 62);
  return {
    weightClass,
    italic: (fsSelection & 0x01) !== 0,
    bold: (fsSelection & 0x20) !== 0,
    // fsSelection bit 8 = WWS; bit 7 = USE_TYPO_METRICS
    oblique: (fsSelection & 0x200) !== 0
  };
}

function readHeadFlags(buf, tableOffset) {
  if (tableOffset == null) return null;
  const macStyle = buf.readUInt16BE(tableOffset + 44);
  return { italic: (macStyle & 0x02) !== 0, bold: (macStyle & 0x01) !== 0 };
}

function parseFont(file) {
  const buf = fs.readFileSync(file);
  const sfnt = buf.readUInt32BE(0);
  const kind = sfnt === 0x4f54544f ? 'CFF/OTF' : sfnt === 0x00010000 ? 'TrueType' : sfnt === 0x74727565 ? 'TrueType (Apple)' : 'unknown';
  const numTables = buf.readUInt16BE(4);

  const tables = {};
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    const tag = buf.toString('latin1', rec, rec + 4);
    tables[tag] = { offset: buf.readUInt32BE(rec + 8), length: buf.readUInt32BE(rec + 12) };
  }

  const names = tables.name ? readNameTable(buf, tables.name.offset) : {};
  const os2 = tables['OS/2'] ? readOs2(buf, tables['OS/2'].offset, tables['OS/2'].length) : null;
  const head = readHeadFlags(buf, tables.head ? tables.head.offset : null);

  const italic = (os2 && os2.italic) || (head && head.italic) || false;
  const weight = os2 ? os2.weightClass : head && head.bold ? 700 : 400;

  return {
    file: path.basename(file),
    ext: path.extname(file).toLowerCase(),
    kind,
    names,
    weight,
    italic,
    family: names.typographicFamily || names.family || path.basename(file, path.extname(file)),
    subfamily: names.typographicSubfamily || names.subfamily || ''
  };
}

/** Collapse per-weight families ("Google Sans Medium") onto the base family. */
function baseFamily(family) {
  return family
    .replace(/\s+(Thin|ExtraLight|UltraLight|Light|Regular|Book|Normal|Medium|SemiBold|DemiBold|Demi|Bold|ExtraBold|UltraBold|Black|Heavy)(\s+Italic)?$/i, '')
    .trim();
}

function main() {
  if (!fs.existsSync(SRC_DIR)) {
    console.error(`No font folder at ${SRC_DIR}`);
    process.exit(1);
  }

  const files = fs
    .readdirSync(SRC_DIR)
    .filter((f) => EXTENSIONS.has(path.extname(f).toLowerCase()))
    .map((f) => path.join(SRC_DIR, f))
    .sort();

  if (!files.length) {
    console.error('No font files found in ' + SRC_DIR);
    process.exit(1);
  }

  const fonts = files.map(parseFont);

  console.log('Source fonts');
  console.log('============');
  for (const f of fonts) {
    console.log(
      `  ${f.file.padEnd(30)} ${f.kind.padEnd(14)} family="${f.family}" sub="${f.subfamily}" weight=${f.weight} italic=${f.italic}`
    );
  }

  const declared = baseFamily(fonts[0].family);
  const strays = [...new Set(fonts.map((f) => baseFamily(f.family)))].filter((n) => n !== declared);
  if (strays.length) {
    console.warn(`\n  Warning: more than one base family found: ${[declared, ...strays].join(', ')}`);
  }

  // Copy the files next to the renderer so they ship inside the package.
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const f of fonts) {
    fs.copyFileSync(path.join(SRC_DIR, f.file), path.join(OUT_DIR, f.file));
  }

  const face = (f) => `@font-face {
  font-family: '${declared}';
  font-style: ${f.italic ? 'italic' : 'normal'};
  font-weight: ${f.weight};
  font-display: block;
  src: url('fonts/${f.file}') format('${FORMAT_BY_EXT[f.ext]}');
}`;

  const css = `/* Generated by tools/make-font-css.js - do not edit by hand.
   Source: font/  (${fonts.length} files, family "${declared}")
   Run "npm run fonts" after changing the source fonts.

   The theme in styles.css points --font at "${declared}" with no fallback list,
   so this family is the only one the app can ever render in. */

${fonts.map(face).join('\n\n')}
`;

  fs.writeFileSync(CSS_FILE, css, 'utf8');

  console.log(`\nDeclared family: "${declared}" (${fonts.length} faces)`);
  console.log('Copied to: renderer/fonts/');
  console.log('Wrote:     renderer/fonts.css');
  console.log('\nWeights available: ' + [...new Set(fonts.map((f) => f.weight))].sort((a, b) => a - b).join(', '));
}

main();
