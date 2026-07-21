import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
};

export interface StaticServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

/** Serve a directory over HTTP on an ephemeral port. Used for the demo site
 *  and for handing the player to the renderer. */
export async function serveDir(root: string, port = 0): Promise<StaticServer> {
  const server = http.createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
      let filePath = path.join(root, urlPath);
      if (existsSync(filePath) && statSync(filePath).isDirectory()) {
        filePath = path.join(filePath, 'index.html');
      }
      if (!filePath.startsWith(root) || !existsSync(filePath)) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('Not found');
        return;
      }
      const body = await readFile(filePath);
      res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] || 'application/octet-stream' });
      res.end(body);
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('Error: ' + (err as Error).message);
    }
  });

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  return {
    url: `http://127.0.0.1:${actualPort}`,
    port: actualPort,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
