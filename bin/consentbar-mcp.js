#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mcpHandle, resolveProtocolVersion } from '../src/mcp.js';

const DEFAULT_PORT = 8787;
const DEFAULT_HOST = '127.0.0.1';
const MAX_REQUEST_BYTES = 1024 * 1024;

export function createMcpServer({ host = DEFAULT_HOST } = {}) {
  return createServer(async (req, res) => {
    const pathname = new URL(req.url || '/', `http://${host}`).pathname;
    if (pathname !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Not Found' }));
      return;
    }

    if (req.method === 'OPTIONS') {
      cors(res, {
        'Allow': 'POST, OPTIONS'
      });
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method !== 'POST') {
      cors(res, {
        'Allow': 'POST, OPTIONS'
      });
      res.writeHead(405, {
        'Content-Type': 'application/json; charset=utf-8'
      });
      res.end(JSON.stringify({ error: 'Method Not Allowed' }));
      return;
    }

    const declaredLength = Number.parseInt(req.headers['content-length'] || '0', 10);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
      cors(res);
      res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Request body must be 1 MiB or smaller.' }
      }));
      return;
    }

    let body = '';
    let bodyBytes = 0;
    let rejected = false;
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      if (rejected) return;
      bodyBytes += Buffer.byteLength(chunk, 'utf8');
      if (bodyBytes > MAX_REQUEST_BYTES) {
        rejected = true;
        cors(res);
        res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32600, message: 'Request body must be 1 MiB or smaller.' }
        }));
        return;
      }
      body += chunk;
    });

    req.on('end', async () => {
      if (rejected) return;
      let payload;
      try {
        payload = body ? JSON.parse(body) : {};
      } catch (_error) {
        cors(res);
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: {
              code: -32700,
              message: 'Parse error. Body must be valid JSON.'
            }
          })
        );
        return;
      }

      if (Array.isArray(payload)) {
        cors(res);
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: {
              code: -32600,
              message: 'Batching is not supported. Send one message only.'
            }
          })
        );
        return;
      }

      const normalized = payload;
      if (normalized && normalized.method === 'initialize') {
        const requested = normalized.params?.protocolVersion;
        normalized.params = {
          ...normalized.params,
          protocolVersion: resolveProtocolVersion(requested)
        };
      }

      const response = await mcpHandle(normalized);
      if (!response) {
        cors(res);
        res.writeHead(202);
        res.end();
        return;
      }

      const bodyOut = JSON.stringify(response);
      cors(res);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(bodyOut);
    });

    req.on('error', () => {
      cors(res);
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32603,
            message: 'Request failure.'
          }
        })
      );
    });
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const options = parseArgs({
    args: argv,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      port: { type: 'string' },
      host: { type: 'string' }
    },
    allowPositionals: true
  });

  if (options.values.help) {
    printHelp();
    return;
  }

  if (options.values.version) {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'));
    console.log(pkg.version);
    return;
  }

  const port = coercePort(options.values.port, DEFAULT_PORT);
  const host = typeof options.values.host === 'string' && options.values.host.length > 0 ? options.values.host : DEFAULT_HOST;

  const server = createMcpServer({ host });
  server.listen(port, host, () => {
    console.log(`consentbar MCP server listening on http://${host}:${port}/mcp`);
  });
}

function coercePort(raw, fallback) {
  const parsed = Number.parseInt(raw ?? `${fallback}`, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
    return fallback;
  }

  return parsed;
}

function cors(res, extra = {}) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Mcp-Protocol-Version, Mcp-Session-Id');
  for (const [key, value] of Object.entries(extra)) {
    res.setHeader(key, value);
  }
}

function printHelp() {
  console.log('Usage: consentbar-mcp --port <port> --host <host>');
  console.log('Starts an MCP JSON-RPC endpoint at /mcp for initialize/list/call.');
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
