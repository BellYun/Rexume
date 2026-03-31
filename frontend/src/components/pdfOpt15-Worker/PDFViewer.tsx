"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import PDFPage, { type RenderHandle } from "./PDFPage";

/**
 * pdfOpt15 PDFViewer
 *
 * 메인 스레드 변경점:
 *   - pdfjs import 없음 (Worker가 모두 처리)
 *   - Worker 생성 → 'load' 메시지로 PDF 로드 위임
 *   - IO + RAF 스케줄링 유지 (baseline 구조 동일)
 *   - 'rendered' 메시지 수신 → ImageBitmap을 PDFPage.displayBitmap()으로 전달
 */

const CONCURRENT_LIMIT = 3;

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
  const activeRef = useRef(0);

  // ── Worker 초기화 및 메시지 핸들러 ───────────────────────────────────
  useEffect(() => {
    if (typeof window === "undefined") return;

    const worker = new Worker(
      new URL("./pdf-render.worker.ts", import.meta.url)
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
        activeRef.current--;
        handleRefs.current.get(pageNumber)?.displayBitmap(bitmap);
        // 남은 대기 페이지 처리
        if (pendingRef.current.size > 0 && rafIdRef.current === null) {
          rafIdRef.current = requestAnimationFrame(flush);
        }
      } else if (type === "renderError") {
        activeRef.current--;
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

  // ── PDF URL 변경 시 Worker에 load 요청 ──────────────────────────────
  useEffect(() => {
    if (!url?.trim() || !workerRef.current) return;

    setLoading(true);
    setError(null);
    setNumPages(0);
    domRefs.current.clear();
    handleRefs.current.clear();
    pendingRef.current.clear();
    activeRef.current = 0;
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }

    // Worker 내부에서 상대경로 해석 불가 → 절대 URL 변환
    const absUrl = url.startsWith("http") ? url : `${window.location.origin}${url}`;
    workerRef.current.postMessage({ type: "load", url: absUrl });
  }, [url]);

  // ── RAF 배칭 flush ────────────────────────────────────────────────────
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
      // 메인 스레드 작업 없음 — Worker에 메시지만 전송
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

  // ── IntersectionObserver 설정 ─────────────────────────────────────────
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

    // 각 페이지 크기 사전 요청 (placeholder 확보)
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
