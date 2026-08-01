import fs from 'fs';

const filePath = 'karpathy-wiki/api/src/utils/runtime.ts';
let content = fs.readFileSync(filePath, 'utf8');

const oldLine = "export const IS_SEA = cjsFilename ? !fs.existsSync(cjsFilename) : false;";
const newBlock = `export const IS_SEA = (() => {
  if (cjsFilename === undefined) return false;
  return cjsFilename !== process.execPath;
})();`;

content = content.replace(oldLine, newBlock);
fs.writeFileSync(filePath, content, 'utf8');
console.log('修改成功');
