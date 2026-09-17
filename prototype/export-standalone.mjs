import {readFile,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const here=dirname(fileURLToPath(import.meta.url));
const build=resolve(here,'../outputs/checkin-prototype');
if(!process.argv[2])throw Error('Specify output HTML path. Run build:prototype first.');
let html=await readFile(resolve(build,'index.html'),'utf8');
// Vite emits an empty external script; HTML tag names are case-insensitive and
// browsers also tolerate whitespace, attributes and a slash in closing tags.
const script=html.match(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>\s*<\/script(?:[\s/][^>]*)?>/i);
const css=html.match(/<link\b[^>]*href="([^\"]+\.css)"[^>]*>/);
if(!script||!css)throw Error('Expected one compiled JS and CSS asset.');
// HTML parses raw script text before JavaScript, including mixed-case endings.
// Escape the slash without changing the case/value of JavaScript string data.
const js=(await readFile(resolve(build,script[1]),'utf8')).replace(/<\/script/gi,match=>'<\\/'+match.slice(2));
const style=await readFile(resolve(build,css[1]),'utf8');
html=html.replace(script[0],()=>`<script type="module">${js}</script>`).replace(css[0],()=>`<style>${style}</style>`);
await writeFile(resolve(process.argv[2]),html);
console.log('Standalone prototype exported.');
