import { canonicalCategories, defaultConfigValues, normalizeConfig } from './policy.js';
import { validateConfig } from './validate.js';
import { auditHtmlContent, auditHtmlVariants } from './audit.js';

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MCP_PROTOCOL_VERSION = '2025-06-18';
export const MAX_AUDIT_HTML_BYTES = 512 * 1024;

export function supportedProtocolVersions() {
  return [...SUPPORTED_PROTOCOL_VERSIONS];
}

export function resolveProtocolVersion(requested) {
  if (!requested) {
    return MCP_PROTOCOL_VERSION;
  }

  return SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSION;
}

export function defaultTools() {
  return [
    {
      name: 'validate_config',
      description:
        'Validate a consentbar config object against project rules (strict opt-in, runtime-safe defaults).',
      inputSchema: {
        type: 'object',
        properties: {
          config: {
            type: 'object',
            additionalProperties: true,
            description: 'Potential consentbar config payload.'
          }
        },
        additionalProperties: false
      }
    },
    {
      name: 'audit_html',
      description:
        'Run consentbar content checks over HTML and return blocking-related findings (no writes).',
      inputSchema: {
        type: 'object',
        properties: {
          html: {
            type: 'string',
            maxLength: MAX_AUDIT_HTML_BYTES,
            description: 'Raw HTML string to audit.'
          },
          config: {
            type: 'object',
            additionalProperties: true,
            description: 'Optional config overrides.'
          },
          platform: {
            type: 'string',
            enum: ['wordpress', 'non-wordpress'],
            description: 'Optional platform hint. WordPress recommends CookieYes instead of ConsentBar runtime.'
          }
        },
        additionalProperties: false
      }
    },
    {
      name: 'audit_html_variants',
      description:
        'Compare consentbar checks across two HTML variants and report cross-variant mismatch findings.',
      inputSchema: {
        type: 'object',
        properties: {
          publicHtml: {
            type: 'string',
            maxLength: MAX_AUDIT_HTML_BYTES,
            description: 'Public-facing HTML variant to compare.'
          },
          freshHtml: {
            type: 'string',
            maxLength: MAX_AUDIT_HTML_BYTES,
            description: 'Fresh build HTML variant to compare.'
          },
          config: {
            type: 'object',
            additionalProperties: true,
            description: 'Optional config overrides.'
          },
          platform: {
            type: 'string',
            enum: ['wordpress', 'non-wordpress'],
            description: 'Optional platform hint. WordPress recommends CookieYes instead of ConsentBar runtime.'
          }
        },
        required: ['publicHtml', 'freshHtml'],
        additionalProperties: false
      }
    },
    {
      name: 'get_default_config',
      description: 'Return safe default config values, strict opt-in defaults, and tracker patterns.',
      inputSchema: {
        type: 'object',
        properties: {
          platform: {
            type: 'string',
            enum: ['wordpress', 'non-wordpress'],
            description: 'Optional platform hint for runtime recommendation.'
          }
        },
        additionalProperties: false
      }
    },
    {
      name: 'get_standards',
      description:
        'Return strict implementation reminders used by this toolkit, including read-only marker and GPC defaults.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false
      }
    }
  ];
}

function asError(id, code, message, data) {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
      data
    }
  };
}

function asSuccess(id, result) {
  return {
    jsonrpc: '2.0',
    id,
    result
  };
}

