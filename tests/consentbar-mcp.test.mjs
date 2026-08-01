import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createMcpServer } from '../bin/consentbar-mcp.js';

async function spawnServer() {
  const server = createMcpServer({ host: '127.0.0.1' });
  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });

    server.once('error', reject);
  });

  const address = server.address();
  if (!address || typeof address !== 'object') {
    throw new Error('Server did not expose a socket address');
  }

  return { server, port: address.port };
}

async function stopServer(server) {
  if (!server.listening) {
    return;
  }

  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function request(port, method, body) {
  return new Promise((resolve, reject) => {
    const requestOptions = {
      hostname: '127.0.0.1',
      port,
      path: '/mcp',
      method,
      headers: {
        'Content-Type': 'application/json'
      }
    };

    if (body) {
      requestOptions.headers['Content-Length'] = Buffer.byteLength(body);
    }

    const req = http.request(requestOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        if (!data.length) {
          resolve({
            status: res.statusCode || 0,
            payload: null
          });
          return;
        }

        try {
          resolve({
            status: res.statusCode || 0,
            payload: JSON.parse(data)
          });
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(body);
    }

    req.end();
  });
}

function rpc(port, payload) {
  return request(port, 'POST', JSON.stringify(payload));
}

test('MCP initialize, tools/list, and tools/call are real and read-only', async () => {
  const { server, port } = await spawnServer();

  try {
    const init = await rpc(port, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18'
      }
    });
    assert.equal(init.status, 200);
    assert.equal(init.payload.result.protocolVersion, '2025-06-18');
    assert.equal(init.payload.result.capabilities.tools.listChanged, false);

    const list = await rpc(port, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list'
    });
    assert.equal(list.status, 200);
    const names = list.payload.result.tools.map((tool) => tool.name).sort();
    assert.ok(names.includes('validate_config'));
    assert.ok(names.includes('audit_html'));
    assert.ok(names.includes('get_default_config'));
    assert.ok(names.includes('get_standards'));

    const validated = await rpc(port, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'validate_config',
        arguments: {
          config: {
            version: '1',
            policyVersion: '1',
            policyUrl: '/privacy',
            categories: ['essential', 'statistics', 'marketing', 'preferences'],
            defaultConsent: {
              essential: true,
              statistics: false,
              marketing: false,
              preferences: false
            },
            storage: {
              key: 'agent-consent-state',
              version: '1',
              expiryDays: 365
            }
          }
        }
      }
    });
    assert.equal(validated.status, 200);
    assert.equal(validated.payload.result.isError, false);

    const audited = await rpc(port, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'audit_html',
        arguments: {
          html: '<html><body><script data-consent-category="statistics" data-consent-src="https://www.googletagmanager.com/gtag/js?id=G-1"></script></body></html>'
        }
      }
    });
    assert.equal(audited.status, 200);
    assert.equal(audited.payload.result.content[0].type, 'text');

    const unknown = await rpc(port, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'contact_request'
      }
    });
    assert.equal(unknown.status, 200);
    assert.equal(unknown.payload.error.code, -32601);
  } finally {
    await stopServer(server);
  }
});

test('MCP GET and notification behavior are explicit and protocol-safe', async () => {
  const { server, port } = await spawnServer();

  try {
    const get = await request(port, 'GET');
    assert.equal(get.status, 405);

    const notify = await request(
      port,
      'POST',
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18'
        }
      })
    );
    assert.equal(notify.status, 202);

    const batch = await request(
      port,
      'POST',
      JSON.stringify([
        { jsonrpc: '2.0', id: 1, method: 'tools/list' }
      ])
    );
    assert.equal(batch.status, 400);
    assert.equal(batch.payload.error.code, -32600);
  } finally {
    await stopServer(server);
  }
});

test('Server accepts OPTIONS preflight and rejects missing-method requests', async () => {
  const { server, port } = await spawnServer();

  try {
    const options = await request(port, 'OPTIONS');
    assert.equal(options.status, 204);

    const invalid = await request(port, 'POST', JSON.stringify({ jsonrpc: '2.0', id: 1 }));
    assert.equal(invalid.status, 200);
    assert.equal(invalid.payload.error.code, -32600);
  } finally {
    await stopServer(server);
  }
});

test('MCP rejects oversized requests and audit payloads', async () => {
  const { server, port } = await spawnServer();

  try {
    const oversizedRequest = await request(port, 'POST', 'x'.repeat((1024 * 1024) + 1));
    assert.equal(oversizedRequest.status, 413);

    const oversizedAudit = await rpc(port, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: {
        name: 'audit_html',
        arguments: { html: 'x'.repeat((512 * 1024) + 1) }
      }
    });
    assert.equal(oversizedAudit.status, 200);
    assert.equal(oversizedAudit.payload.error.code, -32602);
  } finally {
    await stopServer(server);
  }
});
