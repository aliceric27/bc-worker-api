type Env = {
  SHEET_ID?: string;
  DEFAULT_GID?: string;
  CACHE_TTL_SECONDS?: string;
  TABS_JSON?: string;
  COMMENTS_GID?: string;
};

type Tab = {
  key: string;
  name: string;
  gid: string;
};

const DEFAULT_TABS: Tab[] = [
  { key: "taipei", name: "台北", gid: "0" },
  { key: "taichung", name: "台中", gid: "687894271" },
  { key: "kaohsiung", name: "高雄", gid: "33705333" },
  { key: "tainan", name: "台南", gid: "2140061499" },
  { key: "overseas", name: "海外", gid: "191713228" },
];

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function getPathSegments(pathname: string): string[] {
  return pathname
    .split("/")
    .filter(Boolean)
    .map((s) => safeDecodeURIComponent(s));
}

function loadTabs(env: Env): Tab[] {
  const raw = env.TABS_JSON?.trim();
  if (!raw) return DEFAULT_TABS;

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_TABS;

    const tabs: Tab[] = [];
    const seen = new Set<string>();
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const key = String((item as any).key ?? "").trim();
      const name = String((item as any).name ?? "").trim();
      const gid = String((item as any).gid ?? "").trim();
      if (!key || !name || !gid) continue;
      const normalizedKey = key.toLowerCase();
      if (seen.has(normalizedKey)) continue;
      seen.add(normalizedKey);
      tabs.push({ key, name, gid });
    }

    return tabs.length > 0 ? tabs : DEFAULT_TABS;
  } catch {
    return DEFAULT_TABS;
  }
}

function jsonResponse(
  body: unknown,
  init?: ResponseInit & { pretty?: boolean },
): Response {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  const pretty = init?.pretty ?? false;
  const text = pretty ? JSON.stringify(body, null, 2) : JSON.stringify(body);
  return new Response(text, { ...init, headers });
}

function textResponse(text: string, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(text, { ...init, headers });
}

function buildCsvExportUrl(sheetId: string, gid: string): string {
  const url = new URL(`https://docs.google.com/spreadsheets/d/${sheetId}/export`);
  url.searchParams.set("format", "csv");
  url.searchParams.set("gid", gid);
  return url.toString();
}

