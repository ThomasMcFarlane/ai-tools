import { createServer, type Server } from 'node:http';

export function serveHtml(
  html: string,
  port: number,
  host = '127.0.0.1',
): Promise<{ server: Server; url: string }> {
  const server = createServer((request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405).end();
      return;
    }
    if ((request.url ?? '/').split('?')[0] !== '/') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
    });
    response.end(request.method === 'HEAD' ? undefined : html);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      const actual = typeof address === 'object' && address !== null ? address.port : port;
      resolve({ server, url: `http://${host}:${actual}/` });
    });
  });
}
