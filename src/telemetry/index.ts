import { context, diag, DiagLogLevel, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, TracerProvider, type ReadableSpan, type SpanExporter } from "@opentelemetry/sdk-trace";
import type { Logger } from "pino";

type Log = Pick<Logger, "error" | "warn" | "info">;

export interface Telemetry {
  /** Export buffered spans now. */
  flush(): Promise<void>;
  /** Flush buffered spans; call on shutdown so the last tasks' traces are not lost. */
  shutdown(): Promise<void>;
}

/**
 * Tracing is on when an OTLP endpoint is configured with the standard env vars (OTEL_EXPORTER_OTLP_ENDPOINT or
 * OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, plus OTEL_EXPORTER_OTLP_HEADERS for auth). Any OTLP/HTTP backend works:
 * OpenObserve, Langfuse, an OTel collector. Without one, spans go to the API's no-op tracer and cost nothing.
 */
export function tracingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.OTEL_SDK_DISABLED === "true") return false;
  return Boolean(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || env.OTEL_EXPORTER_OTLP_ENDPOINT);
}

/**
 * Logs batches the exporter gave up on (after its own retries) and the recovery, at most once per `intervalMs`
 * while the backend stays down. The SDK only reports a failed batch to its diag logger, without the span count.
 */
export class ReportingExporter implements SpanExporter {
  private failedBatches = 0;
  private droppedSpans = 0;
  private lastLogAt = -Infinity;

  constructor(
    private inner: SpanExporter,
    private log: Log,
    private now: () => number = Date.now,
    private intervalMs = 60_000,
  ) {}

  export(spans: ReadableSpan[], done: (result: ExportResult) => void): void {
    this.inner.export(spans, (result) => {
      if (result.code === ExportResultCode.SUCCESS) {
        if (this.failedBatches > 0) {
          this.log.info({ failedBatches: this.failedBatches, droppedSpans: this.droppedSpans }, "trace export recovered");
          this.failedBatches = this.droppedSpans = 0;
          this.lastLogAt = -Infinity;
        }
      } else {
        this.failedBatches++;
        this.droppedSpans += spans.length;
        if (this.now() - this.lastLogAt >= this.intervalMs) {
          this.lastLogAt = this.now();
          this.log.warn(
            { err: result.error, failedBatches: this.failedBatches, droppedSpans: this.droppedSpans },
            "trace export failed; spans dropped",
          );
        }
      }
      // Reported above. Passing the failure on would make the SDK log it again through diag, once per batch.
      done({ code: ExportResultCode.SUCCESS });
    });
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}

/** SDK warnings (spans dropped from a full queue, partial-success rejections) go to the app log; the rest is noise. */
function routeDiagnostics(log: Log) {
  const off = () => {};
  diag.setLogger(
    {
      error: (msg, ...args) => log.error({ otel: args }, msg),
      warn: (msg, ...args) => log.warn({ otel: args }, msg),
      info: off,
      debug: off,
      verbose: off,
    },
    DiagLogLevel.WARN,
  );
}

export function startTelemetry(
  opts: { env?: NodeJS.ProcessEnv; exporter?: SpanExporter; log?: Log } = {},
): Telemetry | undefined {
  const env = opts.env ?? process.env;
  if (!opts.exporter && !tracingEnabled(env)) return undefined;
  if (opts.log) routeDiagnostics(opts.log);
  const exporter = opts.exporter ?? new OTLPTraceExporter();
  const provider = new TracerProvider({
    resource: resourceFromAttributes({ "service.name": env.OTEL_SERVICE_NAME || "neotags" }),
    spanProcessors: [new BatchSpanProcessor({ exporter: opts.log ? new ReportingExporter(exporter, opts.log) : exporter })],
  });
  // Without a context manager every span is a root: the router's task span would not parent the LLM calls.
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(provider);
  return { flush: () => provider.forceFlush(), shutdown: () => provider.shutdown() };
}
