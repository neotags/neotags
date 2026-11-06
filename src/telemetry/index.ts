import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, TracerProvider, type SpanExporter } from "@opentelemetry/sdk-trace";

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

export function startTelemetry(
  opts: { env?: NodeJS.ProcessEnv; exporter?: SpanExporter } = {},
): Telemetry | undefined {
  const env = opts.env ?? process.env;
  if (!opts.exporter && !tracingEnabled(env)) return undefined;
  const provider = new TracerProvider({
    resource: resourceFromAttributes({ "service.name": env.OTEL_SERVICE_NAME || "neotags" }),
    spanProcessors: [new BatchSpanProcessor({ exporter: opts.exporter ?? new OTLPTraceExporter() })],
  });
  // Without a context manager every span is a root: the router's task span would not parent the LLM calls.
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(provider);
  return { flush: () => provider.forceFlush(), shutdown: () => provider.shutdown() };
}
