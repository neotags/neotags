import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { PreconditionError, type ArtifactStore, type Condition, type ListResult, type StoredObject } from "./types.js";

/** The part of S3Client this store uses; tests pass a fake. */
export interface S3Like {
  send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
}

export interface S3ArtifactStoreOptions {
  bucket: string;
  /**
   * Default: an S3Client on the SDK's default credential and region chain (IRSA in the cluster: the web identity
   * token and AWS_REGION the EKS webhook injects). No static keys in configuration.
   */
  client?: S3Like;
}

const status = (err: unknown): number | undefined => (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;

/**
 * The store on one S3 bucket. Never calls HeadBucket or lists the bucket root: the IAM policy allows ListBucket only
 * under `jobs/`, and both would be refused (403).
 */
export class S3ArtifactStore implements ArtifactStore {
  private client: S3Like;
  private bucket: string;

  constructor(o: S3ArtifactStoreOptions) {
    this.bucket = o.bucket;
    this.client = o.client ?? (new S3Client({}) as unknown as S3Like);
  }

  /** A failed condition as PreconditionError; anything else as it came. */
  private conditional(err: unknown, key: string): never {
    const s = status(err);
    if (s === 412 || s === 409 || s === 404) throw new PreconditionError(s, key);
    throw err;
  }

  async get(key: string): Promise<StoredObject | undefined> {
    let out: { Body?: { transformToString(): Promise<string> }; ETag?: string };
    try {
      out = (await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))) as typeof out;
    } catch (err) {
      if (status(err) === 404 || (err as { name?: string }).name === "NoSuchKey") return undefined;
      throw err;
    }
    return { body: (await out.Body?.transformToString()) ?? "", etag: out.ETag ?? "" };
  }

  async put(key: string, body: string, cond: Condition = {}): Promise<{ etag: string }> {
    try {
      const out = (await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: key.endsWith(".json") ? "application/json" : key.endsWith(".html") ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
          ...(cond.ifMatch !== undefined && { IfMatch: cond.ifMatch }),
          ...(cond.ifNoneMatch && { IfNoneMatch: cond.ifNoneMatch }),
        }),
      )) as { ETag?: string };
      return { etag: out.ETag ?? "" };
    } catch (err) {
      if (cond.ifMatch !== undefined || cond.ifNoneMatch) this.conditional(err, key);
      throw err;
    }
  }

  async delete(key: string, cond: Pick<Condition, "ifMatch"> = {}): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key, ...(cond.ifMatch !== undefined && { IfMatch: cond.ifMatch }) }));
    } catch (err) {
      if (cond.ifMatch !== undefined) this.conditional(err, key);
      throw err;
    }
  }

  async list(prefix: string, opts: { delimiter?: string } = {}): Promise<ListResult> {
    const keys: string[] = [];
    const prefixes: string[] = [];
    let token: string | undefined;
    do {
      const out = (await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ...(opts.delimiter && { Delimiter: opts.delimiter }), ...(token && { ContinuationToken: token }) }),
      )) as { Contents?: { Key?: string }[]; CommonPrefixes?: { Prefix?: string }[]; IsTruncated?: boolean; NextContinuationToken?: string };
      for (const c of out.Contents ?? []) if (c.Key) keys.push(c.Key);
      for (const p of out.CommonPrefixes ?? []) if (p.Prefix) prefixes.push(p.Prefix);
      token = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (token);
    return { keys, prefixes };
  }
}
