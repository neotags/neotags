import type { Config } from "../config/index.js";
import { DeliveryError, type DeliveryContext, type DeliveryResult } from "../routines/outbox.js";
import { redact } from "../tools/redact.js";
import type { Bundle } from "./bundle.js";

// Confluence delivery (S-D10), Confluence Cloud REST v2 (v1 for attachments, which v2 cannot upload). Steps, each
// recorded as it is done: check that the parent is in the configured space, find or create the month's folder
// (monthlyFolder), create the page, upload each attachment. A retry goes on from the recorded steps: a page already
// created only gets its missing attachments.

const TIMEOUT_MS = 60_000;
const UPLOAD_TIMEOUT_MS = 120_000;

export class ConfluenceError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ConfluenceError";
  }
}

interface Content {
  id: string;
  title?: string;
  type?: string;
  spaceId?: string;
  parentId?: string;
  _links?: { webui?: string; next?: string };
}

/** A small Confluence client: Basic auth with the account's email and API token. */
export class ConfluenceApi {
  readonly base: string;
  private auth: string;
  private fetch: typeof fetch;

  constructor(o: { baseUrl: string; email: string; token: string; fetch?: typeof fetch }) {
    this.base = o.baseUrl.replace(/\/+$/, "");
    this.auth = `Basic ${Buffer.from(`${o.email}:${o.token}`).toString("base64")}`;
    this.fetch = o.fetch ?? fetch;
  }

