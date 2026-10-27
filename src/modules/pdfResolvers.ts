import { getPref } from "../utils/prefs";
import {
  DEFAULT_SCIDB_ENDPOINT,
  getConfiguredMirrorBases,
  scidbUrl,
} from "./mirrors";
import { getMembershipKey, resolveMemberFastDownload } from "./memberApi";
import {
  extractFollowIframeUrl,
  extractPdfUrlFromHtml,
  isBotCheckHtml,
} from "./scidbHtml";

const ZOTERO_RESOLVERS_PREF = "findPDFs.resolvers";
export const RESOLVER_NAME_PREFIX = "Anna's Archive SciDB";

/** DDoS-Guard challenge heading present only on the interstitial. */
const DDOS_GUARD_CAPTCHA = "#ddg-l10";

const CHALLENGE_ENTRY = {
  match: "://annas-archive.",
  captchaLocator: DDOS_GUARD_CAPTCHA,
};

type AddAvailableFilesFn = (
  items: Zotero.Item[],
  options?: Record<string, unknown>,
) => Promise<unknown>;

let unhook: (() => void) | null = null;
let challengeRegistered = false;

function isOurResolver(resolver: { name?: unknown }): boolean {
  return (
    typeof resolver?.name === "string" &&
    resolver.name.startsWith(RESOLVER_NAME_PREFIX)
  );
}

/** Drop leftover JSON HTML resolvers from earlier experiments. */
export function unregisterPdfResolvers(): void {
  try {
    const raw = Zotero.Prefs.get(ZOTERO_RESOLVERS_PREF);
    if (!raw || typeof raw !== "string") return;
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object"
        ? [parsed]
        : [];
    const remaining = list.filter((resolver) => !isOurResolver(resolver));
    Zotero.Prefs.set(ZOTERO_RESOLVERS_PREF, JSON.stringify(remaining));
  } catch (error) {
    ztoolkit.log("Failed to clear JSON Find Full Text resolvers:", error);
  }
}

function attachmentsApi(): any {
  return Zotero.Attachments;
}

function itemStillNeedsPdf(item: Zotero.Item): boolean {
  try {
    if (typeof attachmentsApi().canFindFileForItem === "function") {
      return attachmentsApi().canFindFileForItem(item);
    }
    if (typeof attachmentsApi().canFindPDFForItem === "function") {
      return attachmentsApi().canFindPDFForItem(item);
    }
  } catch {
    // fall through
  }
  return (
    item.isRegularItem() &&
    !!(item.getField("DOI") || item.getExtraField("DOI")) &&
    item.numPDFAttachments() === 0
  );
}

function loadHiddenBrowserClass(): any | null {
  try {
    return ChromeUtils.importESModule(
      "chrome://zotero/content/HiddenBrowser.mjs",
    ).HiddenBrowser;
  } catch {
    try {
      return ChromeUtils.import("chrome://zotero/content/HiddenBrowser.jsm")
        .HiddenBrowser;
    } catch {
      return null;
    }
  }
}

function registerChallengeEntry() {
  const list = (Zotero as any).BrowserRequest?.CHALLENGE_URLS;
  if (!Array.isArray(list) || challengeRegistered) return;
  const existing = list.find(
    (entry: { match?: string }) => entry?.match === CHALLENGE_ENTRY.match,
  );
  if (existing) {
    existing.captchaLocator = DDOS_GUARD_CAPTCHA;
    challengeRegistered = true;
    return;
  }
  list.push({ ...CHALLENGE_ENTRY });
  challengeRegistered = true;
  ztoolkit.log("Registered Anna's Archive DDoS-Guard challenge entry");
}

function unregisterChallengeEntry() {
  const list = (Zotero as any).BrowserRequest?.CHALLENGE_URLS;
  if (!Array.isArray(list)) return;
  const index = list.findIndex(
    (entry: { match?: string }) => entry?.match === CHALLENGE_ENTRY.match,
  );
  if (index >= 0) list.splice(index, 1);
  challengeRegistered = false;
}

