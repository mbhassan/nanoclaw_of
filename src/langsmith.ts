import { randomUUID } from 'crypto';

import { readRawEnvFile } from './raw-env.js';

const envConfig = readRawEnvFile([
  'LANGSMITH_TRACING',
  'LANGSMITH_API_KEY',
  'LANGSMITH_ENDPOINT',
  'LANGSMITH_WORKSPACE_ID',
  'LANGSMITH_PROJECT',
  'LANGSMITH_MAX_BODY_BYTES',
]);

const DEFAULT_ENDPOINT = 'https://api.smith.langchain.com';

function envValue(key: keyof typeof envConfig): string | undefined {
  return process.env[key] || envConfig[key];
}

function isEnabled(): boolean {
  const flag = envValue('LANGSMITH_TRACING');
  if (flag === 'false') return false;
  return Boolean(flag === 'true' && envValue('LANGSMITH_API_KEY'));
}

function maxBodyBytes(): number {
  const raw = envValue('LANGSMITH_MAX_BODY_BYTES');
  const parsed = raw ? parseInt(raw, 10) : 262144;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 262144;
}

function shouldLogPath(pathname: string, method: string): boolean {
  if (method !== 'POST') return false;
  return (
    pathname.includes('/messages') ||
    pathname.includes('/chat/completions') ||
    pathname.includes('/responses') ||
    pathname.includes('/completions') ||
    pathname.includes('/complete')
  );
}

function isJsonContentType(contentType: string | undefined): boolean {
  return Boolean(contentType && contentType.toLowerCase().includes('json'));
}

function truncate(value: string): string {
  const max = maxBodyBytes();
  return value.length > max ? value.slice(0, max) : value;
}

type LangSmithContentPart = { type: 'text' | 'reasoning'; text: string };
type LangSmithMessage = {
  role: 'system' | 'user' | 'assistant';
  content: LangSmithContentPart[];
};

function textPart(text: string, type: 'text' | 'reasoning' = 'text'): LangSmithContentPart[] {
  return text ? [{ type, text }] : [];
}

function toLangSmithContent(content: unknown): LangSmithContentPart[] {
  if (typeof content === 'string') return textPart(content);
  if (!Array.isArray(content)) return textPart(JSON.stringify(content));

  const parts: LangSmithContentPart[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const entry = part as Record<string, unknown>;
    if (entry.type === 'text' && typeof entry.text === 'string') {
      parts.push({ type: 'text', text: entry.text });
    } else if (entry.type === 'reasoning' && typeof entry.text === 'string') {
      parts.push({ type: 'reasoning', text: entry.text });
    }
  }
  return parts.length > 0 ? parts : textPart(JSON.stringify(content));
}

function normalizeAnthropicRequest(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const messages: LangSmithMessage[] = [];
  const system = body.system;

  if (typeof system === 'string' && system) {
    messages.push({ role: 'system', content: textPart(system) });
  } else if (Array.isArray(system)) {
    for (const block of system) {
      if (!block || typeof block !== 'object') continue;
      const entry = block as Record<string, unknown>;
      if (typeof entry.text === 'string') {
        messages.push({ role: 'system', content: textPart(entry.text) });
      }
    }
  }

  if (Array.isArray(body.messages)) {
    for (const item of body.messages) {
      if (!item || typeof item !== 'object') continue;
      const message = item as Record<string, unknown>;
      const role =
        message.role === 'assistant' ? 'assistant' : ('user' as const);
      messages.push({
        role,
        content: toLangSmithContent(message.content),
      });
    }
  }

  return {
    messages,
    model: body.model,
    stream: body.stream,
    max_tokens: body.max_tokens,
  };
}

function parseJsonBody(body: Buffer, contentType: string | undefined): unknown {
  if (!isJsonContentType(contentType) || body.length === 0) return null;
  try {
    return JSON.parse(body.toString('utf-8'));
  } catch {
    return { raw: truncate(body.toString('utf-8')) };
  }
}

function parseAnthropicSseResponse(raw: string): Record<string, unknown> | null {
  const assistantText: string[] = [];
  let usage: Record<string, unknown> | undefined;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const event = JSON.parse(payload) as Record<string, unknown>;
      if (
        event.type === 'content_block_start' &&
        event.content_block &&
        typeof event.content_block === 'object'
      ) {
        const block = event.content_block as Record<string, unknown>;
        if (typeof block.text === 'string') assistantText.push(block.text);
      } else if (
        event.type === 'content_block_delta' &&
        event.delta &&
        typeof event.delta === 'object'
      ) {
        const delta = event.delta as Record<string, unknown>;
        if (typeof delta.text === 'string') assistantText.push(delta.text);
      } else if (
        event.type === 'message_start' &&
        event.message &&
        typeof event.message === 'object'
      ) {
        const message = event.message as Record<string, unknown>;
        if (message.usage && typeof message.usage === 'object') {
          usage = message.usage as Record<string, unknown>;
        }
      } else if (
        event.type === 'message_delta' &&
        event.usage &&
        typeof event.usage === 'object'
      ) {
        usage = {
          ...(usage || {}),
          ...(event.usage as Record<string, unknown>),
        };
      }
    } catch {
      // Best-effort parsing only.
    }
  }

  if (assistantText.length === 0 && !usage) return null;
  return {
    messages: [
      {
        role: 'assistant',
        content: textPart(assistantText.join('')),
        ...(usage ? { usage_metadata: usage } : {}),
      },
    ],
  };
}

