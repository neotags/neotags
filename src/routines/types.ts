import type { Config } from "../config/index.js";
import { outputValidator, schemaErrors, schemaValidator } from "../runs/output.js";
import type { PipelineSpec, SkillPack, SkillPackIndex } from "../tools/skillpacks.js";

// Routine types (S-D22, S-D23): a pipeline routine's `type` names the one step pack that declares it.

export interface RoutineType {
  /** The step pack. */
  pack: SkillPack;
  spec: PipelineSpec;
  /** classify.outputSchema, read from the pack it names. */
  outputSchema?: Record<string, unknown>;
}

/** `<pack>/references/<file>` from the loaded index, parsed; or why not. */
function readSchema(index: SkillPackIndex, ref: string): Record<string, unknown> | string {
  const [pack, ...rest] = ref.split("/");
  const file = rest.join("/").replace(/^references\//, "");
  const p = index.get(pack!);
  if (!p) return `skill pack ${pack} is not loaded`;
  const text = p.refs.get(file);
  if (text === undefined) return `${pack} has no reference ${file}`;
  let schema: unknown;
  try {
    schema = JSON.parse(text);
  } catch (err) {
    return `not JSON (${(err as Error).message})`;
  }
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return "not a JSON Schema object";
  try {
    outputValidator(schema as Record<string, unknown>);
  } catch (err) {
    return (err as Error).message;
  }
  return schema as Record<string, unknown>;
}

/** Each declared type's step pack, with its classify output schema; types declared twice are left out (an issue). */
export function routineTypes(index: SkillPackIndex): Map<string, RoutineType> {
  const types = new Map<string, RoutineType>();
  const seen = new Set<string>();
  for (const pack of index.list()) {
    const spec = pack.pipeline;
    if (!spec) continue;
    if (seen.has(spec.type)) {
      types.delete(spec.type);
      continue;
    }
    seen.add(spec.type);
    const schema = spec.classify ? readSchema(index, spec.classify.outputSchema) : undefined;
    types.set(spec.type, { pack, spec, ...(schema && typeof schema !== "string" && { outputSchema: schema }) });
  }
  return types;
}

/**
 * What the loaded step packs and the routines disagree on, checked once the packs are loaded (S-D23). A step pack
 * is never a model's: not in any `agent.entries`, nor any routine's `packs`. Each type has one step pack. A pipeline
 * routine's type must have one, its `params` must pass the type's schema, and the classify output schema it names
 * must exist. (A pipeline's packs that declare `sandbox` are routinePackIssues.)
 */
export function stepPackIssues(cfg: Pick<Config, "routines" | "agent">, index: SkillPackIndex): string[] {
  const issues: string[] = [];
  const steps = index.list().filter((p) => p.pipeline);
  const stepNames = new Set(steps.map((p) => p.name));
  const byType = new Map<string, string[]>();
  for (const p of steps) byType.set(p.pipeline!.type, [...(byType.get(p.pipeline!.type) ?? []), p.name]);
  for (const [type, packs] of byType) if (packs.length > 1) issues.push(`routine type ${type} is declared by more than one step pack: ${packs.join(", ")}`);
  for (const [entry, packs] of Object.entries(cfg.agent.entries)) {
    for (const p of packs ?? []) if (stepNames.has(p)) issues.push(`agent.entries.${entry}: skill pack "${p}" is a step pack; only the pipeline engine runs it`);
  }
  const types = routineTypes(index);
  for (const [name, r] of Object.entries(cfg.routines)) {
    for (const p of r.packs) if (stepNames.has(p)) issues.push(`routines.${name}.packs: skill pack "${p}" is a step pack; only the pipeline engine runs it`);
    if (r.kind !== "pipeline") continue;
    const t = types.get(r.type);
    if (!t) {
      if ((byType.get(r.type)?.length ?? 0) < 2) issues.push(`routines.${name}.type: no loaded step pack declares routine type ${r.type}`);
      continue;
    }
    if (t.spec.paramsSchema) {
      let ok = true;
      let why = "";
      try {
        const v = schemaValidator(t.spec.paramsSchema);
        ok = v(r.params) as boolean;
        if (!ok) why = schemaErrors(v).replace(/\n/g, "; ");
      } catch (err) {
        issues.push(`skill pack ${t.pack.name}: pipeline.params is not a usable JSON Schema: ${(err as Error).message}`);
        continue;
      }
      if (!ok) issues.push(`routines.${name}.params do not match routine type ${r.type}'s schema: ${why}`);
    }
    const c = t.spec.classify;
    if (c) {
      const schema = readSchema(index, c.outputSchema);
      if (typeof schema === "string") issues.push(`skill pack ${t.pack.name}: pipeline.classify.outputSchema ${c.outputSchema}: ${schema}`);
      const b = c.budget;
      if (b?.wallClockSec !== undefined && b.wallClockSec > cfg.agent.wallClockSec.job) {
        issues.push(`skill pack ${t.pack.name}: pipeline.classify.budget.wallClockSec may not exceed agent.wallClockSec.job (${cfg.agent.wallClockSec.job})`);
      }
      if (b?.maxSteps !== undefined && b.maxSteps > cfg.agent.maxSteps) issues.push(`skill pack ${t.pack.name}: pipeline.classify.budget.maxSteps may not exceed agent.maxSteps (${cfg.agent.maxSteps})`);
    }
  }
  return issues;
}
