import pino from 'pino';

import { emitTelemetryLog } from './telemetry.js';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } },
  hooks: {
    logMethod(args, method, level) {
      const [first, second] = args;
      let message = '';
      let attributes: Record<string, unknown> | undefined;

      if (typeof first === 'string') {
        message = first;
      } else if (first && typeof first === 'object') {
        attributes = first as Record<string, unknown>;
        if (typeof second === 'string') {
          message = second;
        } else {
          message = 'Structured log';
        }
      } else {
        message = String(first);
      }

      emitTelemetryLog(pino.levels.labels[level] || 'info', message, attributes);
      return method.apply(this, args);
    },
  },
});

// Route uncaught errors through pino so they get timestamps in stderr
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
