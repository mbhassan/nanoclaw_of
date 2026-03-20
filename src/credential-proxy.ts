/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { readEnvFile } from './env.js';
import { finishProxyLlmRun, startProxyLlmRun } from './langsmith.js';
import { logger } from './logger.js';
import { setSpanError, startSpan } from './telemetry.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const span = startSpan('nanoclaw.credential_proxy.request', {
        'http.request.method': req.method || 'GET',
        'url.path': req.url || '/',
      });
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const pathname = req.url || '/';
        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (authMode === 'api-key') {
          // API key mode: inject x-api-key on every request
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else {
          // OAuth mode: replace placeholder Bearer token with the real one
          // only when the container actually sends an Authorization header
          // (exchange request + auth probes). Post-exchange requests use
          // x-api-key only, so they pass through without token injection.
          if (headers['authorization']) {
            delete headers['authorization'];
            if (oauthToken) {
              headers['authorization'] = `Bearer ${oauthToken}`;
            }
          }
        }

        const langSmithRun = startProxyLlmRun({
          method: req.method || 'GET',
          pathname,
          upstreamBaseUrl: upstreamUrl.toString(),
          contentType: req.headers['content-type'],
          body,
        });

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: req.url,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            const responseChunks: Buffer[] = [];
            let responseSize = 0;
            let responseTruncated = false;

            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.on('data', (chunk: Buffer) => {
              res.write(chunk);
              if (responseTruncated) return;
              responseSize += chunk.length;
              if (responseSize > 262144) {
                responseTruncated = true;
                return;
              }
              responseChunks.push(chunk);
            });
            upRes.on('end', () => {
              span.setAttribute('http.response.status_code', upRes.statusCode || 0);
              res.end();
              span.end();
              void langSmithRun.then((run) =>
                finishProxyLlmRun(run, {
                  statusCode: upRes.statusCode,
                  responseBody: Buffer.concat(responseChunks),
                  responseContentType:
                    typeof upRes.headers['content-type'] === 'string'
                      ? upRes.headers['content-type']
                      : undefined,
                  ...(responseTruncated ? { error: 'response_body_truncated' } : {}),
                }),
              );
            });
            upRes.on('error', (err) => {
              setSpanError(span, err);
              span.end();
              logger.error({ err, url: req.url }, 'Credential proxy response error');
              if (!res.headersSent) {
                res.writeHead(502);
              }
              res.end('Bad Gateway');
              void langSmithRun.then((run) =>
                finishProxyLlmRun(run, {
                  responseBody: Buffer.concat(responseChunks),
                  error: err instanceof Error ? err.message : String(err),
                }),
              );
            });
          },
        );

        upstream.on('error', (err) => {
          setSpanError(span, err);
          span.end();
          logger.error(
            { err, url: req.url },
            'Credential proxy upstream error',
          );
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
          void langSmithRun.then((run) =>
            finishProxyLlmRun(run, {
              responseBody: Buffer.alloc(0),
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        });

        upstream.write(body);
        upstream.end();
      });
      req.on('error', (err) => {
        setSpanError(span, err);
        span.end();
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host, authMode }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
