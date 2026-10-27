import { getPref } from "../utils/prefs";
import { endpointToBase, getConfiguredMirrorBases, scidbUrl } from "./mirrors";
import { isBotCheckHtml } from "./scidbHtml";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const MD5_RE = /\/md5\/([a-f0-9]{32})\b/i;
const DOMAIN_INDEXES = [1, 2, 3, 0];

export class MemberApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemberApiError";
  }
}

export interface FastDownloadResult {
  url: string;
  md5: string;
  origin: string;
  downloadsLeft?: number;
}

/** Remember which partner actually resolved; index 0 is often a dead host. */
let lastGoodDomainIndex = 1;

export function getMembershipKey(): string {
  return String(getPref("secretKey") || "").trim();
}

function makeCookieSandbox(origin: string): any | undefined {
  try {
    const Ctor = (Zotero as any).CookieSandbox;
    if (typeof Ctor !== "function") return undefined;
    return new Ctor(null, `${origin}/`, "", USER_AGENT);
  } catch {
    return undefined;
  }
}

function requestOpts(extra: Record<string, unknown> = {}) {
  const { headers: extraHeaders, ...rest } = extra;
  return {
    successCodes: false as const,
    timeout: 30000,
    ...rest,
    headers: {
      "User-Agent": USER_AGENT,
      Accept:
        "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
      ...((extraHeaders as Record<string, string>) || {}),
    },
  };
}

async function http(
  method: string,
  url: string,
  opts: Record<string, unknown> = {},
) {
  return Zotero.HTTP.request(method, url, requestOpts(opts));
}

async function login(origin: string, key: string, cookieSandbox?: any) {
  await http("POST", `${origin}/account/`, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `key=${encodeURIComponent(key)}`,
    cookieSandbox,
  });
}

function extractMd5(html: string, doi?: string): string | null {
  if (isBotCheckHtml(html)) return null;
  if (doi) {
    const escaped = doi.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const near = html.match(
      new RegExp(
        `/md5/([a-f0-9]{32})[\\s\\S]{0,2500}${escaped}|${escaped}[\\s\\S]{0,2500}/md5/([a-f0-9]{32})`,
        "i",
      ),
    );
    const hit = near?.[1] || near?.[2];
    if (hit) return hit.toLowerCase();
  }
  const match = html.match(MD5_RE);
  return match ? match[1].toLowerCase() : null;
}

async function fetchHtml(
  url: string,
  cookieSandbox?: any,
): Promise<{ html: string; finalUrl: string; status: number }> {
  const xhr = await http("GET", url, {
    responseType: "text",
    cookieSandbox,
  });
  const html = String(xhr.responseText || xhr.response || "");
  const finalUrl = String((xhr as any).responseURL || url);
  return { html, finalUrl, status: xhr.status };
}

async function resolveMd5FromOrigin(
  origin: string,
  doi: string,
  key: string,
): Promise<string> {
  const cookieSandbox = makeCookieSandbox(origin);
  try {
    await login(origin, key, cookieSandbox);
  } catch (error) {
    ztoolkit.log(
      `Member login failed on ${new URL(origin).host}:`,
      String((error as Error)?.message || error),
    );
  }

  const sci = await fetchHtml(scidbUrl(origin, doi), cookieSandbox);
  if (
    sci.status === 200 &&
    !/[?&]check=1\b/.test(sci.finalUrl) &&
    !isBotCheckHtml(sci.html)
  ) {
    const md5 = extractMd5(sci.html, doi);
    if (md5) return md5;
  }

  const journals = await fetchHtml(
    `${origin}/search?index=journals&q=${encodeURIComponent(doi)}`,
    cookieSandbox,
  );
  if (
    journals.status === 200 &&
    !/[?&]check=1\b/.test(journals.finalUrl) &&
    !isBotCheckHtml(journals.html)
  ) {
    const md5 = extractMd5(journals.html, doi);
    if (md5) return md5;
  }

  throw new MemberApiError(`No MD5 for DOI ${doi} on ${new URL(origin).host}`);
}

function parseFastDownload(xhr: XMLHttpRequest): {
  url: string;
  downloadsLeft?: number;
  error?: string;
} {
  let data: any = xhr.response;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      data = {};
    }
  }
  if (!data || typeof data !== "object") data = {};
  const url = String(data.download_url || "");
  const info = data.account_fast_download_info;
  const downloadsLeft =
    typeof info?.downloads_left === "number" ? info.downloads_left : undefined;
  const error = data.error ? String(data.error) : undefined;
  return { url, downloadsLeft, error };
}

