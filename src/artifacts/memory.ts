import { PreconditionError, type ArtifactStore, type Condition, type ListResult, type StoredObject } from "./types.js";

/**
 * An ArtifactStore in process memory, with S3's conditional semantics: for tests and local development. Nothing
 * survives a restart. `failNext` makes the next matching request fail as S3 would (a concurrent 409, a lost race).
 */
export class MemoryArtifactStore implements ArtifactStore {
  readonly objects = new Map<string, StoredObject>();
  private seq = 0;
  private faults: { op: "get" | "put" | "delete" | "list"; key: RegExp | string; error: () => Error }[] = [];

  /** The next `op` on a key matching `key` throws `error()` instead of running. */
  failNext(op: "get" | "put" | "delete" | "list", key: RegExp | string, error: () => Error): void {
    this.faults.push({ op, key, error });
  }

  private fault(op: "get" | "put" | "delete" | "list", key: string): void {
    const i = this.faults.findIndex((f) => f.op === op && (typeof f.key === "string" ? f.key === key : f.key.test(key)));
    if (i >= 0) throw this.faults.splice(i, 1)[0]!.error();
  }

  async get(key: string): Promise<StoredObject | undefined> {
    this.fault("get", key);
    const o = this.objects.get(key);
    return o && { ...o };
  }

  async put(key: string, body: string, cond: Condition = {}): Promise<{ etag: string }> {
    this.fault("put", key);
    const cur = this.objects.get(key);
    if (cond.ifNoneMatch === "*" && cur) throw new PreconditionError(412, key);
    if (cond.ifMatch !== undefined) {
      if (!cur) throw new PreconditionError(404, key);
      if (cur.etag !== cond.ifMatch) throw new PreconditionError(412, key);
    }
    const etag = `"m${++this.seq}"`;
    this.objects.set(key, { body, etag });
    return { etag };
  }

  async delete(key: string, cond: Pick<Condition, "ifMatch"> = {}): Promise<void> {
    this.fault("delete", key);
    const cur = this.objects.get(key);
    if (cond.ifMatch !== undefined) {
      if (!cur) throw new PreconditionError(404, key);
      if (cur.etag !== cond.ifMatch) throw new PreconditionError(412, key);
    }
    this.objects.delete(key);
  }

  async list(prefix: string, opts: { delimiter?: string } = {}): Promise<ListResult> {
    this.fault("list", prefix);
    const keys: string[] = [];
    const prefixes = new Set<string>();
    for (const k of [...this.objects.keys()].sort()) {
      if (!k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length);
      const cut = opts.delimiter ? rest.indexOf(opts.delimiter) : -1;
      if (cut >= 0) prefixes.add(prefix + rest.slice(0, cut + opts.delimiter!.length));
      else keys.push(k);
    }
    return { keys, prefixes: [...prefixes] };
  }
}