async function tryClearChallenge(
  pageUrl: string,
  allowViewer: boolean,
): Promise<boolean> {
  const BrowserRequest = (Zotero as any).BrowserRequest;
  if (typeof BrowserRequest?.clearChallenge !== "function") return false;
  const entry = BrowserRequest.getEntryForURL?.(pageUrl) || CHALLENGE_ENTRY;
  try {
    await BrowserRequest.clearChallenge(pageUrl, { entry, allowViewer });
    return true;
  } catch (error) {
    ztoolkit.log(
      `SciDB clearChallenge(allowViewer=${allowViewer}) failed:`,
      error,
    );
    return false;
  }
}

async function extractPdfFromBrowser(
  browser: any,
  pageUrl: string,
): Promise<string | null> {
  await browser.load(pageUrl);
  if (typeof browser.waitForDocument === "function") {
    await browser.waitForDocument({ allowInteractiveAfter: 2000 });
  }

  const deadline = Date.now() + 20000;
  let current = pageUrl;
  while (Date.now() < deadline) {
    const { documentHTML } = await browser.getPageData(["documentHTML"], {
      timeout: 10000,
    });
    const html = String(documentHTML || "");
    current = browser.currentURI?.spec || current;

    if (isBotCheckHtml(html) || /[?&]check=1\b/i.test(current)) {
      await Zotero.Promise.delay(1000);
      continue;
    }

    const iframeUrl = extractFollowIframeUrl(html, current);
    if (iframeUrl && iframeUrl !== current) {
      await browser.load(iframeUrl);
      current = iframeUrl;
      continue;
    }

    const pdfUrl = extractPdfUrlFromHtml(html, current);
    if (pdfUrl) return pdfUrl;

    await Zotero.Promise.delay(1000);
  }
  return null;
}

export interface ResolvePdfOptions {
  /** Open a visible Zotero viewer if the silent challenge fails. Default false. */
  allowViewer?: boolean;
}

/**
 * Load a SciDB URL in Zotero's hidden browser so DDoS-Guard JS can complete,
 * then read the PDF embed URL. Optionally escalates to a visible viewer.
 */
export async function resolvePdfUrlViaHiddenBrowser(
  pageUrl: string,
  options: ResolvePdfOptions = {},
): Promise<string | null> {
  const HiddenBrowser = loadHiddenBrowserClass();
  if (!HiddenBrowser) return null;

  const customUserAgent =
    (Zotero as any).VersionHeader?.getPlainFirefoxUA?.() || undefined;

  await tryClearChallenge(pageUrl, false);

  let browser = new HiddenBrowser({ customUserAgent });
  try {
    await browser._createdPromise;
    const first = await extractPdfFromBrowser(browser, pageUrl);
    if (first) return first;
  } catch (error) {
    ztoolkit.log("Hidden-browser SciDB load failed:", error);
  } finally {
    browser.destroy();
  }

  if (!options.allowViewer) return null;

  ztoolkit.log("Escalating SciDB bot-check to visible viewer");
  const cleared = await tryClearChallenge(pageUrl, true);
  if (!cleared) return null;

  browser = new HiddenBrowser({ customUserAgent });
  try {
    await browser._createdPromise;
    return await extractPdfFromBrowser(browser, pageUrl);
  } catch (error) {
    ztoolkit.log("Hidden-browser SciDB load after viewer failed:", error);
  } finally {
    browser.destroy();
  }
  return null;
}

/** SciDB landing URLs for configured mirrors (manual / diagnostics). */
export function getSciDbLandingUrls(doi: string) {
  const preferred = (getPref("endpoint") as string) || DEFAULT_SCIDB_ENDPOINT;
  return getConfiguredMirrorBases(preferred).map((base) => ({
    url: scidbUrl(base, doi),
    accessMethod: `${RESOLVER_NAME_PREFIX} (${new URL(base).host})`,
  }));
}

function itemDoi(item: Zotero.Item): string | null {
  const raw = String(
    item.getField("DOI") || (item as any).getExtraField?.("DOI") || "",
  ).trim();
  if (!raw) return null;
  try {
    return Zotero.Utilities.cleanDOI(raw) || raw;
  } catch {
    return raw;
  }
}

