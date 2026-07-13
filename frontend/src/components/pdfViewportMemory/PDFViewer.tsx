"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentProxy,
} from "pdfjs-dist/build/pdf";
import PDFPage from "./PDFPage";

let workerReady = false;
function ensureWorker() {
  if (workerReady || typeof window === "undefined") return;
  GlobalWorkerOptions.workerSrc = "/pdf.worker.min.js";
  workerReady = true;
}

interface PDFViewerProps {
  url: string;
}

const RETAINED_PAGE_LIMIT = 5;
const DOCUMENT_CLEANUP_IDLE_DELAY_MS = 800;

function recordMetric(field: keyof NonNullable<Window["__pdfViewportMemoryMetrics"]>) {
  if (typeof window === "undefined") return;

  const metrics = (window.__pdfViewportMemoryMetrics ??= {
    observed: 0,
    entered: 0,
    exited: 0,
    renderStarted: 0,
    renderCompleted: 0,
    renderCancelled: 0,
    releaseScheduled: 0,
    releaseAborted: 0,
    canvasReleased: 0,
    cleanupCalls: 0,
    documentCleanupScheduled: 0,
    documentCleanupStarted: 0,
    documentCleanupCompleted: 0,
    documentCleanupSkipped: 0,
    documentCleanupFailed: 0,
  });
  metrics[field] += 1;
}

function resetMetrics() {
  if (typeof window === "undefined") return;

  window.__pdfViewportMemoryMetrics = {
    observed: 0,
    entered: 0,
    exited: 0,
    renderStarted: 0,
    renderCompleted: 0,
    renderCancelled: 0,
    releaseScheduled: 0,
    releaseAborted: 0,
    canvasReleased: 0,
    cleanupCalls: 0,
    documentCleanupScheduled: 0,
    documentCleanupStarted: 0,
    documentCleanupCompleted: 0,
    documentCleanupSkipped: 0,
    documentCleanupFailed: 0,
  };
}

export default function PDFViewer({ url }: PDFViewerProps) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retainedPages, setRetainedPages] = useState<number[]>([]);
  const activeRenderTasksRef = useRef(0);
  const cleanupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cleanupInFlightRef = useRef(false);
  const pdfRef = useRef<PDFDocumentProxy | null>(null);
  const mountedRef = useRef(true);

  const clearIdleDocumentCleanup = useCallback(() => {
    if (!cleanupTimerRef.current) return;

    clearTimeout(cleanupTimerRef.current);
    cleanupTimerRef.current = null;
  }, []);

  const scheduleIdleDocumentCleanup = useCallback(() => {
    if (
      !pdfRef.current ||
      activeRenderTasksRef.current > 0 ||
      cleanupInFlightRef.current ||
      cleanupTimerRef.current
    ) {
      return;
    }

    recordMetric("documentCleanupScheduled");
    cleanupTimerRef.current = setTimeout(async () => {
      cleanupTimerRef.current = null;

      const currentPdf = pdfRef.current;
      if (!currentPdf || activeRenderTasksRef.current > 0 || cleanupInFlightRef.current) {
        recordMetric("documentCleanupSkipped");
        return;
      }

      cleanupInFlightRef.current = true;
      recordMetric("documentCleanupStarted");

      try {
        await currentPdf.cleanup();
        recordMetric("documentCleanupCompleted");
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("currently rendering")) {
          recordMetric("documentCleanupSkipped");
        } else {
          recordMetric("documentCleanupFailed");
          console.warn("[ViewportMemoryPDFViewer] document cleanup failed", error);
        }
      } finally {
        cleanupInFlightRef.current = false;
      }
    }, DOCUMENT_CLEANUP_IDLE_DELAY_MS);
  }, []);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      clearIdleDocumentCleanup();
    };
  }, [clearIdleDocumentCleanup]);

  useEffect(() => {
    pdfRef.current = pdf;

    return () => {
      if (pdfRef.current === pdf) {
        pdfRef.current = null;
      }
    };
  }, [pdf]);

  useEffect(() => {
    if (!url?.trim()) return;

    let cancelled = false;
    let task: ReturnType<typeof getDocument> | null = null;
    let loadedDoc: PDFDocumentProxy | null = null;

    setLoading(true);
    setError(null);
    setPdf(null);
    setNumPages(0);
    setRetainedPages([]);
    activeRenderTasksRef.current = 0;
    cleanupInFlightRef.current = false;
    clearIdleDocumentCleanup();
    resetMetrics();

    (async () => {
      try {
        ensureWorker();
        task = getDocument({
          url,
          cMapUrl: "/api/pdfjs/cmaps/",
          cMapPacked: true,
          standardFontDataUrl: "/api/pdfjs/fonts/",
        });
        const doc = await task.promise;
        loadedDoc = doc;

        if (cancelled) {
          await doc.destroy();
          return;
        }

        setPdf(doc);
        setNumPages(doc.numPages);
      } catch (err: unknown) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "PDF 로딩 실패");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      clearIdleDocumentCleanup();
      if (loadedDoc) {
        void loadedDoc.destroy().catch(() => {});
        return;
      }

      void task?.destroy().catch(() => {});
    };
  }, [clearIdleDocumentCleanup, url]);

  const markPageActive = useCallback((pageNumber: number) => {
    setRetainedPages((prev) => {
      const next = [pageNumber, ...prev.filter((item) => item !== pageNumber)];
      return next.slice(0, RETAINED_PAGE_LIMIT);
    });
  }, []);

  const handleRenderStart = useCallback(() => {
    clearIdleDocumentCleanup();
    activeRenderTasksRef.current += 1;
  }, [clearIdleDocumentCleanup]);

  const handleRenderSettled = useCallback(() => {
    activeRenderTasksRef.current = Math.max(0, activeRenderTasksRef.current - 1);
    if (mountedRef.current && activeRenderTasksRef.current === 0) {
      scheduleIdleDocumentCleanup();
    }
  }, [scheduleIdleDocumentCleanup]);

  const handleCanvasReleased = useCallback(() => {
    if (mountedRef.current && activeRenderTasksRef.current === 0) {
      scheduleIdleDocumentCleanup();
    }
  }, [scheduleIdleDocumentCleanup]);

  if (error) {
    return <div className="p-4 text-red-500">오류: {error}</div>;
  }

  if (loading) {
    return <div className="p-4 text-gray-400">PDF 로딩 중...</div>;
  }

  if (!pdf) return null;

  return (
    <div style={{ maxWidth: 900, margin: "0 auto" }}>
      {Array.from({ length: numPages }, (_, index) => (
        <PDFPage
          key={index + 1}
          pdf={pdf}
          pageNumber={index + 1}
          retainKey={retainedPages.join(",")}
          isRetained={retainedPages.includes(index + 1)}
          onPageActive={markPageActive}
          onRenderStart={handleRenderStart}
          onRenderSettled={handleRenderSettled}
          onCanvasReleased={handleCanvasReleased}
        />
      ))}
    </div>
  );
}
