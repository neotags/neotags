export interface OnyxDocument {
  id: string;
  semantic_identifier: string;
  sections: { text: string; link?: string }[];
  metadata: Record<string, string | string[]>;
  doc_updated_at?: string;
}

export interface OnyxSearchResult {
  title: string;
  /** The chunk text the retriever matched. */
  content: string;
  link?: string;
  /** Onyx's own ranking is kept: index 0 is the best match. */
  updatedAt?: string;
}

export interface OnyxClient {
  /** Create or replace the document with this id. */
  upsert(doc: OnyxDocument): Promise<{ alreadyExisted: boolean }>;
  delete(id: string): Promise<void>;
  /** Ranked sections for a question (hybrid retrieval, filtered by the key's document permissions). */
  search(query: string, limit: number): Promise<OnyxSearchResult[]>;
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
  /** Onyx search API (`POST {path}` with `{query}`); needs READ_SEARCH. */
  searchPath?: string;
  ccPairId: number;
  apiKey?: string;
  timeoutMs?: number;
}

/** Onyx ingestion API (`POST {path}` upsert, `DELETE {path}/{id}`); needs a key with MANAGE_CONNECTORS. */
export class HttpOnyxClient implements OnyxClient {
  private base: string;
  private searchUrl: string;

  constructor(
    private s: OnyxSettings,
    private fetchImpl: typeof fetch = fetch,
  ) {
    this.base = s.baseUrl.replace(/\/+$/, "") + "/" + s.ingestionPath.replace(/^\/+|\/+$/g, "");
    this.searchUrl = s.baseUrl.replace(/\/+$/, "") + "/" + (s.searchPath ?? "/api/search").replace(/^\/+|\/+$/g, "");
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

  async search(query: string, limit: number): Promise<OnyxSearchResult[]> {
    // Onyx rejects queries over 2048 characters.
    const res = await this.call(this.searchUrl, { method: "POST", body: JSON.stringify({ query: query.slice(0, 2048) }) });
    const j = (await res.json().catch(() => ({}))) as {
      results?: { title?: string; content?: string; link?: string | null; updated_at?: string | null }[];
    };
    return (j.results ?? [])
      .filter((r) => r.content)
      .slice(0, limit)
      .map((r) => ({
        title: r.title || "Untitled",
        content: r.content!,
        ...(r.link && { link: r.link }),
        ...(r.updated_at && { updatedAt: r.updated_at }),
      }));
  }
}
