const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const monacoRoot = path.resolve(__dirname, '..', 'node_modules', 'monaco-editor', 'min', 'vs');
const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.ttf': 'font/ttf' };

http.createServer((request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
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
