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

const enabled = process.env.OTEL_ENABLED === 'true' ||
  Boolean(
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
      process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
      process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT,
  );

const resource = resourceFromAttributes({
  [SemanticResourceAttributes.SERVICE_NAME]:
    process.env.OTEL_SERVICE_NAME || 'nanoclaw-agent-runner',
  [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]:
    process.env.DEPLOYMENT_ENVIRONMENT || 'development',
});

let sdk: NodeSDK | null = null;
let loggerProvider: LoggerProvider | null = null;
let otelLogger: OtelLogger | null = null;

if (enabled) {
  sdk = new NodeSDK({
    resource,
    traceExporter: new OTLPTraceExporter(),
  });
  sdk.start();

  loggerProvider = new LoggerProvider({
    resource,
    processors: [new BatchLogRecordProcessor(new OTLPLogExporter())],
  });
  otelLogger = loggerProvider.getLogger('nanoclaw-agent-runner');
}

function severity(level: string): SeverityNumber {
  switch (level) {
    case 'debug':
      return SeverityNumber.DEBUG;
    case 'warn':
      return SeverityNumber.WARN;
    case 'error':
      return SeverityNumber.ERROR;
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
    } else {
      normalized[key] = JSON.stringify(value);
    }
  }
  return normalized;
}

export function emitTelemetryLog(
  level: string,
  message: string,
  attributes?: Record<string, unknown>,
): void {
  if (!otelLogger) return;
  const spanContext = trace.getActiveSpan()?.spanContext();
  otelLogger.emit({
    body: message,
    severityText: level.toUpperCase(),
    severityNumber: severity(level),
    attributes: normalizeAttributes({
      ...attributes,
      ...(spanContext
        ? {
            trace_id: spanContext.traceId,
            span_id: spanContext.spanId,
          }
        : {}),
    }),
  });
}

export async function withSpan<T>(
  name: string,
  attributes: Attributes | undefined,
  fn: (span: Span) => Promise<T> | T,
): Promise<T> {
  const activeTracer = trace.getTracer('nanoclaw-agent-runner');
  return activeTracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      throw err;
    } finally {
      span.end();
    }
  });
}

export async function shutdownTelemetry(): Promise<void> {
  await Promise.all([
    sdk?.shutdown() ?? Promise.resolve(),
    loggerProvider?.shutdown() ?? Promise.resolve(),
  ]);
}
