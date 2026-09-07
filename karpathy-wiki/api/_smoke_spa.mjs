import { resolveSpaRoot } from './src/spa-resolver.ts';
const root = await resolveSpaRoot(process.cwd());
console.log('spaRoot:', root);