  private async req<T>(method: string, path: string, o: { body?: unknown; form?: FormData; signal?: AbortSignal; quiet404?: boolean; timeoutMs?: number } = {}): Promise<T | undefined> {
    const headers: Record<string, string> = { authorization: this.auth, accept: "application/json" };
    if (o.body !== undefined) headers["content-type"] = "application/json";
    // Attachment uploads are refused without it (XSRF check).
    if (o.form) headers["x-atlassian-token"] = "no-check";
    const timeout = AbortSignal.timeout(o.timeoutMs ?? TIMEOUT_MS);
    const res = await this.fetch(this.base + path, {
      method,
      headers,
      ...(o.body !== undefined && { body: JSON.stringify(o.body) }),
      ...(o.form && { body: o.form }),
      signal: o.signal ? AbortSignal.any([o.signal, timeout]) : timeout,
    });
    if (res.status === 404 && o.quiet404) {
      // Unread, the body would hold the connection until it is collected.
      await res.body?.cancel().catch(() => {});
      return undefined;
    }
    const text = await res.text();
    if (!res.ok) {
      // Error bodies can echo what was sent; never the credentials, but redact like any tool output.
      throw new ConfluenceError(res.status, `${method} ${path.split("?")[0]}: HTTP ${res.status}: ${redact(text.slice(0, 300)).text}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** Space keys -> ids. */
  async spaceIds(keys: string[], signal?: AbortSignal): Promise<Map<string, string>> {
    const r = await this.req<{ results?: { id: string; key: string }[] }>("GET", `/api/v2/spaces?${new URLSearchParams({ keys: keys.join(","), limit: "250" })}`, { signal });
    return new Map((r?.results ?? []).map((s) => [s.key, String(s.id)]));
  }

  /** A folder or a page by id, and which it is; undefined when neither (or no access). */
  async container(id: string, signal?: AbortSignal): Promise<{ kind: "folders" | "pages"; obj: Content } | undefined> {
    for (const kind of ["folders", "pages"] as const) {
      const obj = await this.req<Content>("GET", `/api/v2/${kind}/${encodeURIComponent(id)}`, { signal, quiet404: true });
      if (obj) return { kind, obj };
    }
    return undefined;
  }

  /** Direct children of a folder or page, all pages of the listing. */
  async children(kind: "folders" | "pages", id: string, signal?: AbortSignal): Promise<Content[]> {
    const out: Content[] = [];
    let cursor: string | undefined;
    for (;;) {
      const q = new URLSearchParams({ limit: "250", ...(cursor && { cursor }) });
      const r = await this.req<{ results?: Content[]; _links?: { next?: string } }>("GET", `/api/v2/${kind}/${encodeURIComponent(id)}/direct-children?${q}`, { signal });
      out.push(...(r?.results ?? []));
      const next = r?._links?.next;
      cursor = next ? (new URL(next, "https://x.invalid").searchParams.get("cursor") ?? undefined) : undefined;
      if (!cursor) return out;
    }
  }

  createFolder(spaceId: string, parentId: string, title: string, signal?: AbortSignal): Promise<Content> {
    return this.req<Content>("POST", "/api/v2/folders", { body: { spaceId, title, parentId }, signal }) as Promise<Content>;
  }

  async pagesTitled(spaceId: string, title: string, signal?: AbortSignal): Promise<Content[]> {
    const r = await this.req<{ results?: Content[] }>("GET", `/api/v2/pages?${new URLSearchParams({ "space-id": spaceId, title })}`, { signal });
    return r?.results ?? [];
  }

  async createPage(p: { spaceId: string; parentId: string; title: string; body: string }, signal?: AbortSignal): Promise<Content> {
    const page = (await this.req<Content>("POST", "/api/v2/pages", {
      body: { spaceId: p.spaceId, status: "current", title: p.title, parentId: p.parentId, body: { representation: "storage", value: p.body } },
      signal,
    }))!;
    return page;
  }

  async fullWidth(pageId: string, signal?: AbortSignal): Promise<void> {
    for (const key of ["content-appearance-published", "content-appearance-draft"]) {
      await this.req("POST", `/api/v2/pages/${encodeURIComponent(pageId)}/properties`, { body: { key, value: "full-width" }, signal });
    }
  }

  pageUrl(page: Content): string {
    return page._links?.webui ? this.base + page._links.webui : `${this.base}/pages/viewpage.action?pageId=${page.id}`;
  }

  /** Upload a text attachment; one of the same name already there gets a new version. Returns its id. */
  async attach(pageId: string, name: string, content: string, signal?: AbortSignal): Promise<string | undefined> {
    const base = `/rest/api/content/${encodeURIComponent(pageId)}/child/attachment`;
    const old = await this.req<{ results?: { id: string }[] }>("GET", `${base}?${new URLSearchParams({ filename: name })}`, { signal });
    const id = old?.results?.[0]?.id;
    const form = new FormData();
    form.append("file", new Blob([content], { type: contentType(name) }), name);
    form.append("minorEdit", "true");
    const r = await this.req<{ id?: string; results?: { id?: string }[] }>("POST", id ? `${base}/${encodeURIComponent(id)}/data` : base, { form, signal, timeoutMs: UPLOAD_TIMEOUT_MS });
    return r?.results?.[0]?.id ?? r?.id ?? id;
  }
}

function contentType(name: string): string {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  const t = ({ html: "text/html", htm: "text/html", xml: "application/xml", md: "text/markdown", json: "application/json", csv: "text/csv" } as Record<string, string>)[ext];
  return `${t ?? "text/plain"}; charset=utf-8`;
}

export interface ConfluenceDetail {
  parent: string;
  spaceId?: string;
  folder?: { id: string; title: string };
  /** The title being created, recorded first: a retry takes a page of this title under the parent as its own. */
  pendingTitle?: string;
  page?: { id: string; url: string; title: string; at: string };
  attachments: Record<string, { id?: string; at: string }>;
  /** A dry run without outbox.confluence.testParent. */
  skipped?: string;
}

type Target = NonNullable<Config["routines"][string]["delivery"]["confluence"]>;

/** The period's month (YYYY-MM) in the routine's time zone: the folder a monthly page goes in. */
export function periodMonth(period: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit" }).formatToParts(new Date(period));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}`;
}

function clock(period: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(period));
}

export async function deliverConfluence(
  api: ConfluenceApi | undefined,
  cfg: Pick<Config, "outbox">,
  t: Target,
  timeZone: string,
  bundle: Bundle,
  ctx: DeliveryContext,
  did: (step: string) => void,
  warn: (obj: object, msg: string) => void,
): Promise<DeliveryResult> {
  const out = cfg.outbox.confluence;
  if (!out) throw new DeliveryError("config", "Confluence delivery needs outbox.confluence");
  if (ctx.dryRun && !out.testParent) return { detail: { parent: t.parent, attachments: {}, skipped: "dry run without outbox.confluence.testParent" } satisfies ConfluenceDetail };
  if (!api) throw new DeliveryError("config", "no Confluence credentials (CONFLUENCE_EMAIL, CONFLUENCE_WRITE_TOKEN)");
  const parent = ctx.dryRun ? out.testParent! : t.parent;
  // On a dry run the test parent may be in any allowed space; otherwise it must be in the configured one.
  const spaces = ctx.dryRun ? out.allowedSpaces : [t.space];
  if (!spaces.every((s) => out.allowedSpaces.includes(s))) throw new DeliveryError("allowlist", `space ${t.space} is not in outbox.confluence.allowedSpaces`);
  const page = await bundle.page();
  if (!page) throw new DeliveryError("bundle", "the bundle has no Confluence page");
  const prev = ctx.previous?.detail as Partial<ConfluenceDetail> | undefined;
  const same = prev?.parent === parent;
  const detail: ConfluenceDetail = {
    parent,
    ...(same && prev?.spaceId && { spaceId: prev.spaceId }),
    ...(same && prev?.folder && { folder: prev.folder }),
    ...(same && prev?.page && { page: prev.page }),
    ...(same && prev?.pendingTitle && { pendingTitle: prev.pendingTitle }),
    attachments: same ? { ...prev?.attachments } : {},
  };
  const { signal } = ctx;
  const step = async <T>(name: string, fn: () => Promise<T>, label = name): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof DeliveryError || signal.aborted) throw err;
      throw new DeliveryError(name, `${label}: ${err instanceof Error ? err.message : String(err)}`, detail);
    }
  };

  if (!detail.page) {
    // The parent must really be in the space the allowlist was checked against: a parent id is only a number.
    const where = await step("parent", async () => {
      const ids = await api.spaceIds(spaces, signal);
      const c = await api.container(parent, signal);
      if (!c) throw new DeliveryError("parent", `parent ${parent} is neither a folder nor a page, or not visible to the account`, detail);
      const spaceId = String(c.obj.spaceId ?? "");
      const key = [...ids].find(([, id]) => id === spaceId)?.[0];
      if (!key) throw new DeliveryError("parent", `parent ${parent} is not in space ${spaces.join(", ")}`, detail);
      return { ...c, spaceId };
    });
    detail.spaceId = where.spaceId;
    let under = parent;
    if (t.monthlyFolder) {
      const title = periodMonth(ctx.period, timeZone);
      if (!detail.folder || detail.folder.title !== title) {
        const found = await step("folder", async () => (await api.children(where.kind, parent, signal)).find((x) => x.type === "folder" && x.title === title));
        if (found) detail.folder = { id: String(found.id), title };
        else {
          await ctx.confirm();
          const f = await step("folder", () => api.createFolder(where.spaceId, parent, title, signal));
          detail.folder = { id: String(f.id), title };
          did("folder");
          await ctx.progress(detail);
        }
      }
      under = detail.folder.id;
    }
    // An earlier attempt recorded the title it was creating, then could not record the page (its answer lost, the Pod
    // gone): a page of that title under the same parent is that one. Never taken by title alone: another period's
    // page can have the same title.
    const pending = detail.pendingTitle;
    const found = pending ? await step("page", async () => (await api.pagesTitled(where.spaceId, pending, signal)).find((p) => String(p.parentId) === under)) : undefined;
    let made: { page: Awaited<ReturnType<ConfluenceApi["createPage"]>>; title: string };
    if (found && pending) made = { page: found, title: pending };
    else {
      // Titles are unique per space: one taken (another page, another period's) gets the time, then the period.
      const title = await step("page", async () => {
        for (const t of [page.title, `${page.title} ${clock(ctx.period, timeZone)}`, `${page.title} (${ctx.period})`]) {
          if ((await api.pagesTitled(where.spaceId, t, signal)).length === 0) return t;
        }
        throw new Error(`the titles ${JSON.stringify(page.title)} with the time and the period are all taken in the space`);
      });
      detail.pendingTitle = title;
      await ctx.progress(detail);
      await ctx.confirm();
      made = { page: await step("page", () => api.createPage({ spaceId: where.spaceId, parentId: under, title, body: page.body }, signal)), title };
      did("page");
    }
    delete detail.pendingTitle;
    detail.page = { id: String(made.page.id), url: api.pageUrl(made.page), title: made.title, at: new Date().toISOString() };
    await ctx.progress(detail);
    try {
      // Also for a page an earlier attempt created: it may have died before this.
      await api.fullWidth(detail.page.id, signal);
    } catch (err) {
      // Only the page's width.
      warn({ routine: ctx.routine, period: ctx.period, page: detail.page.id, err: (err as Error).message }, "could not make the Confluence page full width");
    }
  }
  const pageId = detail.page.id;
  for (const [name, content] of Object.entries(page.attachments)) {
    if (detail.attachments[name]) continue;
    await ctx.confirm();
    const id = await step("attachment", () => api.attach(pageId, name, content, signal), `attachment ${name}`);
    detail.attachments[name] = { ...(id && { id }), at: new Date().toISOString() };
    did(`attachment:${name}`);
    await ctx.progress(detail);
  }
  return { link: detail.page.url, detail };
}
