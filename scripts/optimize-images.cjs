const fs = require('node:fs');
const path = require('node:path');
const file = path.join(__dirname, '..', 'index.html');
let n = 0;
let html = fs.readFileSync(file, 'utf8').replace(/<img\b[^>]*>/g, tag => {
  n++;
  if (n <= 2) return tag;
  return tag.replace('loading="eager"', 'loading="lazy" fetchpriority="low"');
});
html = html.replace(/player-v2\.js(?:\?v=[^"']+)?/, 'player-v2.js?v=20261010.3');
if (!html.includes('name="zaki-build"')) html = html.replace('<head>', '<head><meta name="zaki-build" content="20261010-original-stream-v3">');
else html = html.replace(/name="zaki-build" content="[^"]+"/, 'name="zaki-build" content="20261010-original-stream-v3"');
fs.writeFileSync(file, html);
console.log(JSON.stringify({images:n,lazy:Math.max(0,n-2),bytes:Buffer.byteLength(html)}));
