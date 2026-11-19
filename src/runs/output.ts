import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Ajv, type ValidateFunction } from "ajv";
import { Ajv2019 } from "ajv/dist/2019.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

/** The tool a run with an `outputSchema` delivers its result through (S-D11). */
export const SUBMIT_TOOL = "submit_output";
/** Invalid submit_output calls a run may make: the first gets the errors back to fix them, the second fails the run. */
export const MAX_INVALID_SUBMITS = 2;

// ajv-formats is CommonJS with a default export; under NodeNext its default import is the module object.
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ?? addFormatsModule) as (ajv: Ajv) => Ajv;

const compiled = new WeakMap<object, ValidateFunction>();

/**
 * The validator class for the schema's declared draft: 2020-12 (what zod v4's toJSONSchema writes), 2019-09, else
 * draft-07, ajv's default. strict: false so schemas written for other validators (unknown keywords, `$comment`)
 * still work.
 */
function ajvFor(schema: Record<string, unknown>): Ajv {
  const declared = typeof schema.$schema === "string" ? schema.$schema : "";
  const o = { strict: false, allErrors: true };
  const ajv = declared.includes("2020-12") ? new Ajv2020(o) : declared.includes("2019-09") ? new Ajv2019(o) : new Ajv(o);
  return addFormats(ajv);
}

/**
 * A validator for an output schema; throws with why the schema is unusable. Each schema gets an Ajv instance of its
 * own: a shared one keeps every compiled schema for the life of the process and refuses a second schema with the same
 * `$id`, and every request brings a new schema object. Cached per schema object (the runner reuses runJob's).
 */
export function outputValidator(schema: Record<string, unknown>): ValidateFunction {
  const hit = compiled.get(schema);
  if (hit) return hit;
  // Tool parameters are an object on every model API.
  if (schema.type !== "object") throw new Error('the output schema must have type "object"');
  const v = ajvFor(schema).compile(schema);
  compiled.set(schema, v);
  return v;
}

const MAX_ERRORS = 20;

/** ajv's errors as the model reads them: one line per problem, at the path it is at. */
function describe(v: ValidateFunction): string {
  const errs = v.errors ?? [];
  const lines = errs.slice(0, MAX_ERRORS).map((e) => `- ${e.instancePath || "(root)"}: ${e.message ?? e.keyword}${e.params && Object.keys(e.params).length ? ` ${JSON.stringify(e.params)}` : ""}`);
  if (errs.length > MAX_ERRORS) lines.push(`- ... ${errs.length - MAX_ERRORS} more`);
  return lines.join("\n");
}

/**
 * `submit_output`: its parameters are the output schema, and a call is the run's result once it validates. An
 * invalid call is a tool error with ajv's errors, so the model can fix it. `onValid` gets the arguments.
 */
export function submitOutputTool(schema: Record<string, unknown>, onValid: (output: unknown) => void): AgentTool<any> {
  const validate = outputValidator(schema);
  const { $schema: _ignored, ...parameters } = schema;
  return {
    name: SUBMIT_TOOL,
    label: "Submit output",
    description:
      "Deliver the result of this run. The arguments are the result and must match the schema exactly. Call it once, when the work is done; if it returns errors, fix them and call it again.",
    parameters,
    executionMode: "sequential",
    execute: async (_id, params) => {
      if (!validate(params)) {
        return { content: [{ type: "text", text: `The output does not match the schema:\n${describe(validate)}\nFix it and call ${SUBMIT_TOOL} again.` }], details: undefined, isError: true };
      }
      onValid(params);
      return { content: [{ type: "text", text: "Output accepted." }], details: undefined, terminate: true };
    },
  };
}
