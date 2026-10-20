const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');

const monacoRoot = path.resolve(__dirname, '..', 'node_modules', 'monaco-editor', 'min', 'vs');
const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.ttf': 'font/ttf' };
const outputRoot = path.join(__dirname, 'generated');
const bundle = buildSync({
  entryPoints: {
    'fixture-runtime': path.join(__dirname, 'fixture-runtime.js'),
    'editor.worker': path.join(__dirname, '..', 'node_modules', 'monaco-editor', 'esm', 'vs', 'editor', 'editor.worker.js'),
  },
  bundle: true,
  format: 'iife',
  platform: 'browser',
  loader: { '.ttf': 'file' },
  assetNames: 'fixture-assets/[name]-[hash]',
  outdir: outputRoot,
  write: false,
});
const assets = new Map(bundle.outputFiles.map(file => [
  '/' + path.relative(outputRoot, file.path).split(path.sep).join('/'),
  file.contents,
]));

http.createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  const pathname = url.pathname;
  if (assets.has(pathname)) {
    response.writeHead(200, { 'Content-Type': types[path.extname(pathname)] || 'application/octet-stream' });
    response.end(assets.get(pathname));
    return;
  }
  if (pathname === '/request-headers') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ userAgent: request.headers['user-agent'] }));
    return;
  }
  if (pathname === '/agents' && url.searchParams.get('desktopViewport') === '980') {
    fs.readFile(path.join(__dirname, 'fixture.html'), 'utf8', (error, html) => {
      if (error) {
        console.error(error);
        response.writeHead(500).end();
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end(html.replace(/(<meta name="viewport" content=")[^"]+/, '$1width=980'));
    });
    return;
  }
  let filename;
  if (pathname === '/agents') filename = path.join(__dirname, 'fixture.html');
  else if (pathname.startsWith('/vs/')) {
    filename = path.resolve(monacoRoot, ...pathname.slice(4).split('/'));
    if (!filename.startsWith(monacoRoot + path.sep)) filename = undefined;
  }
  if (!filename) {
    response.writeHead(404).end();
    return;
  }
  const stream = fs.createReadStream(filename);
  stream.on('error', error => {
    if (error.code !== 'ENOENT') console.error(error);
    if (!response.headersSent) response.writeHead(error.code === 'ENOENT' ? 404 : 500);
    response.end();
  });
  stream.on('open', () => {
    response.writeHead(200, { 'Content-Type': types[path.extname(filename)] || 'application/octet-stream' });
    stream.pipe(response);
  });
}).listen(31137, '127.0.0.1');
