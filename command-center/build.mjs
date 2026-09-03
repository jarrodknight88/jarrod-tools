// Assembles dist/ from src/ and static/. The page is a Claude Design export running on its
// bundled dc-runtime (support.js): template.html is the markup, logic.js is the component.
import { readFileSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';


const template = readFileSync('src/template.html', 'utf8');
const logic = readFileSync('src/logic.js', 'utf8').replace(/<\/script/gi, '<\\/script');

const page = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Command Center</title>
<link rel="icon" href="data:,">
<script src="./support.js"></script>
</head>
<body>
<x-dc>
${template}
</x-dc>
<script type="text/x-dc" data-dc-script>
${logic}
</script>
</body>
</html>
`;

mkdirSync('dist', { recursive: true });
writeFileSync('dist/index.html', page);
cpSync('static', 'dist', { recursive: true });
console.log('built dist/index.html (' + page.length + ' bytes)');
