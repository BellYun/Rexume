"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import PDFPage, { type RenderHandle } from "../pdfOpt15-Worker/PDFPage";

/**
 * pdfWorkerOnly PDFViewer
 *
 * OffscreenCanvas + Web Worker만 사용, IO/RAF 스케줄링 없음.
 * 페이지 로드 즉시 전 페이지 render 요청 전송 → Basic과의 Worker 효과 비교용.
 */

interface PDFViewerProps {
  url: string;
}

export default function PDFViewer({ url }: PDFViewerProps) {
  const [numPages, setNumPages] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const workerRef = useRef<Worker | null>(null);
  const handleRefs = useRef<Map<number, RenderHandle>>(new Map());

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
  }, []);

  // ── URL 변경 시 로드 ──────────────────────────────────────────────
  useEffect(() => {
    if (!url?.trim() || !workerRef.current) return;
    setLoading(true);
    setError(null);
    setNumPages(0);
    handleRefs.current.clear();
    workerRef.current.postMessage({ type: "load", url });
  }, [url]);

  // ── numPages 확정 시 전 페이지 즉시 render 요청 ──────────────────
  useEffect(() => {
    if (numPages === 0 || !workerRef.current) return;

    // IO/RAF 없이 전 페이지 한꺼번에 요청 (Basic과 동일한 스케줄링, Worker만 다름)
    for (let p = 1; p <= numPages; p++) {
      workerRef.current.postMessage({ type: "getSize", pageNumber: p });
      workerRef.current.postMessage({ type: "render", pageNumber: p });
    }
  }, [numPages]);

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
          ref={() => {}}
          pageNumber={pageNumber}
          onRenderReady={handleRenderReady}
        />
      ))}
    </div>
  );
}
