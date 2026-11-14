// Assembles dist/ from src/ and static/.
//   index.html    the dashboard (src/app.html with app.css and app.js inlined)
//   classic.html  the previous dashboard, kept as a fallback. It is a Claude Design export running on
//                 its bundled dc-runtime (support.js): template.html is the markup, logic.js the component.
import { readFileSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';

const read = f => readFileSync(f, 'utf8');
const inline = s => s.replace(/<\/script/gi, '<\\/script');

const app = read('src/app.html').replace('/*__CSS__*/', () => read('src/app.css')).replace('/*__JS__*/', () => inline(read('src/app.js')));

const classic = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Command Center (classic)</title>
<link rel="icon" href="data:,">
<script src="./support.js"></script>
</head>
<body>
<x-dc>
${read('src/template.html')}
</x-dc>
<script type="text/x-dc" data-dc-script>
${inline(read('src/logic.js'))}
</script>
</body>
</html>
`;

mkdirSync('dist', { recursive: true });
writeFileSync('dist/index.html', app);
writeFileSync('dist/classic.html', classic);
cpSync('static', 'dist', { recursive: true });
console.log(`built dist/index.html (${app.length} bytes) and dist/classic.html (${classic.length} bytes)`);
