import { config } from "../../package.json";
import { getLocaleID, getString } from "../utils/locale";
import { getPref, setPref } from "../utils/prefs";
import { DEFAULT_SCIDB_ENDPOINT, getMirrorBases, scidbUrl } from "./mirrors";
import {
  getMembershipKey,
  MemberApiError,
  resolveMemberFastDownload,
} from "./memberApi";
import {
  notifyFindFileSuccess,
  resolvePdfUrlViaHiddenBrowser,
  syncPdfResolvers,
  unhookPdfResolvers,
} from "./pdfResolvers";
import { isBotCheckHtml, isPdfMissingHtml } from "./scidbHtml";

class PdfNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfNotFoundError";
  }
}

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

class BotCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BotCheckError";
  }
}

export class AnnasArchiveManager {
  private static _instance: AnnasArchiveManager;
  private observerID: string | null = null;
  private menuRegistered = false;
  private prefObserverIDs: symbol[] = [];

  private constructor() {}

  public static getInstance(): AnnasArchiveManager {
    if (!AnnasArchiveManager._instance) {
      AnnasArchiveManager._instance = new AnnasArchiveManager();
    }
    return AnnasArchiveManager._instance;
  }

  public registerMenus() {
    if (this.menuRegistered) return;

    const icon = `chrome://${addon.data.config.addonRef}/content/icons/favicon.png`;

    // Prefer Zotero 8+ MenuManager (required path for Zotero 10)
    if (Zotero.MenuManager?.registerMenu) {
      Zotero.MenuManager.registerMenu({
        menuID: `${addon.data.config.addonRef}-item-menu`,
        pluginID: addon.data.config.addonID,
        target: "main/library/item",
        menus: [
          {
            menuType: "menuitem",
            l10nID: getLocaleID("menuitem-download"),
            icon,
            onCommand: () => {
              void this.downloadSelectedItems();
            },
          },
        ],
      });

      Zotero.MenuManager.registerMenu({
        menuID: `${addon.data.config.addonRef}-collection-menu`,
        pluginID: addon.data.config.addonID,
        target: "main/library/collection",
        menus: [
          {
            menuType: "menuitem",
            l10nID: getLocaleID("menuitem-download-collection"),
            icon,
            onCommand: () => {
              void this.downloadSelectedCollections();
            },
          },
        ],
      });

      Zotero.MenuManager.registerMenu({
        menuID: `${addon.data.config.addonRef}-tools-menu`,
        pluginID: addon.data.config.addonID,
        target: "main/menubar/tools",
        menus: [
          {
            menuType: "menuitem",
            l10nID: getLocaleID("menuitem-update-all"),
            icon,
            onCommand: () => {
              void this.downloadAllEditableItems();
            },
          },
        ],
      });

      this.menuRegistered = true;
      return;
    }

    // Zotero 7 fallback: inject menu items into each main window
    this.registerLegacyMenus();
  }

  private registerLegacyMenus() {
    const win = Zotero.getMainWindow();
    if (!win) return;
    const doc = win.document;
    const icon = `chrome://${addon.data.config.addonRef}/content/icons/favicon@0.5x.png`;

    const ensureItem = (
      parentSelector: string,
      id: string,
      label: string,
      onCommand: () => void,
    ) => {
      if (doc.getElementById(id)) return;
      const parent = doc.querySelector(parentSelector);
      if (!parent) return;
      const item = doc.createXULElement("menuitem");
      item.id = id;
      item.setAttribute("label", label);
      item.setAttribute("class", "menuitem-iconic");
      item.setAttribute("image", icon);
      item.addEventListener("command", onCommand);
      parent.appendChild(item);
    };

    ensureItem(
      "#zotero-itemmenu",
      "zotero-itemmenu-annasarchive-download",
      getString("menuitem-download"),
      () => void this.downloadSelectedItems(),
    );
    ensureItem(
      "#zotero-collectionmenu",
      "zotero-collectionmenu-annasarchive-download",
      getString("menuitem-download-collection"),
      () => void this.downloadSelectedCollections(),
    );
    ensureItem(
      "#menu_ToolsPopup",
      "zotero-toolsmenu-annasarchive-update-all",
      getString("menuitem-update-all"),
      () => void this.downloadAllEditableItems(),
    );
  }

  public registerNotifier() {
    if (this.observerID) return;

    this.migrateLegacyDefaultEndpoint();

    this.observerID = Zotero.Notifier.registerObserver(
      {
        notify: async (
          event: string,
          type: string,
          ids: string[] | number[],
          _extraData: { [key: string]: any },
        ) => {
          if (event !== "add" || type !== "item") return;
          if (!getPref("automaticPdfDownload")) return;

          const items = await Zotero.Items.getAsync(ids as number[]);
          const needingPdf = items.filter(
            (item) => item.isRegularItem() && !this.itemHasPdfAttachment(item),
          );
          if (!needingPdf.length) return;
          await this.updateItems(needingPdf);
        },
      },
      ["item"],
      "annasarchive",
    );
  }

