"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import PDFPage, { type RenderHandle } from "../pdfOpt15-Worker/PDFPage";

/**
 * pdfOpt15-NoLimit PDFViewer
 *
 * pdfOpt15와 동일하되 CONCURRENT_LIMIT 없음.
 * RAF+IO 스케줄링은 유지, 동시 render 요청 제한만 제거.
 * → CONCURRENT_LIMIT의 단독 기여 측정용
 */

interface PDFViewerProps {
  url: string;
}

export default function PDFViewer({ url }: PDFViewerProps) {
  const [numPages, setNumPages] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const workerRef = useRef<Worker | null>(null);
  const domRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const handleRefs = useRef<Map<number, RenderHandle>>(new Map());

  const observerRef = useRef<IntersectionObserver | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const pendingRef = useRef<Set<number>>(new Set());

  // ── Worker 초기화 ─────────────────────────────────────────────────
  useEffect(() => {
    if (typeof window === "undefined") return;

    const worker = new Worker(
      new URL("../pdfOpt15-Worker/pdf-render.worker.ts", import.meta.url)
    );
    workerRef.current = worker;

    worker.onmessage = (e: MessageEvent) => {
      const { type, numPages: n, pageNumber, width, height, bitmap, error: err } = e.data;

      if (type === "loaded") {
        setLoading(false);
        setNumPages(n);
      } else if (type === "error") {
        setLoading(false);
        setError(err ?? "PDF 로딩 실패");
      } else if (type === "size") {
        handleRefs.current.get(pageNumber)?.setSize(width, height);
      } else if (type === "rendered") {
        handleRefs.current.get(pageNumber)?.displayBitmap(bitmap);
        if (pendingRef.current.size > 0 && rafIdRef.current === null) {
          rafIdRef.current = requestAnimationFrame(flush);
        }
      } else if (type === "renderError") {
        if (pendingRef.current.size > 0 && rafIdRef.current === null) {
          rafIdRef.current = requestAnimationFrame(flush);
        }
      }
    };

    worker.onerror = (e) => {
      setError(`Worker 오류: ${e.message}`);
      setLoading(false);
    };

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── URL 변경 시 load ───────────────────────────────────────────────
  useEffect(() => {
    if (!url?.trim() || !workerRef.current) return;
    setLoading(true);
    setError(null);
    setNumPages(0);
    domRefs.current.clear();
    handleRefs.current.clear();
    pendingRef.current.clear();
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    workerRef.current.postMessage({ type: "load", url });
  }, [url]);

  // ── RAF flush — CONCURRENT_LIMIT 없음 ────────────────────────────
  const flush = useCallback(() => {
    rafIdRef.current = null;
    const sorted = Array.from(pendingRef.current).sort((a, b) => a - b);

    for (const pageNum of sorted) {
      const handle = handleRefs.current.get(pageNum);
      if (!handle || handle.isRendered()) {
        pendingRef.current.delete(pageNum);
        continue;
      }
      pendingRef.current.delete(pageNum);
      // 제한 없이 모든 pending 페이지 즉시 전송
      workerRef.current?.postMessage({ type: "render", pageNumber: pageNum });
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

  // ── IntersectionObserver ──────────────────────────────────────────
  useEffect(() => {
    if (numPages === 0) return;

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

    for (let p = 1; p <= numPages; p++) {
      workerRef.current?.postMessage({ type: "getSize", pageNumber: p });
    }

    return () => {
      observerRef.current?.disconnect();
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, [numPages, scheduleRender]);

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
      <div className="p-4 text-red-500 rounded-lg bg-red-50">오류: {error}</div>
    );
  if (loading)
    return <div className="p-4 text-gray-400">PDF 로딩 중...</div>;
  if (numPages === 0) return null;

  return (
    <div style={{ maxWidth: 900, margin: "0 auto" }}>
      {Array.from({ length: numPages }, (_, i) => i + 1).map((pageNumber) => (
        <PDFPage
          key={pageNumber}
          ref={handleDomRef(pageNumber)}
          pageNumber={pageNumber}
          onRenderReady={handleRenderReady}
        />
      ))}
    </div>
  );
}
