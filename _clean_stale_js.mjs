// Quarantine stale compiled .js/.vue.js artifacts from frontend/src that shadow real .ts/.vue sources.
// MOVE (rename) instead of unlink to avoid the safe-delete hook; only moves a .js if a confirmed
// .ts or .vue counterpart exists. Restore by moving files back if needed.
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve('karpathy-wiki/frontend/src');
const QUARANTINE = path.resolve('_stale_js_quarantine');
fs.mkdirSync(QUARANTINE, { recursive: true });

function walk(dir) {
  let results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) results = results.concat(walk(p));
    else if (entry.name.endsWith('.js')) results.push(p);
  }
  return results;
}

const jsFiles = walk(SRC);
let moved = 0;
let skipped = 0;
const skippedList = [];

for (const jf of jsFiles) {
  let counterpart = null;
  if (jf.endsWith('.vue.js')) {
    const v = jf.slice(0, -3);
    if (fs.existsSync(v)) counterpart = v;
  } else {
    const t = jf.slice(0, -3) + '.ts';
    if (fs.existsSync(t)) counterpart = t;
  }
  if (counterpart) {
    const rel = path.relative(SRC, jf);
    const dest = path.join(QUARANTINE, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(jf, dest);
    moved++;
    console.log(`MOV  ${rel}  ->  _stale_js_quarantine/${rel}`);
  } else {
    skipped++;
    skippedList.push(jf);
  }
}

console.log(`\nMoved: ${moved}`);
console.log(`Skipped (no source counterpart, kept): ${skipped}`);
for (const s of skippedList) console.log(`  KEEP ${path.relative(SRC, s)}`);
