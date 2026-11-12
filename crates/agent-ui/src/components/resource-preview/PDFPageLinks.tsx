import { AnnotationType, type PDFDocumentProxy, type PDFPageProxy } from "pdfjs-dist";
import { useEffect, useState } from "react";
import { useLocale } from "../../i18n";
import type { DocumentRegion } from "./docxReaderDocument";

type PDFLink = {
  id: string;
  region: DocumentRegion;
} & ({ destination: string | unknown[]; url?: never } | { url: string; destination?: never });

export function PDFPageLinks({
  page,
  document,
  assertCurrent,
  onPage,
}: {
  page: PDFPageProxy;
  document: PDFDocumentProxy;
  assertCurrent: () => void;
  onPage: (number: number) => void;
}) {
  const { locale } = useLocale();
  const zh = locale === "zh-CN";
  const [links, setLinks] = useState<PDFLink[]>([]);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      void page
        .getAnnotations({ intent: "display" })
        .then((items) => {
          if (!active) return;
          assertCurrent();
          const viewport = page.getViewport({ scale: 1 });
          const result: PDFLink[] = [];
          for (const item of items) {
            if (item.annotationType !== AnnotationType.LINK || item.rect?.length !== 4) continue;
            const [x1, y1] = viewport.convertToViewportPoint(item.rect[0], item.rect[1]);
            const [x2, y2] = viewport.convertToViewportPoint(item.rect[2], item.rect[3]);
            const left = Math.max(0, Math.min(x1, x2) / viewport.width);
            const top = Math.max(0, Math.min(y1, y2) / viewport.height);
            const width = Math.min(1, Math.max(x1, x2) / viewport.width) - left;
            const height = Math.min(1, Math.max(y1, y2) / viewport.height) - top;
            if (!(width > 0 && height > 0)) continue;
            const region = { left, top, width, height };
            if (typeof item.dest === "string" || Array.isArray(item.dest)) {
              result.push({ id: item.id, region, destination: item.dest });
            } else if (typeof item.url === "string" && /^https?:\/\//i.test(item.url)) {
              result.push({ id: item.id, region, url: item.url });
            }
            if (result.length >= 512) break;
          }
          setLinks(result);
        })
        .catch(() => {});
    }, 110);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [page, assertCurrent]);

  async function navigate(destination: string | unknown[]) {
    try {
      assertCurrent();
      const items =
        typeof destination === "string" ? await document.getDestination(destination) : destination;
      const reference: unknown = items?.[0];
      const number =
        typeof reference === "number" && Number.isSafeInteger(reference)
          ? reference + 1
          : reference &&
              typeof reference === "object" &&
              "num" in reference &&
              typeof reference.num === "number" &&
              "gen" in reference &&
              typeof reference.gen === "number"
            ? (await document.getPageIndex({ num: reference.num, gen: reference.gen })) + 1
            : null;
      assertCurrent();
      if (number !== null) onPage(number);
    } catch {
      // Invalid destinations and retired documents have no navigation target.
    }
  }

  return (
    <div className="za-pdf-links">
      {links.map(({ id, region, url, destination }) => {
        const style = {
          left: `${region.left * 100}%`,
          top: `${region.top * 100}%`,
          width: `${region.width * 100}%`,
          height: `${region.height * 100}%`,
        };
        return destination !== undefined ? (
          <button
            key={id}
            type="button"
            aria-label={zh ? "跳转到 PDF 内部目标" : "Go to PDF destination"}
            style={style}
            onClick={() => void navigate(destination)}
          />
        ) : (
          <a
            key={id}
            href={url}
            target="_blank"
            rel="noopener noreferrer nofollow"
            style={style}
            onClick={(event) => {
              try {
                assertCurrent();
              } catch {
                event.preventDefault();
              }
            }}
          >
            <span className="sr-only">{url}</span>
          </a>
        );
      })}
    </div>
  );
}