function preferredEndpoint(): string {
  return (getPref("endpoint") as string) || DEFAULT_SCIDB_ENDPOINT;
}

/** Keep the Find Full Text dialog in sync when we attach outside its download loop. */
export function notifyFindFileSuccess(item: Zotero.Item, title: string) {
  try {
    const Z = Zotero as any;
    const queue = Z.ProgressQueues?.get("findFile");
    if (!queue) return;
    queue.updateRow(item.id, Z.ProgressQueue.ROW_SUCCEEDED, title);
  } catch (error) {
    ztoolkit.log("Could not update Find Full Text row:", error);
  }
}

async function annasArchiveResolver(item: Zotero.Item) {
  const doi = itemDoi(item);
  if (!doi || !getMembershipKey()) return [];

  ztoolkit.log(`Find Full Text: member API for DOI ${doi}`);
  const preferred = preferredEndpoint();
  const fast = await resolveMemberFastDownload(doi, preferred);
  return [
    {
      url: fast.url,
      referrer: scidbUrl(fast.origin, doi),
      accessMethod: "Anna's Archive",
    },
  ];
}

async function runSciDbFallback(items: Zotero.Item[]): Promise<void> {
  const needing = items.filter(itemStillNeedsPdf);
  if (!needing.length) {
    ztoolkit.log("Find Full Text: no leftover items for SciDB fallback");
    return;
  }

  ztoolkit.log(`Find Full Text: SciDB fallback for ${needing.length} item(s)`);

  const { AnnasArchiveManager } = await import("./annasArchive");
  await AnnasArchiveManager.getInstance().updateItems(needing, {
    skipMember: true,
  });
}

function patchFindFullText() {
  if (unhook) return;

  const api = attachmentsApi();
  const origGet = api.getFileResolvers;
  const method =
    typeof api.addAvailableFiles === "function"
      ? "addAvailableFiles"
      : "addAvailablePDFs";
  const origAdd: AddAvailableFilesFn = api[method];

  api.getFileResolvers = function (
    item: Zotero.Item,
    methods?: string[],
    automatic?: boolean,
  ) {
    const resolvers = origGet.call(api, item, methods, automatic) || [];
    if (methods && !methods.includes("custom")) {
      return resolvers;
    }
    resolvers.push(async () => {
      try {
        return await annasArchiveResolver(item);
      } catch (error) {
        ztoolkit.log(
          "Find Full Text member resolver failed:",
          error instanceof Error ? error.message : error,
        );
        return [];
      }
    });
    return resolvers;
  };

  api[method] = async function (
    items: Zotero.Item[],
    options: Record<string, unknown> = {},
  ) {
    const result = await origAdd.call(api, items, options);

    const methods = options?.methods as string[] | undefined;
    if (methods && !methods.includes("custom")) {
      return result;
    }

    try {
      await runSciDbFallback(items);
    } catch (error) {
      ztoolkit.log("Find Full Text SciDB fallback failed:", error);
    }
    return result;
  };

  unhook = () => {
    api.getFileResolvers = origGet;
    api[method] = origAdd;
    unhook = null;
  };
}

/**
 * Supplement native Find Full Text: run SciDB after Zotero's built-in
 * publisher / open-access lookup finishes for items still missing a PDF.
 *
 * SciDB is behind DDoS-Guard and serves an HTML PDF embed, so we use our own
 * download path (hidden browser + optional visible challenge) rather than
 * JSON HTML resolvers or BrowserRequest.downloadPDF on the landing page.
 */
export function syncPdfResolvers(_preferredEndpoint?: string): void {
  unregisterPdfResolvers();
  registerChallengeEntry();
  patchFindFullText();
  ztoolkit.log("Hooked Find Full Text via getFileResolvers + SciDB fallback");
}

export function unhookPdfResolvers(): void {
  unhook?.();
  unregisterChallengeEntry();
  unregisterPdfResolvers();
}
