const fs = require('fs');
const path = require('path');
const url = require('url');

console.log('=== SEA Debug ===');
console.log('typeof __filename:', typeof __filename);
console.log('__filename:', typeof __filename !== 'undefined' ? __filename : 'undefined');
console.log('process.execPath:', process.execPath);
console.log('process.argv[0]:', process.argv[0]);
console.log('cwd:', process.cwd());

// Check what __import_meta_url resolves to
const cjsFilename = typeof __filename !== 'undefined' ? __filename : undefined;
const IS_SEA = cjsFilename ? !fs.existsSync(cjsFilename) : false;
console.log('IS_SEA (our logic):', IS_SEA);
console.log('cjsFilename existsSync:', cjsFilename ? fs.existsSync(cjsFilename) : 'N/A');

// Check what the banner's logic would produce
const __import_meta_url = require('url').pathToFileURL(require('fs').existsSync(__filename) ? __filename : process.execPath).href;
console.log('__import_meta_url:', __import_meta_url);
const SRC_DIR = path.dirname(url.fileURLToPath(__import_meta_url));
console.log('SRC_DIR:', SRC_DIR);
console.log('SRC_DIR/prompts exists:', fs.existsSync(path.join(SRC_DIR, 'prompts')));
console.log('SRC_DIR/src/prompts exists:', fs.existsSync(path.join(SRC_DIR, 'src', 'prompts')));
