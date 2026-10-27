import { getPref, setPref } from "../utils/prefs";

const MIRROR_CATALOG_URL =
  "https://shadowlibraries.github.io/DirectDownloads/AnnasArchive/";
const MIRROR_HOST_RE = /^https?:\/\/([a-z0-9.-]+)\/?/i;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_MIRROR_BASE = "https://annas-archive.gl";
export const DEFAULT_SCIDB_ENDPOINT = `${DEFAULT_MIRROR_BASE}/scidb/`;

/** Default backup mirror bases (shipped via prefs.js; users can override in Settings). */
export const DEFAULT_BACKUP_MIRRORS = [
  "https://annas-archive.pk",
  "https://annas-archive.gd",
  "https://annas-archive.se",
  "https://annas-archive.li",
];

export const DEFAULT_BACKUP_MIRRORS_TEXT = DEFAULT_BACKUP_MIRRORS.join("\n");

interface MirrorsCache {
  fetchedAt: number;
  mirrors: string[];
}

/**
 * Normalize a preferred endpoint (base or /scidb/ URL) to an origin base.
 */
export function endpointToBase(endpoint: string): string {
  try {
    const url = new URL(endpoint.trim());
    if (!url.protocol.startsWith("http")) {
      return DEFAULT_MIRROR_BASE;
    }
    return url.origin;
  } catch {
    return DEFAULT_MIRROR_BASE;
  }
}

/**
 * Parse a multiline / comma-separated mirror list into origin bases.
 */
export function parseMirrorList(text: string): string[] {
  if (!text?.trim()) return [];
  const parts = text
    .split(/[\n,]+/)
    .map((part) => part.trim())
    .filter(Boolean);

  const seen = new Set<string>();
  const mirrors: string[] = [];
  for (const part of parts) {
    const withScheme = /^https?:\/\//i.test(part) ? part : `https://${part}`;
    try {
      const base = endpointToBase(withScheme);
      if (seen.has(base)) continue;
      seen.add(base);
      mirrors.push(base);
    } catch {
      // skip invalid entries
    }
  }
  return mirrors;
}

/**
 * Build a SciDB DOI lookup URL for a mirror base.
 * Trailing slash matches the working browser form: /scidb/{doi}/
 */
export function scidbUrl(base: string, doi: string): string {
  const origin = endpointToBase(base);
  const cleanDoi = doi.replace(/^\/+|\/+$/g, "");
  // Keep DOI slashes literal (SciDB keys by unescaped DOI path)
  return `${origin}/scidb/${cleanDoi}/`;
}

export function getConfiguredBackupMirrors(): string[] {
  const raw = getPref("backupMirrors");
  // Missing pref → shipped defaults; empty string → user cleared backups
  if (raw === undefined || raw === null) {
    return [...DEFAULT_BACKUP_MIRRORS];
  }
  return parseMirrorList(String(raw));
}

function readCache(): MirrorsCache | null {
  const raw = getPref("mirrorsCache") as string;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as MirrorsCache;
    if (!parsed?.mirrors?.length || !parsed.fetchedAt) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(mirrors: string[]) {
  const payload: MirrorsCache = {
    fetchedAt: Date.now(),
    mirrors,
  };
  setPref("mirrorsCache", JSON.stringify(payload));
}

function orderMirrors(
  preferred: string,
  backups: string[],
  discovered: string[],
): string[] {
  const preferredBase = endpointToBase(preferred);
  const seen = new Set<string>();
  const ordered: string[] = [];

  const push = (base: string) => {
    const normalized = endpointToBase(base);
    if (seen.has(normalized)) return;
    seen.add(normalized);
    ordered.push(normalized);
  };

  push(preferredBase);
  for (const mirror of backups) {
    push(mirror);
  }
  for (const mirror of discovered) {
    push(mirror);
  }
  return ordered;
}

function parseMirrorsFromHtml(html: string): string[] {
  const mirrors: string[] = [];
  const seen = new Set<string>();
  const hrefRe = /href=["'](https?:\/\/annas-archive\.[a-z0-9.-]+\/?)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = hrefRe.exec(html)) !== null) {
    const hostMatch = match[1].match(MIRROR_HOST_RE);
    if (!hostMatch) continue;
    const base = `https://${hostMatch[1].toLowerCase()}`;
    if (seen.has(base)) continue;
    seen.add(base);
    mirrors.push(base);
  }
  return mirrors;
}

async function fetchMirrorsFromCatalog(): Promise<string[]> {
  const xhr = await Zotero.HTTP.request("GET", MIRROR_CATALOG_URL, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; ZoteroAnnasArchive/2.0; +https://github.com/JG8203/zotero-annas-archive)",
    },
    timeout: 15000,
  });
  if (xhr.status !== 200) {
    throw new Error(`Mirror catalog HTTP ${xhr.status}`);
  }
  const html = String(xhr.responseText || "");
  const mirrors = parseMirrorsFromHtml(html);
  if (!mirrors.length) {
    throw new Error("No Anna's Archive mirrors found in catalog");
  }
  return mirrors;
}

async function getDiscoveredMirrors(): Promise<string[]> {
  if (!getPref("autoDiscoverMirrors")) {
    return [];
  }

  const cache = readCache();
  const cacheFresh =
    cache &&
    Date.now() - cache.fetchedAt < CACHE_TTL_MS &&
    cache.mirrors.length;

  if (cacheFresh) {
    return cache.mirrors;
  }

  try {
    const fetched = await fetchMirrorsFromCatalog();
    writeCache(fetched);
    ztoolkit.log("Refreshed Anna's Archive mirrors:", fetched);
    return fetched;
  } catch (error) {
    ztoolkit.log("Mirror discovery failed, using cache if any:", error);
    return cache?.mirrors?.length ? cache.mirrors : [];
  }
}

function usableBackups(preferredBase: string): string[] {
  return getConfiguredBackupMirrors().filter(
    (base) =>
      !/annas-archive\.org$/i.test(new URL(base).host) ||
      base === preferredBase,
  );
}

/**
 * Preferred + user backup list only (no auto-discovery).
 * Used for native Find Full Text resolvers so that path stays short and predictable.
 */
export function getConfiguredMirrorBases(preferredEndpoint: string): string[] {
  const preferred = preferredEndpoint || DEFAULT_SCIDB_ENDPOINT;
  const preferredBase = endpointToBase(preferred);
  return orderMirrors(preferred, usableBackups(preferredBase), []);
}

/**
 * Return ordered SciDB mirror bases:
 * preferred → user backup list → optionally auto-discovered mirrors.
 * `.org` is omitted unless the user explicitly set it as preferred (often blocked).
 */
export async function getMirrorBases(
  preferredEndpoint: string,
): Promise<string[]> {
  const preferred = preferredEndpoint || DEFAULT_SCIDB_ENDPOINT;
  const preferredBase = endpointToBase(preferred);
  const discovered = (await getDiscoveredMirrors()).filter(
    (base) => !/annas-archive\.org$/i.test(new URL(base).host),
  );
  return orderMirrors(preferred, usableBackups(preferredBase), discovered);
}
