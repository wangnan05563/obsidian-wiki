const fs = require('fs');
console.log('process.execPath:', process.execPath);
console.log('__filename:', typeof __filename !== 'undefined' ? __filename : 'undefined');
console.log('process.argv[0]:', process.argv[0]);
console.log('cwd:', process.cwd());
if (typeof __filename !== 'undefined') {
  console.log('__filename existsSync:', fs.existsSync(__filename));
}