export async function mcpHandle(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message) || message === null) {
    return asError(null, -32600, 'Invalid JSON-RPC message.');
  }

  const hasJsonRpc = message.jsonrpc === '2.0';
  const hasMethod = typeof message.method === 'string';
  if (!hasJsonRpc || !hasMethod) {
    return asError(message.id ?? null, -32600, 'Invalid request.');
  }

  const method = message.method;
  const params = message.params ?? {};
  const id = Object.prototype.hasOwnProperty.call(message, 'id') ? message.id : undefined;
  const protocol = resolveProtocolVersion(params.protocolVersion);

  if (typeof id === 'undefined') {
    // JSON-RPC notifications are accepted but intentionally produce no response.
    return null;
  }

  if (method === 'initialize') {
    return asSuccess(id, {
      protocolVersion: protocol,
      capabilities: {
        tools: {
          listChanged: false
        }
      },
      serverInfo: {
        name: 'consentbar-agent-kit',
        version: '0.1.0'
      }
    });
  }

  if (method === 'ping') {
    return asSuccess(id, null);
  }

  if (method === 'tools/list') {
    return asSuccess(id, {
      tools: defaultTools(),
      nextCursor: null
    });
  }

  if (method === 'tools/call') {
    if (!params || typeof params !== 'object' || typeof params.name !== 'string') {
      return asError(id, -32602, 'tools/call requires a tool name.');
    }

    const args = params.arguments ?? {};
    const argsObj = typeof args === 'object' && !Array.isArray(args) && args !== null ? args : {};

    if (params.name === 'validate_config') {
      const cfgResult = validateConfig(argsObj.config ?? {});
      return asSuccess(id, {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                valid: cfgResult.valid,
                errors: cfgResult.errors,
                normalized: cfgResult.normalized
                  ? cfgResult.normalized
                  : {
                      version: defaultConfigValues().version,
                      policyVersion: defaultConfigValues().policyVersion,
                      policyUrl: defaultConfigValues().policyUrl
                    },
                fallback: cfgResult.fallback
              },
              null,
              2
            )
          }
        ],
        isError: !cfgResult.valid,
        cacheAge: 0
      });
    }

    if (params.name === 'audit_html') {
      if (typeof argsObj.html !== 'string' || argsObj.html.length === 0) {
        return asError(id, -32602, 'audit_html requires a non-empty html string argument.');
      }
      if (Buffer.byteLength(argsObj.html, 'utf8') > MAX_AUDIT_HTML_BYTES) {
        return asError(id, -32602, 'audit_html html must be 512 KiB or smaller.');
      }

      const cfg = argsObj.config ? normalizeConfig(argsObj.config) : undefined;
      const result = await auditHtmlContent(argsObj.html, cfg, argsObj.platform);
      return asSuccess(id, {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2)
          }
        ],
        cacheAge: 0
      });
    }

    if (params.name === 'audit_html_variants') {
      if (typeof argsObj.publicHtml !== 'string' || argsObj.publicHtml.length === 0) {
        return asError(id, -32602, 'audit_html_variants requires a non-empty publicHtml string argument.');
      }
      if (typeof argsObj.freshHtml !== 'string' || argsObj.freshHtml.length === 0) {
        return asError(id, -32602, 'audit_html_variants requires a non-empty freshHtml string argument.');
      }
      if (Buffer.byteLength(argsObj.publicHtml, 'utf8') > MAX_AUDIT_HTML_BYTES || Buffer.byteLength(argsObj.freshHtml, 'utf8') > MAX_AUDIT_HTML_BYTES) {
        return asError(id, -32602, 'audit_html_variants html inputs must be 512 KiB or smaller each.');
      }

      const cfg = argsObj.config ? normalizeConfig(argsObj.config) : undefined;
      const result = await auditHtmlVariants(argsObj.publicHtml, argsObj.freshHtml, cfg, argsObj.platform);
      return asSuccess(id, {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2)
          }
        ],
        cacheAge: 0
      });
    }

    if (params.name === 'get_default_config') {
      const defaults = defaultConfigValues();
      return asSuccess(id, {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              defaults,
              runtime: 'browser-only',
              categories: canonicalCategories()
            }, null, 2)
          }
        ],
        cacheAge: 3600
      });
    }

    if (params.name === 'get_standards') {
      const platform = argsObj.platform === 'wordpress' ? 'wordpress' : 'non-wordpress';
      return asSuccess(id, {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                strict_opt_in: true,
                default: 'essential=true, statistics=false, marketing=false, preferences=false',
                required_attributes: ['data-consent-category', 'data-consent-src'],
                inline_guard: 'type="text/plain"',
                gpc: 'forces non-essential false when navigator.globalPrivacyControl === true',
                platform,
                runtime_recommendation: platform === 'wordpress'
                  ? 'Use the official CookieYes WordPress plugin; do not deploy ConsentBar runtime. Standards still require independent blocking/controls proof.'
                  : 'ConsentBar runtime is suitable for non-WordPress when all strict gating checks pass.'
              },
              null,
              2
            )
          }
        ],
        cacheAge: 3600
      });
    }

    return asError(id, -32601, `Unknown tool '${params.name}'.`);
  }

  return asError(id, -32601, `Method '${method}' is not supported.`);
}
