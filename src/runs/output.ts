import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Ajv, type ValidateFunction } from "ajv";
import addFormatsModule from "ajv-formats";

/** The tool a run with an `outputSchema` delivers its result through (S-D11). */
export const SUBMIT_TOOL = "submit_output";
/** Invalid submit_output calls a run may make: the first gets the errors back to fix them, the second fails the run. */
export const MAX_INVALID_SUBMITS = 2;

// ajv-formats is CommonJS with a default export; under NodeNext its default import is the module object.
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ?? addFormatsModule) as (ajv: Ajv) => Ajv;

// strict: false so schemas written for other validators (unknown keywords, `$comment`, draft differences) still work.
const ajv = addFormats(new Ajv({ strict: false, allErrors: true }));
const compiled = new WeakMap<object, ValidateFunction>();

/** A validator for an output schema; throws with why the schema is unusable. Cached per schema object. */
export function outputValidator(schema: Record<string, unknown>): ValidateFunction {
  const hit = compiled.get(schema);
  if (hit) return hit;
  // Tool parameters are an object on every model API.
  if (schema.type !== "object") throw new Error('the output schema must have type "object"');
  const v = ajv.compile(schema);
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