async function urlServesPdf(url: string): Promise<boolean> {
  try {
    const xhr = await http("GET", url, {
      headers: {
        Range: "bytes=0-7",
        Accept: "application/pdf,*/*",
      },
      responseType: "text",
      timeout: 8000,
    });
    if (xhr.status !== 200 && xhr.status !== 206) return false;
    const head = String(xhr.responseText || xhr.response || "").slice(0, 4);
    return head === "%PDF";
  } catch (error) {
    ztoolkit.log(
      "Member PDF probe failed:",
      String((error as Error)?.message || error),
    );
    return false;
  }
}

async function fastDownloadUrl(
  origin: string,
  md5: string,
  key: string,
): Promise<{ url: string; downloadsLeft?: number }> {
  const indexes = [
    lastGoodDomainIndex,
    ...DOMAIN_INDEXES.filter((index) => index !== lastGoodDomainIndex),
  ];
  let lastError: unknown;
  let downloadsLeft: number | undefined;

  for (const domainIndex of indexes) {
    const api = new URL(`${origin}/dyn/api/fast_download.json`);
    api.searchParams.set("md5", md5);
    api.searchParams.set("key", key);
    api.searchParams.set("path_index", "0");
    api.searchParams.set("domain_index", String(domainIndex));

    let parsed: { url: string; downloadsLeft?: number; error?: string };
    try {
      const xhr = await http("GET", api.href, {
        headers: { Accept: "application/json" },
        responseType: "json",
      });
      parsed = parseFastDownload(xhr);
    } catch (error) {
      lastError = error;
      continue;
    }

    if (typeof parsed.downloadsLeft === "number") {
      downloadsLeft = parsed.downloadsLeft;
    }
    if (parsed.error) {
      lastError = new MemberApiError(parsed.error);
      continue;
    }
    if (!parsed.url) {
      lastError = new MemberApiError(
        `Member API returned no download URL for domain_index=${domainIndex}`,
      );
      continue;
    }

    let hostname: string;
    try {
      hostname = new URL(parsed.url).hostname;
    } catch {
      lastError = new MemberApiError("Member API returned an invalid URL");
      continue;
    }

    if (!(await urlServesPdf(parsed.url))) {
      ztoolkit.log(
        `Member partner ${hostname} did not serve a PDF; trying next domain_index`,
      );
      lastError = new MemberApiError(`Partner ${hostname} did not serve a PDF`);
      continue;
    }

    lastGoodDomainIndex = domainIndex;
    ztoolkit.log(
      `Member fast-download ready via ${hostname} (domain_index=${domainIndex})`,
    );
    return { url: parsed.url, downloadsLeft };
  }

  throw lastError instanceof Error
    ? lastError
    : new MemberApiError("No working member download partner");
}

/**
 * Resolve a DOI to a direct member fast-download URL.
 * MD5 comes from SciDB (the API does not accept a DOI).
 * Quota is spent per domain_index tried until a live partner is found.
 */
export async function resolveMemberFastDownload(
  doi: string,
  preferredEndpoint: string,
): Promise<FastDownloadResult> {
  const key = getMembershipKey();
  if (!key) {
    throw new MemberApiError("No membership key configured");
  }

  const origins = getConfiguredMirrorBases(preferredEndpoint);
  let lastError: unknown;
  let md5: string | null = null;
  let originUsed = origins[0];

  for (const origin of origins) {
    const base = endpointToBase(origin);
    try {
      md5 = await resolveMd5FromOrigin(base, doi, key);
      originUsed = base;
      ztoolkit.log(`Member MD5 ${md5} from ${new URL(base).host}`);
      break;
    } catch (error) {
      lastError = error;
      ztoolkit.log(
        `Member MD5 lookup failed on ${new URL(base).host}:`,
        String((error as Error)?.message || error),
      );
    }
  }

  if (!md5) {
    throw lastError instanceof Error
      ? lastError
      : new MemberApiError("Could not resolve DOI to an MD5");
  }

  const { url, downloadsLeft } = await fastDownloadUrl(originUsed, md5, key);
  return { url, md5, origin: originUsed, downloadsLeft };
}