function parsePositiveInt(value: string | null): number | null {
  if (!value) return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normalizeString(value: string): string {
  return value.trim().toLowerCase();
}

function isCommentsKey(value: string): boolean {
  const k = normalizeString(value);
  return k === "comments" || k === "comment" || k === "留言區" || k === "留言";
}

function parseCsv(csvText: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < csvText.length; i++) {
    const ch = csvText[i];

    if (inQuotes) {
      if (ch === '"') {
        const next = csvText[i + 1];
        if (next === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }

    if (ch === ",") {
      row.push(cell);
      cell = "";
      continue;
    }

    if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    if (ch === "\r") {
      continue;
    }

    cell += ch;
  }

  // Flush last cell/row (even if the file doesn't end with newline).
  row.push(cell);
  if (row.length > 1 || row[0] !== "" || rows.length === 0) rows.push(row);

  return rows;
}

function trimBom(value: string): string {
  // Remove UTF-8 BOM if present.
  return value.replace(/^\uFEFF/, "");
}

function countNonEmpty(cells: string[]): number {
  let count = 0;
  for (const c of cells) if (c.trim() !== "") count++;
  return count;
}

function inferHeaderRowIndex(rows: string[][]): number {
  const maxScan = Math.min(rows.length, 30);

  for (let i = 0; i < maxScan; i++) {
    const set = new Set(rows[i].map((c) => c.trim()));
    if (set.has("公司名稱") && set.has("集團名稱")) return i;
  }

  // Fallback: pick the row with the most non-empty cells in the first N rows.
  let bestIndex = 0;
  let bestScore = -1;
  for (let i = 0; i < maxScan; i++) {
    const score = countNonEmpty(rows[i]);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }
  return bestIndex;
}

function normalizeHeaders(headerRow: string[]): { headers: string[]; indexes: number[] } {
  const headers: string[] = [];
  const indexes: number[] = [];

  for (let i = 0; i < headerRow.length; i++) {
    const raw = i === 0 ? trimBom(headerRow[i]) : headerRow[i];
    const name = raw.trim();
    if (!name) continue;
    headers.push(name);
    indexes.push(i);
  }

  return { headers, indexes };
}

function rowToObject(
  row: string[],
  headers: string[],
  indexes: number[],
  omitEmpty: boolean,
): Record<string, string> {
  const obj: Record<string, string> = {};
  for (let i = 0; i < headers.length; i++) {
    const colIndex = indexes[i];
    const value = (row[colIndex] ?? "").trim();
    if (omitEmpty && value === "") continue;
    obj[headers[i]] = value;
  }
  return obj;
}

function isObjectEmpty(obj: Record<string, unknown>): boolean {
  for (const _k in obj) return false;
  return true;
}

async function fetchUpstreamCsvText(
  csvUrl: string,
  cacheTtlSeconds: number,
): Promise<
  | { ok: true; text: string }
  | { ok: false; status?: number; message: string; details?: string }
> {
  let upstream: Response;
  try {
    upstream = await fetch(csvUrl, {
      headers: { Accept: "text/csv" },
      cf: { cacheTtl: cacheTtlSeconds, cacheEverything: true },
    } as RequestInit);
  } catch (e: any) {
    return {
      ok: false,
      message: "Failed to fetch upstream CSV",
      details: String(e?.message ?? e),
    };
  }

  if (!upstream.ok) {
    return {
      ok: false,
      message: "Upstream returned non-200",
      status: upstream.status,
    };
  }

  return { ok: true, text: await upstream.text() };
}

function parseSheetCsv(
  csvText: string,
  options: { omitEmpty: boolean; limit: number | null; headerRowOverride: number | null },
): {
  preamble: string[][];
  headers: string[];
  items: Array<Record<string, string>>;
  headerRow: number;
} {
  const rows = parseCsv(csvText);
  const headerRowIndex =
    options.headerRowOverride !== null
      ? Math.max(1, options.headerRowOverride) - 1
      : inferHeaderRowIndex(rows);

  const headerRow = rows[headerRowIndex] ?? [];
  const { headers, indexes } = normalizeHeaders(headerRow);

  const preamble = rows
    .slice(0, headerRowIndex)
    .map((r) => r.map((c) => c.trim()).filter((c) => c !== ""))
    .filter((r) => r.length > 0);

  const dataRows = rows.slice(headerRowIndex + 1);
  const items: Array<Record<string, string>> = [];

  for (const r of dataRows) {
    const obj = rowToObject(r, headers, indexes, options.omitEmpty);
    if (isObjectEmpty(obj)) continue;
    items.push(obj);
    if (options.limit !== null && items.length >= options.limit) break;
  }

  return { preamble, headers, items, headerRow: headerRowIndex + 1 };
}

export default {
  async fetch(request: Request, env: Env, ctx: any): Promise<Response> {
    if (request.method === "OPTIONS") {
      return textResponse("", { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== "GET") {
      return jsonResponse(
        { ok: false, error: { message: "Method Not Allowed" } },
        { status: 405 },
      );
    }

    const url = new URL(request.url);

    const cache = caches.default;
    const cacheKey = new Request(url.toString(), { method: "GET" });
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    const sheetId = env.SHEET_ID ?? "1vFsVN641zHiyOVjo0n_JtrHgpH2SCHT7n9__FnbcskE";
    const cacheTtlSeconds =
      Number.parseInt(env.CACHE_TTL_SECONDS ?? "300", 10) || 300;

    const tabs = loadTabs(env);
    const pathSegments = getPathSegments(url.pathname);

    const pretty = url.searchParams.get("pretty") === "1";
    const omitEmpty = url.searchParams.get("omitEmpty") !== "0";
    const limit = parsePositiveInt(url.searchParams.get("limit"));
    const headerRowOverride = parsePositiveInt(url.searchParams.get("headerRow"));
    const shape = url.searchParams.get("shape") ?? "full";
    const withTab = url.searchParams.get("withTab") === "1";

    if (pathSegments.length === 1 && pathSegments[0] === "tabs") {
      const resp = jsonResponse(
        { ok: true, tabs },
        {
          status: 200,
          pretty,
          headers: { "Cache-Control": `public, max-age=0, s-maxage=${cacheTtlSeconds}` },
        },
      );
      ctx?.waitUntil?.(cache.put(cacheKey, resp.clone()));
      return resp;
    }

    let wantCsv = url.searchParams.get("format") === "csv";
    const workingSegments = [...pathSegments];
    if (workingSegments[0] === "raw") {
      wantCsv = true;
      workingSegments.shift();
    }

    let selectedTab: Tab | null = null;
    let selectedGid: string | null = url.searchParams.get("gid");

    const commentsGid = env.COMMENTS_GID ?? "819189250";
    if (workingSegments.length > 0) {
      const seg = workingSegments[0];
      const isCsvPath = seg.endsWith(".csv");
      if (isCsvPath) wantCsv = true;
      const base = isCsvPath ? seg.slice(0, -4) : seg;
      if (isCommentsKey(base)) {
        selectedGid = commentsGid;
        selectedTab = { key: "comments", name: "留言區", gid: commentsGid };
      }
    }

    const tabParam = url.searchParams.get("tab");
    if (!selectedGid && tabParam) {
      const tabLookup = normalizeString(tabParam);
      selectedTab =
        tabs.find(
          (t) =>
            normalizeString(t.key) === tabLookup || normalizeString(t.name) === tabLookup,
        ) ?? null;
      if (selectedTab) selectedGid = selectedTab.gid;
    }

    if (!selectedGid && workingSegments.length > 0) {
      let key = workingSegments[0];
      if (key.endsWith(".csv")) {
        wantCsv = true;
        key = key.slice(0, -4);
      }
      const keyLookup = normalizeString(key);
      selectedTab =
        tabs.find(
          (t) =>
            normalizeString(t.key) === keyLookup || normalizeString(t.name) === keyLookup,
        ) ?? null;
      if (selectedTab) selectedGid = selectedTab.gid;
    }

    const mergeParam = url.searchParams.get("merge");
    let merge =
      mergeParam === "1" ? true : mergeParam === "0" ? false : selectedGid === null;

    const tabsParam = url.searchParams.get("tabs");
    let mergeTabs = tabs;
    if (tabsParam) {
      const requested = new Set(
        tabsParam
          .split(",")
          .map((s) => normalizeString(s))
          .filter((s) => s !== ""),
      );
      const subset = tabs.filter(
        (t) => requested.has(normalizeString(t.key)) || requested.has(normalizeString(t.name)),
      );
      if (subset.length > 0) mergeTabs = subset;
    }

    if (wantCsv && merge) {
      return jsonResponse(
        {
          ok: false,
          error: {
            message:
              "Merged CSV is not supported. Please specify a tab via /<key>, ?gid=, or ?tab=.",
          },
        },
        { status: 400, pretty },
      );
    }

    if (!merge) {
      const gid = selectedGid ?? env.DEFAULT_GID ?? "0";
      const resolvedTab = selectedTab ?? tabs.find((t) => t.gid === gid) ?? null;
      const csvUrl = buildCsvExportUrl(sheetId, gid);

      const upstream = await fetchUpstreamCsvText(csvUrl, cacheTtlSeconds);
      if (!upstream.ok) {
        return jsonResponse(
          { ok: false, error: { ...upstream } },
          { status: 502, pretty },
        );
      }

      if (wantCsv) {
        return textResponse(upstream.text, {
          status: 200,
          headers: { "Content-Type": "text/csv; charset=utf-8" },
        });
      }

      let parsed: ReturnType<typeof parseSheetCsv>;
      try {
        parsed = parseSheetCsv(upstream.text, {
          omitEmpty,
          limit,
          headerRowOverride,
        });
      } catch (e: any) {
        return jsonResponse(
          { ok: false, error: { message: "CSV parse failed", details: String(e?.message ?? e) } },
          { status: 500, pretty },
        );
      }

      const fullPayload = {
        ok: true,
        meta: {
          sheetId,
          gid,
          tab: resolvedTab ? { key: resolvedTab.key, name: resolvedTab.name, gid: resolvedTab.gid } : undefined,
          csvUrl,
          fetchedAt: new Date().toISOString(),
          headerRow: parsed.headerRow,
          cacheTtlSeconds,
        },
        preamble: parsed.preamble,
        headers: parsed.headers,
        items: parsed.items,
      };

      const payload = shape === "items" ? parsed.items : fullPayload;

      const resp = jsonResponse(payload, {
        status: 200,
        pretty,
        headers: {
          "Cache-Control": `public, max-age=0, s-maxage=${cacheTtlSeconds}`,
        },
      });

      ctx?.waitUntil?.(cache.put(cacheKey, resp.clone()));
      return resp;
    }

    const upstreamResults = await Promise.all(
      mergeTabs.map(async (t) => {
        const csvUrl = buildCsvExportUrl(sheetId, t.gid);
        const upstream = await fetchUpstreamCsvText(csvUrl, cacheTtlSeconds);
        return { tab: t, csvUrl, upstream };
      }),
    );

    const failures = upstreamResults.filter((r) => !r.upstream.ok);
    if (failures.length > 0) {
      return jsonResponse(
        {
          ok: false,
          error: {
            message: "One or more tabs failed to fetch",
            failures: failures.map((f) => ({
              key: f.tab.key,
              name: f.tab.name,
              gid: f.tab.gid,
              ...(f.upstream.ok ? {} : f.upstream),
            })),
          },
        },
        { status: 502, pretty },
      );
    }

    const tabPayloads: Array<{
      tab: Tab;
      csvUrl: string;
      headerRow: number;
      headers: string[];
      items: Array<Record<string, string>>;
      preamble: string[][];
    }> = [];

    for (const r of upstreamResults) {
      if (!r.upstream.ok) continue;
      let parsed: ReturnType<typeof parseSheetCsv>;
      try {
        parsed = parseSheetCsv(r.upstream.text, {
          omitEmpty,
          limit: null, // apply limit after merge
          headerRowOverride,
        });
      } catch (e: any) {
        return jsonResponse(
          {
            ok: false,
            error: {
              message: "CSV parse failed",
              tab: { key: r.tab.key, name: r.tab.name, gid: r.tab.gid },
              details: String(e?.message ?? e),
            },
          },
          { status: 500, pretty },
        );
      }

      tabPayloads.push({
        tab: r.tab,
        csvUrl: r.csvUrl,
        headerRow: parsed.headerRow,
        headers: parsed.headers,
        items: parsed.items,
        preamble: parsed.preamble,
      });
    }

    const mergedItems: Array<Record<string, string>> = [];
    const headersSet = new Set<string>();

    for (const p of tabPayloads) {
      for (const h of p.headers) headersSet.add(h);
      for (const item of p.items) {
        if (withTab) {
          (item as any).__tab = p.tab.name;
          (item as any).__gid = p.tab.gid;
        }
        mergedItems.push(item);
      }
    }

    const headers = Array.from(headersSet);
    const items = limit !== null ? mergedItems.slice(0, limit) : mergedItems;

    const fullPayload = {
      ok: true,
      meta: {
        sheetId,
        tabs: tabPayloads.map((p) => ({
          key: p.tab.key,
          name: p.tab.name,
          gid: p.tab.gid,
          csvUrl: p.csvUrl,
          headerRow: p.headerRow,
          itemCount: p.items.length,
        })),
        fetchedAt: new Date().toISOString(),
        cacheTtlSeconds,
        merged: true,
      },
      headers,
      items,
    };

    const payload = shape === "items" ? items : fullPayload;

    const resp = jsonResponse(payload, {
      status: 200,
      pretty,
      headers: {
        "Cache-Control": `public, max-age=0, s-maxage=${cacheTtlSeconds}`,
      },
    });

    ctx?.waitUntil?.(cache.put(cacheKey, resp.clone()));
    return resp;
  },
};