function normalizeResponseBody(
  body: Buffer,
  contentType: string | undefined,
): Record<string, unknown> | null {
  if (body.length === 0) return null;

  const text = truncate(body.toString('utf-8'));
  if (contentType?.includes('text/event-stream')) {
    return parseAnthropicSseResponse(text) || { raw: text };
  }

  const parsed = parseJsonBody(body, contentType);
  if (!parsed || typeof parsed !== 'object') return parsed as null;

  const record = parsed as Record<string, unknown>;
  if (Array.isArray(record.content)) {
    return {
      messages: [
        {
          role: 'assistant',
          content: toLangSmithContent(record.content),
          ...(record.usage && typeof record.usage === 'object'
            ? { usage_metadata: record.usage }
            : {}),
        },
      ],
    };
  }

  if (Array.isArray(record.choices)) {
    return record;
  }

  return record;
}

function metadataForRun(
  pathname: string,
  upstreamBaseUrl: string,
  requestBody: Record<string, unknown> | null,
): Record<string, unknown> {
  const base = new URL(upstreamBaseUrl);
  const model =
    requestBody && typeof requestBody.model === 'string'
      ? requestBody.model
      : undefined;

  return {
    ls_provider: base.hostname,
    ...(model ? { ls_model_name: model } : {}),
    endpoint_path: pathname,
    component: 'credential-proxy',
  };
}

async function langSmithFetch(
  path: string,
  method: 'POST' | 'PATCH',
  body: Record<string, unknown>,
): Promise<void> {
  const apiKey = envValue('LANGSMITH_API_KEY');
  if (!apiKey) return;

  const endpoint = envValue('LANGSMITH_ENDPOINT') || DEFAULT_ENDPOINT;
  const workspaceId = envValue('LANGSMITH_WORKSPACE_ID');
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-api-key': apiKey,
  };
  if (workspaceId) headers['x-tenant-id'] = workspaceId;

  await fetch(new URL(path, endpoint), {
    method,
    headers,
    body: JSON.stringify(body),
  });
}

export interface LangSmithRunHandle {
  id: string;
  ready: Promise<void>;
}

export interface LangSmithProxyRunInput {
  method: string;
  pathname: string;
  upstreamBaseUrl: string;
  contentType?: string;
  body: Buffer;
}

export function shouldLogProxyRequest(
  pathname: string,
  method: string,
  contentType?: string,
): boolean {
  if (!isEnabled()) return false;
  return shouldLogPath(pathname, method) && isJsonContentType(contentType);
}

export async function startProxyLlmRun(
  input: LangSmithProxyRunInput,
): Promise<LangSmithRunHandle | null> {
  if (!shouldLogProxyRequest(input.pathname, input.method, input.contentType)) {
    return null;
  }

  const requestBody = parseJsonBody(
    input.body,
    input.contentType,
  ) as Record<string, unknown> | null;
  const id = randomUUID();
  const startTime = new Date().toISOString();
  const project = envValue('LANGSMITH_PROJECT') || 'nanoclaw';

  const ready = langSmithFetch('/runs', 'POST', {
    id,
    name: `LLM ${input.pathname}`,
    run_type: 'llm',
    session_name: project,
    start_time: startTime,
    inputs:
      requestBody && typeof requestBody === 'object'
        ? normalizeAnthropicRequest(requestBody)
        : { raw: truncate(input.body.toString('utf-8')) },
    extra: {
      metadata: metadataForRun(
        input.pathname,
        input.upstreamBaseUrl,
        requestBody,
      ),
    },
    tags: ['nanoclaw', 'credential-proxy'],
  }).catch(() => {
    // Tracing must not interfere with user traffic.
  });

  return { id, ready };
}

export async function finishProxyLlmRun(
  handle: LangSmithRunHandle | null,
  input: {
    statusCode?: number;
    responseBody: Buffer;
    responseContentType?: string;
    error?: string;
  },
): Promise<void> {
  if (!handle) return;
  await handle.ready;

  const outputs = normalizeResponseBody(
    input.responseBody,
    input.responseContentType,
  );

  await langSmithFetch(`/runs/${handle.id}`, 'PATCH', {
    end_time: new Date().toISOString(),
    ...(outputs ? { outputs } : {}),
    ...(input.statusCode ? { status_code: input.statusCode } : {}),
    ...(input.error ? { error: input.error } : {}),
  }).catch(() => {
    // Tracing must not interfere with user traffic.
  });
}
