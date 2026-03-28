"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentProxy,
} from "pdfjs-dist/build/pdf";
import PDFPage, { type RenderHandle } from "./PDFPage";

let workerReady = false;
function ensureWorker() {
  if (workerReady || typeof window === "undefined") return;
  GlobalWorkerOptions.workerSrc = "/pdf.worker.min.js";
  workerReady = true;
}

const CONCURRENT_LIMIT = 3;

interface PDFViewerProps {
  url: string;
}

export default function PDFViewer({ url }: PDFViewerProps) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const domRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const handleRefs = useRef<Map<number, RenderHandle>>(new Map());

  const observerRef = useRef<IntersectionObserver | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const pendingRef = useRef<Set<number>>(new Set());
  const activeRef = useRef(0);

  useEffect(() => {
    if (!url?.trim()) return;
    let cancelled = false;

    setLoading(true);
    setError(null);
    setPdf(null);
    setNumPages(0);
    domRefs.current.clear();
    handleRefs.current.clear();

    (async () => {
      try {
        ensureWorker();
        const task = getDocument({
          url,
          cMapUrl: "/api/pdfjs/cmaps/",
          cMapPacked: true,
          standardFontDataUrl: "/api/pdfjs/fonts/",
        });
        const doc = await task.promise;
        if (cancelled) return;
        setPdf(doc);
        setNumPages(doc.numPages);
      } catch (e: unknown) {
        if (cancelled) return;
        const err = e as { message?: string };
        setError(err?.message ?? "PDF 로딩 실패");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [url]);

  const flush = useCallback(() => {
    rafIdRef.current = null;

    const sorted = Array.from(pendingRef.current).sort((a, b) => a - b);

    for (const pageNum of sorted) {
      if (activeRef.current >= CONCURRENT_LIMIT) break;

      const handle = handleRefs.current.get(pageNum);
      if (!handle || handle.isRendered()) {
        pendingRef.current.delete(pageNum);
        continue;
      }

      pendingRef.current.delete(pageNum);
      activeRef.current++;

      handle.renderPage().finally(() => {
        activeRef.current--;
        if (pendingRef.current.size > 0 && rafIdRef.current === null) {
          rafIdRef.current = requestAnimationFrame(flush);
        }
      });
    }
  }, []);

  const scheduleRender = useCallback(
    (pageNumber: number) => {
      pendingRef.current.add(pageNumber);
      if (rafIdRef.current === null) {
        rafIdRef.current = requestAnimationFrame(flush);
      }
    },
    [flush]
  );

  useEffect(() => {
    if (!pdf || numPages === 0) return;

    const margin =
      typeof window !== "undefined"
        ? Math.round(window.innerHeight * 0.75)
        : 800;

    observerRef.current = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          const pageNumber = parseInt(
            (entry.target as HTMLElement).dataset.pageNumber ?? "1",
            10
          );
          const handle = handleRefs.current.get(pageNumber);
          if (handle && !handle.isRendered()) {
            scheduleRender(pageNumber);
          }
        });
      },
      { rootMargin: `${margin}px 0px`, threshold: 0 }
    );

    domRefs.current.forEach((el) => observerRef.current?.observe(el));

    return () => {
      observerRef.current?.disconnect();
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, [pdf, numPages, scheduleRender]);

  const handleDomRef = useCallback(
    (pageNumber: number) => (el: HTMLDivElement | null) => {
      if (el) {
        domRefs.current.set(pageNumber, el);
        observerRef.current?.observe(el);
      } else {
        domRefs.current.delete(pageNumber);
      }
    },
    []
  );

  const handleRenderReady = useCallback(
    (pageNumber: number, handle: RenderHandle) => {
      handleRefs.current.set(pageNumber, handle);
    },
    []
  );

  if (error)
    return (
      <div className="p-4 text-red-500 rounded-lg bg-red-50">
        오류: {error}
      </div>
    );
  if (loading)
    return <div className="p-4 text-gray-400">PDF 로딩 중...</div>;
  if (!pdf) return null;

  return (
    <div style={{ maxWidth: 900, margin: "0 auto" }}>
      {Array.from({ length: numPages }, (_, i) => i + 1).map((pageNumber) => (
        <PDFPage
          key={pageNumber}
          ref={handleDomRef(pageNumber)}
          pdf={pdf}
          pageNumber={pageNumber}
          onRenderReady={handleRenderReady}
        />
      ))}
    </div>
  );
}