  public unregisterNotifier() {
    if (this.observerID) {
      Zotero.Notifier.unregisterObserver(this.observerID);
      this.observerID = null;
    }
  }

  public registerPdfResolvers() {
    this.migrateLegacyDefaultEndpoint();
    syncPdfResolvers(this.getPreferredEndpoint());
    this.registerPrefObservers();
  }

  public unregisterPdfResolvers() {
    this.unregisterPrefObservers();
    unhookPdfResolvers();
  }

  private registerPrefObservers() {
    if (this.prefObserverIDs.length) return;

    const keys = ["endpoint", "backupMirrors", "automaticPdfDownload"] as const;
    for (const key of keys) {
      const id = Zotero.Prefs.registerObserver(
        `${config.prefsPrefix}.${key}`,
        () => {
          this.migrateLegacyDefaultEndpoint();
          syncPdfResolvers(this.getPreferredEndpoint());
        },
        true,
      );
      this.prefObserverIDs.push(id);
    }
  }

  private unregisterPrefObservers() {
    for (const id of this.prefObserverIDs) {
      Zotero.Prefs.unregisterObserver(id);
    }
    this.prefObserverIDs = [];
  }

  private itemHasPdfAttachment(item: Zotero.Item): boolean {
    const ids = item.getAttachments();
    for (const id of ids) {
      const attachment = Zotero.Items.get(id);
      if (
        attachment &&
        attachment.attachmentContentType === "application/pdf"
      ) {
        return true;
      }
    }
    return false;
  }

  /** Prefer .gl — migrate empty prefs and any leftover .org endpoint. */
  private migrateLegacyDefaultEndpoint() {
    const current = ((getPref("endpoint") as string) || "").trim();
    if (!current || /annas-archive\.org/i.test(current)) {
      setPref("endpoint", DEFAULT_SCIDB_ENDPOINT);
    }

    const backups = ((getPref("backupMirrors") as string) || "").trim();
    if (backups && /annas-archive\.org/i.test(backups)) {
      setPref(
        "backupMirrors",
        backups
          .split(/[\n,]+/)
          .map((line) => line.trim())
          .filter((line) => line && !/annas-archive\.org/i.test(line))
          .join("\n"),
      );
      setPref("mirrorsCache", "");
    }
  }

  private async downloadSelectedItems() {
    const pane = Zotero.getActiveZoteroPane();
    if (!pane) {
      this.showProgressWindow("No Zotero pane available", "fail");
      return;
    }
    const items = pane.getSelectedItems();
    if (!items.length) {
      this.showProgressWindow("No items selected", "fail");
      return;
    }
    await this.updateItems(items);
  }

  private async downloadSelectedCollections() {
    const pane = Zotero.getActiveZoteroPane();
    if (!pane) {
      this.showProgressWindow("No Zotero pane available", "fail");
      return;
    }

    // Zotero 10: plural selection getters
    const collections =
      typeof pane.getSelectedCollections === "function"
        ? pane.getSelectedCollections()
        : [pane.getSelectedCollection()].filter(
            (c): c is Zotero.Collection => !!c,
          );

    if (!collections.length) {
      this.showProgressWindow("No collection selected", "fail");
      return;
    }

    const items: Zotero.Item[] = [];
    for (const collection of collections) {
      items.push(...collection.getChildItems(false, false));
    }
    await this.updateItems(items);
  }

  private async downloadAllEditableItems() {
    const items: Zotero.Item[] = [];
    for (const library of Zotero.Libraries.getAll()) {
      if (!Zotero.Libraries.isEditable(library.libraryID)) continue;
      const libraryItems = await Zotero.Items.getAll(library.libraryID);
      items.push(...libraryItems.filter((item) => item.isRegularItem()));
    }
    await this.updateItems(items);
  }

