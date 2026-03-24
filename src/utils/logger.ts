import winston from "winston";

const { combine, timestamp, json, colorize, printf } = winston.format;

const devFormat = combine(
  colorize(),
  timestamp({ format: "HH:mm:ss" }),
  printf(({ timestamp, level, message, ...meta }) => {
    const extra = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
    return `${timestamp} ${level}: ${message}${extra}`;
  }),
);

const prodFormat = combine(timestamp(), json());

const isDev = process.env.NODE_ENV !== "production";

export const logger = winston.createLogger({
  level: isDev ? "debug" : "info",
  format: isDev ? devFormat : prodFormat,
  transports: [new winston.transports.Console()],
});

export function childLogger(meta: Record<string, unknown>) {
  return logger.child(meta);
}
