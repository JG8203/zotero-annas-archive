/** Shared SciDB HTML parsing for HTTP scrape and hidden-browser loads. */

export function isBotCheckHtml(html: string): boolean {
  return (
    /checking your browser/i.test(html) ||
    /cf-browser-verification/i.test(html) ||
    /just a moment/i.test(html) ||
    /_cf_chl/i.test(html) ||
    /[?&]check=1\b/i.test(html) ||
    /<title>\s*DDoS-Guard/i.test(html) ||
    /id=["']ddg-l10["']/i.test(html)
  );
}

export function isPdfMissingHtml(html: string): boolean {
  if (!html.trim()) return true;
  const errorPatterns = [
    /Please try to search again using DOI/im,
    /статья не найдена в базе/im,
    /article not found/i,
    /sci-hub has no access to this paper/i,
    /no paper with this doi/i,
    /not found in database/i,
    /file not found/i,
  ];
  return errorPatterns.some((pattern) => pattern.test(html));
}

function absolutize(href: string, baseUrl: string): string {
  if (href.startsWith("//")) return `https:${href}`;
  if (href.startsWith("http:")) return href.replace("http:", "https:");
  if (href.startsWith("https:")) return href;
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return href;
  }
}

/**
 * Pull a PDF URL out of a SciDB (or viewer) HTML document.
 * Matches embed#pdf, iframe#pdf, and obvious .pdf links.
 */
export function extractPdfUrlFromHtml(
  html: string,
  pageUrl: string,
): string | null {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const pdfElement =
    doc.querySelector("#pdf") ||
    doc.querySelector("embed#pdf") ||
    doc.querySelector("embed[src*='pdf']") ||
    doc.querySelector("iframe#pdf") ||
    doc.querySelector("iframe[src*='pdf']");

  let pdfUrl =
    pdfElement?.getAttribute("src") ||
    pdfElement?.getAttribute("href") ||
    undefined;

  if (!pdfUrl) {
    const links = Array.from(doc.querySelectorAll("a[href]")) as Element[];
    const pdfLink = links.find((link) => {
      const href = link.getAttribute("href") || "";
      return href.endsWith(".pdf") || href.includes("/pdf/");
    });
    pdfUrl = pdfLink?.getAttribute("href") || undefined;
  }

  if (!pdfUrl || isPdfMissingHtml(html)) return null;
  return absolutize(pdfUrl, pageUrl);
}

export function extractFollowIframeUrl(
  html: string,
  pageUrl: string,
): string | null {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const iframe = doc.querySelector("iframe");
  if (!iframe) return null;
  const src = iframe.getAttribute("src");
  if (!src || iframe.id === "pdf") return null;
  return absolutize(src, pageUrl);
}