  public async updateItems(
    items: Zotero.Item[],
    options: { skipMember?: boolean } = {},
  ): Promise<void> {
    const processable = items.filter((item) => item.isRegularItem());

    if (!processable.length) {
      this.showProgressWindow("No processable items", "fail");
      return;
    }

    // Re-run migration every download in case an old profile still has .org
    this.migrateLegacyDefaultEndpoint();

    const progressWin = new ztoolkit.ProgressWindow(addon.data.config.addonName)
      .createLine({
        text: `Processing ${processable.length} item(s)...`,
        type: "default",
      })
      .show();

    const preferred = this.getPreferredEndpoint();
    const mirrors = await getMirrorBases(preferred);
    const membershipKey = options.skipMember ? "" : getMembershipKey();
    ztoolkit.log("Trying SciDB mirrors in order:", mirrors);
    if (membershipKey) {
      ztoolkit.log("Membership key present — trying fast-download API first");
    }

    for (const item of processable) {
      const doi = this.getDoi(item);
      if (!doi) {
        progressWin.changeLine({
          text: `DOI missing: "${item.getField("title")}"`,
          type: "fail",
        });
        continue;
      }

      // Always fall back to the preferred (.gl) URL — never the last failed mirror
      const preferredUrl = scidbUrl(preferred, doi);

      if (membershipKey) {
        progressWin.changeLine({
          text: `Member fast download for "${item.getField("title")}"...`,
          type: "default",
        });
        try {
          const fast = await resolveMemberFastDownload(doi, preferred);
          await this.attachPdfToItem(fast.url, item, preferredUrl);
          const quota =
            typeof fast.downloadsLeft === "number"
              ? ` (${fast.downloadsLeft} fast downloads left today)`
              : "";
          progressWin.changeLine({
            text: `Downloaded PDF for "${item.getField("title")}" via membership API${quota}`,
            type: "success",
          });
          continue;
        } catch (error) {
          ztoolkit.log(
            "Membership fast download failed, falling back to SciDB:",
            error instanceof MemberApiError ? error.message : error,
          );
          progressWin.changeLine({
            text: `Membership download failed (${error instanceof Error ? error.message : "error"}). Trying SciDB…`,
            type: "default",
          });
        }
      }
      let lastError: unknown;
      let downloaded = false;
      let sawBotCheck = false;

      for (let i = 0; i < mirrors.length; i++) {
        const mirror = mirrors[i];
        const url = scidbUrl(mirror, doi);
        const host = new URL(mirror).host;

        progressWin.changeLine({
          text: `Trying ${host} for "${item.getField("title")}" (${i + 1}/${mirrors.length})...`,
          type: "default",
        });

        try {
          await this.updateItem(url, item, progressWin);
          downloaded = true;
          break;
        } catch (error: any) {
          lastError = error;
          if (error instanceof BotCheckError) {
            sawBotCheck = true;
          }
          ztoolkit.log(`Mirror ${host} failed for DOI ${doi}:`, error);

          if (i < mirrors.length - 1) {
            continue;
          }
        }
      }

      if (downloaded) continue;

      if (lastError instanceof PdfNotFoundError && !sawBotCheck) {
        progressWin.changeLine({
          text: `PDF not available on any mirror: "${item.getField("title")}"`,
          type: "fail",
        });
        continue;
      }

      if (sawBotCheck) {
        progressWin.changeLine({
          text: `Bot-check blocked automation. Opening a Zotero viewer to clear it…`,
          type: "default",
        });
        const viaViewer = await resolvePdfUrlViaHiddenBrowser(preferredUrl, {
          allowViewer: true,
        });
        if (viaViewer) {
          await this.attachPdfToItem(viaViewer, item, preferredUrl);
          progressWin.changeLine({
            text: `Downloaded PDF for "${item.getField("title")}" after clearing bot-check`,
            type: "success",
          });
          continue;
        }
      }

      progressWin.changeLine({
        text: sawBotCheck
          ? `Site bot-check blocked automated download. Opening preferred mirror in browser...`
          : `All mirrors failed for "${item.getField("title")}". Opening preferred mirror...`,
        type: "fail",
      });
      Zotero.launchURL(preferredUrl);
      break;
    }
  }

  private getPreferredEndpoint(): string {
    this.migrateLegacyDefaultEndpoint();
    const endpoint = (getPref("endpoint") as string) || "";
    if (endpoint && !/annas-archive\.org/i.test(endpoint)) {
      return endpoint.endsWith("/") ? endpoint : `${endpoint}/`;
    }
    return DEFAULT_SCIDB_ENDPOINT;
  }

  private getDoi(item: Zotero.Item): string | null {
    const doiField = item.getField("DOI") as string;
    const doiFromExtra = this.getDoiFromExtra(item);
    const doiFromUrl = this.getDoiFromUrl(item);
    const doi = doiField || doiFromExtra || doiFromUrl;

    if (doi && typeof doi === "string" && doi.trim().length > 0) {
      return doi.trim();
    }
    return null;
  }

  private getDoiFromExtra(item: Zotero.Item): string | null {
    const extra = item.getField("extra") as string;
    const match = extra?.match(/^DOI:\s*(.+)$/m);
    return match ? match[1].trim() : null;
  }

