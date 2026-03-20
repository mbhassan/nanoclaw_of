import {
  Attributes,
  Span,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import {
  SeverityNumber,
  type Logger as OtelLogger,
} from '@opentelemetry/api-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchLogRecordProcessor,
  LoggerProvider,
} from '@opentelemetry/sdk-logs';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';

import { readRawEnvFile } from './raw-env.js';

const envConfig = readRawEnvFile([
  'OTEL_ENABLED',
  'OTEL_SERVICE_NAME',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
  'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
  'DEPLOYMENT_ENVIRONMENT',
]);

function envValue(key: keyof typeof envConfig): string | undefined {
  return process.env[key] || envConfig[key];
}

function telemetryEnabled(): boolean {
  if (process.env.OTEL_ENABLED === 'false' || envConfig.OTEL_ENABLED === 'false')
    return false;
  if (process.env.OTEL_ENABLED === 'true' || envConfig.OTEL_ENABLED === 'true')
    return true;
  return Boolean(
    envValue('OTEL_EXPORTER_OTLP_ENDPOINT') ||
      envValue('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT') ||
      envValue('OTEL_EXPORTER_OTLP_LOGS_ENDPOINT'),
  );
}

const enabled = telemetryEnabled();
const serviceName = envValue('OTEL_SERVICE_NAME') || 'nanoclaw-host';
const resource = resourceFromAttributes({
  [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
  [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]:
    envValue('DEPLOYMENT_ENVIRONMENT') || 'development',
});

let sdk: NodeSDK | null = null;
let logProvider: LoggerProvider | null = null;
let otelLogger: OtelLogger | null = null;

if (enabled) {
  sdk = new NodeSDK({
    resource,
    traceExporter: new OTLPTraceExporter(),
  });
  sdk.start();

  logProvider = new LoggerProvider({
    resource,
    processors: [new BatchLogRecordProcessor(new OTLPLogExporter())],
  });
  otelLogger = logProvider.getLogger(serviceName);
}

function severityNumber(level: string): SeverityNumber {
  switch (level) {
    case 'trace':
      return SeverityNumber.TRACE;
    case 'debug':
      return SeverityNumber.DEBUG;
    case 'warn':
      return SeverityNumber.WARN;
    case 'error':
      return SeverityNumber.ERROR;
    case 'fatal':
      return SeverityNumber.FATAL;
    default:
      return SeverityNumber.INFO;
  }
}

function normalizeAttributes(
  attributes?: Record<string, unknown>,
): Attributes | undefined {
  if (!attributes) return undefined;
  const normalized: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (
      value === null ||
      value === undefined ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      normalized[key] = value as string | number | boolean | undefined;
      continue;
    }
    normalized[key] = JSON.stringify(value);
  }
  return normalized;
}

export function emitTelemetryLog(
  level: string,
  message: string,
  attributes?: Record<string, unknown>,
): void {
  if (!otelLogger) return;

  const span = trace.getActiveSpan();
  const spanContext = span?.spanContext();
  const merged = {
    ...attributes,
    ...(spanContext
      ? {
          trace_id: spanContext.traceId,
          span_id: spanContext.spanId,
        }
      : {}),
  };

  otelLogger.emit({
    body: message,
    severityText: level.toUpperCase(),
    severityNumber: severityNumber(level),
    attributes: normalizeAttributes(merged),
  });
}

export function tracer(name = serviceName) {
  return trace.getTracer(name);
}

export async function withSpan<T>(
  name: string,
  attributes: Attributes | undefined,
  fn: (span: Span) => Promise<T> | T,
): Promise<T> {
  const activeTracer = tracer();
  return activeTracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      span.recordException(error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error.message,
      });
      throw err;
    } finally {
      span.end();
    }
  });
}

export function setSpanError(span: Span, err: unknown): void {
  const error = err instanceof Error ? err : new Error(String(err));
  span.recordException(error);
  span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
}

export function startSpan(name: string, attributes?: Attributes): Span {
  return tracer().startSpan(name, { attributes });
}

export async function shutdownTelemetry(): Promise<void> {
  await Promise.all([
    sdk?.shutdown() ?? Promise.resolve(),
    logProvider?.shutdown() ?? Promise.resolve(),
  ]);
}

export function isTelemetryEnabled(): boolean {
  return enabled;
}
