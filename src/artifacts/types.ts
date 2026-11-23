// Where routines keep their period records (lease, run.json, data, bundle, delivery results): an object store with
// conditional writes, S3 in production. Keys are relative to the store's root; routines use `jobs/` only.

export interface StoredObject {
  body: string;
  etag: string;
}

/** A conditional write or delete: at most one of the two. */
export interface Condition {
  /** Only if the current object has this etag. */
  ifMatch?: string;
  /** `*`: only if there is no object. */
  ifNoneMatch?: "*";
}

/**
 * A condition did not hold, as S3 answers it (docs: conditional writes and deletes):
 * - 412: the object exists (`ifNoneMatch`) or has another etag (`ifMatch`);
 * - 404: `ifMatch` on an object that does not exist;
 * - 409: a concurrent write or delete of the same key finished first.
 */
export class PreconditionError extends Error {
  constructor(
    readonly status: 404 | 409 | 412,
    readonly key: string,
  ) {
    super(`conditional request on ${key} failed: HTTP ${status}`);
    this.name = "PreconditionError";
  }
}

export interface ListResult {
  /** Object keys directly under the prefix (with a delimiter) or anywhere under it (without). */
  keys: string[];
  /** With a delimiter: each "directory" under the prefix, ending in the delimiter. */
  prefixes: string[];
}

export interface ArtifactStore {
  /** Undefined when there is no object. */
  get(key: string): Promise<StoredObject | undefined>;
  /** Throws PreconditionError when `cond` does not hold. Returns the new etag. */
  put(key: string, body: string, cond?: Condition): Promise<{ etag: string }>;
  /** Without a condition, deleting a missing key is not an error. Throws PreconditionError when `cond` does not hold. */
  delete(key: string, cond?: Pick<Condition, "ifMatch">): Promise<void>;
  /** Every key (and, with `delimiter`, common prefix) under `prefix`, all pages. */
  list(prefix: string, opts?: { delimiter?: string }): Promise<ListResult>;
}
