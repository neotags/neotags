export interface OnyxDocument {
  id: string;
  semantic_identifier: string;
  sections: { text: string; link?: string }[];
  metadata: Record<string, string | string[]>;
  doc_updated_at?: string;
}

export interface OnyxClient {
  /** Create or replace the document with this id. */
  upsert(doc: OnyxDocument): Promise<{ alreadyExisted: boolean }>;
  delete(id: string): Promise<void>;
}

export class OnyxError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "OnyxError";
  }
}

export interface OnyxSettings {
  baseUrl: string;
  ingestionPath: string;
  ccPairId: number;
  apiKey?: string;
  timeoutMs?: number;
}

/** Onyx ingestion API (`POST {path}` upsert, `DELETE {path}/{id}`); needs a key with MANAGE_CONNECTORS. */
export class HttpOnyxClient implements OnyxClient {
  private base: string;

  constructor(
    private s: OnyxSettings,
    private fetchImpl: typeof fetch = fetch,
  ) {
    this.base = s.baseUrl.replace(/\/+$/, "") + "/" + s.ingestionPath.replace(/^\/+|\/+$/g, "");
  }

  private async call(url: string, init: RequestInit): Promise<Response> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.s.apiKey) headers.authorization = `Bearer ${this.s.apiKey}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        ...init,
        headers,
        signal: AbortSignal.timeout(this.s.timeoutMs ?? 30_000),
      });
    } catch (err) {
      throw new OnyxError(`Onyx request failed: ${(err as Error).message}`);
    }
    if (!res.ok) {
      // Short body slice for debugging; the request (and key) is never echoed.
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      throw new OnyxError(`Onyx returned ${res.status}: ${detail}`, res.status);
    }
    return res;
  }

  async upsert(doc: OnyxDocument): Promise<{ alreadyExisted: boolean }> {
    const res = await this.call(this.base, {
      method: "POST",
      body: JSON.stringify({ document: doc, cc_pair_id: this.s.ccPairId }),
    });
    const j = (await res.json().catch(() => ({}))) as { already_existed?: boolean };
    return { alreadyExisted: j.already_existed === true };
  }

  async delete(id: string): Promise<void> {
    await this.call(`${this.base}/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
}