  private getDoiFromUrl(item: Zotero.Item): string | null {
    const url = item.getField("url") as string;
    if (!url?.match(/\bdoi\.org\b/i)) return null;
    try {
      const doiPath = new URL(url).pathname;
      return decodeURIComponent(doiPath).replace(/^\//, "");
    } catch {
      return null;
    }
  }

  private async updateItem(
    url: string,
    item: Zotero.Item,
    progressWin: InstanceType<ZToolkit["ProgressWindow"]>,
  ): Promise<void> {
    progressWin.changeLine({
      text: `Fetching PDF for "${item.getField("title")}"...`,
      type: "default",
    });

    const attachFromBrowser = async () => {
      const viaBrowser = await resolvePdfUrlViaHiddenBrowser(url);
      if (!viaBrowser) return false;
      await this.attachPdfToItem(viaBrowser, item, url);
      progressWin.changeLine({
        text: `Downloaded PDF for "${item.getField("title")}" via ${new URL(url).host}`,
        type: "success",
      });
      return true;
    };

    let xhr;
    try {
      xhr = await Zotero.HTTP.request("GET", url, {
        responseType: "document",
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        },
        timeout: 30000,
      });
    } catch (error: any) {
      const msg = String(error?.message || error);
      if (/403|challenge|cloudflare|captcha|ddos/i.test(msg)) {
        if (await attachFromBrowser()) return;
        throw new BotCheckError(`Bot-check/HTTP error for ${url}: ${msg}`);
      }
      throw error;
    }

    if (xhr.status === 403 || xhr.status === 503) {
      if (await attachFromBrowser()) return;
      throw new BotCheckError(`HTTP ${xhr.status} bot-check at ${url}`);
    }
    if (xhr.status !== 200) {
      throw new Error(`Failed to fetch page: ${xhr.status}`);
    }

    const body = xhr.responseXML?.querySelector("body");
    const html = String(body?.innerHTML || xhr.responseText || "");
    if (isBotCheckHtml(html)) {
      if (await attachFromBrowser()) return;
      throw new BotCheckError(`Bot-check page at ${url}`);
    }

    const iframe = xhr.responseXML?.querySelector("iframe");
    if (iframe) {
      const iframeSrc = iframe.getAttribute("src");
      if (iframeSrc && iframe.id !== "pdf") {
        const absolute = new URL(iframeSrc, url).href;
        return this.updateItem(absolute, item, progressWin);
      }
    }

    const pdfElement =
      xhr.responseXML?.querySelector("#pdf") ||
      xhr.responseXML?.querySelector("embed#pdf") ||
      xhr.responseXML?.querySelector("embed[src*='pdf']");
    let pdfUrl =
      pdfElement?.getAttribute("src") ||
      pdfElement?.getAttribute("href") ||
      undefined;

    if (!pdfUrl) {
      const links = Array.from(
        xhr.responseXML?.querySelectorAll("a[href]") || [],
      ) as Element[];
      const pdfLink = links.find((link) => {
        const href = link.getAttribute("href") || "";
        return href.endsWith(".pdf") || href.includes("/pdf/");
      });
      pdfUrl = pdfLink?.getAttribute("href") || undefined;
    }

    if (pdfUrl && !pdfUrl.startsWith("http") && !pdfUrl.startsWith("//")) {
      pdfUrl = new URL(pdfUrl, url).href;
    }

    if (!pdfUrl || isPdfMissingHtml(String(body?.innerHTML || html))) {
      throw new PdfNotFoundError(`PDF not available at ${url}`);
    }

    if (pdfUrl.startsWith("//")) {
      pdfUrl = `https:${pdfUrl}`;
    } else if (pdfUrl.startsWith("http:")) {
      pdfUrl = pdfUrl.replace("http:", "https:");
    }

    await this.attachPdfToItem(pdfUrl, item, url);

    progressWin.changeLine({
      text: `Downloaded PDF for "${item.getField("title")}" via ${new URL(url).host}`,
      type: "success",
    });
  }

  private async attachPdfToItem(
    pdfUrl: string,
    item: Zotero.Item,
    referrer: string,
  ): Promise<void> {
    const title = `${item.getField("title")} (Anna's Archive)`;
    await Zotero.Attachments.importFromURL({
      libraryID: item.libraryID,
      url: pdfUrl,
      parentItemID: item.id,
      title,
      fileBaseName: item.key,
      contentType: "application/pdf",
      referrer,
    });
    notifyFindFileSuccess(item, title);
  }

  private showProgressWindow(
    message: string,
    type: "success" | "fail" | "default" = "default",
  ) {
    new ztoolkit.ProgressWindow(addon.data.config.addonName)
      .createLine({ text: message, type })
      .show();
  }
}
