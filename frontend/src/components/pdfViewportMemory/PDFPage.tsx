"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";

interface PDFPageProps {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  retainKey: string;
  isRetained: boolean;
  onPageActive: (pageNumber: number) => void;
  onRenderStart: () => void;
  onRenderSettled: () => void;
  onCanvasReleased: () => void;
}

const PAGE_RATIO = 1.414;
const RENDER_SCALE = 2;
const RELEASE_DELAY_MS = 300;

declare global {
  interface Window {
    __pdfViewportMemoryMetrics?: {
      observed: number;
      entered: number;
      exited: number;
      renderStarted: number;
      renderCompleted: number;
      renderCancelled: number;
      releaseScheduled: number;
      releaseAborted: number;
      canvasReleased: number;
      cleanupCalls: number;
      documentCleanupScheduled: number;
      documentCleanupStarted: number;
      documentCleanupCompleted: number;
      documentCleanupSkipped: number;
      documentCleanupFailed: number;
    };
  }
}

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

export default function PDFPage({
  pdf,
  pageNumber,
  retainKey,
  isRetained,
  onPageActive,
  onRenderStart,
  onRenderSettled,
  onCanvasReleased,
}: PDFPageProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const releaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const visibleRef = useRef(false);
  const renderedRef = useRef(false);
  const [shouldRender, setShouldRender] = useState(false);

  const clearScheduledRelease = useCallback(() => {
    if (!releaseTimerRef.current) return;

    clearTimeout(releaseTimerRef.current);
    releaseTimerRef.current = null;
    recordMetric("releaseAborted");
  }, []);

  const releaseCanvas = useCallback((resetState = true) => {
    if (releaseTimerRef.current) {
      clearTimeout(releaseTimerRef.current);
      releaseTimerRef.current = null;
    }

    if (renderTaskRef.current) {
      try {
        renderTaskRef.current.cancel();
      } catch {
        // ignore cancel error
      }
      renderTaskRef.current = null;
    }

    const canvas = canvasRef.current;
    if (canvas && (canvas.width > 0 || canvas.height > 0)) {
      canvas.width = 0;
      canvas.height = 0;
      recordMetric("canvasReleased");
      onCanvasReleased();
    }

    if (resetState) {
      renderedRef.current = false;
      setShouldRender(false);
    }
  }, [onCanvasReleased]);

  const hasCanvasResource = useCallback(() => {
    const canvas = canvasRef.current;
    return Boolean(
      shouldRender ||
        renderedRef.current ||
        renderTaskRef.current ||
        (canvas && (canvas.width > 0 || canvas.height > 0))
    );
  }, [shouldRender]);

  const scheduleCanvasRelease = useCallback(() => {
    if (visibleRef.current || !hasCanvasResource()) return;
    if (releaseTimerRef.current) return;

    recordMetric("releaseScheduled");
    releaseTimerRef.current = setTimeout(() => {
      releaseTimerRef.current = null;
      if (visibleRef.current) {
        recordMetric("releaseAborted");
        onPageActive(pageNumber);
        setShouldRender(true);
        return;
      }

      releaseCanvas();
    }, RELEASE_DELAY_MS);
  }, [hasCanvasResource, onPageActive, pageNumber, releaseCanvas]);

  useEffect(() => {
    return () => {
      if (releaseTimerRef.current) {
        clearTimeout(releaseTimerRef.current);
        releaseTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const target = wrapperRef.current;
    if (!target || typeof IntersectionObserver === "undefined") {
      setShouldRender(true);
      return;
    }

    recordMetric("observed");
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;

        if (entry.isIntersecting) {
          recordMetric("entered");
          visibleRef.current = true;
          clearScheduledRelease();
          onPageActive(pageNumber);
          setShouldRender(true);
          return;
        }

        visibleRef.current = false;
        recordMetric("exited");
      },
      { rootMargin: "900px 0px", threshold: 0.01 }
    );

    observer.observe(target);
    return () => observer.disconnect();
  }, [clearScheduledRelease, onPageActive, pageNumber]);

  useEffect(() => {
    if (isRetained) {
      clearScheduledRelease();
      return;
    }

    if (visibleRef.current) {
      clearScheduledRelease();
      return;
    }

    scheduleCanvasRelease();
  }, [clearScheduledRelease, isRetained, retainKey, scheduleCanvasRelease]);

  useEffect(() => {
    if (!shouldRender || renderedRef.current || !canvasRef.current) return;

    let cancelled = false;
    let pageWorkStarted = false;
    let page: PDFPageProxy | null = null;
    let task: RenderTask | null = null;

    (async () => {
      try {
        onRenderStart();
        pageWorkStarted = true;

        page = await pdf.getPage(pageNumber);
        if (cancelled || !canvasRef.current) return;

        const viewport = page.getViewport({ scale: RENDER_SCALE });
        const canvas = canvasRef.current;
        const context = canvas.getContext("2d");
        if (!context) return;

        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);

        task = page.render({ canvasContext: context, viewport });
        renderTaskRef.current = task;
        recordMetric("renderStarted");

        await task.promise;
        if (cancelled) return;

        renderedRef.current = true;
        onPageActive(pageNumber);
        recordMetric("renderCompleted");
      } catch (error: unknown) {
        const err = error as { name?: string };
        if (cancelled || err?.name === "RenderingCancelledException") {
          recordMetric("renderCancelled");
          return;
        }

        console.error(`[ViewportMemoryPDFPage] page ${pageNumber} render failed`, err);
      } finally {
        if (renderTaskRef.current === task) {
          renderTaskRef.current = null;
        }

        if (page) {
          try {
            page.cleanup();
            recordMetric("cleanupCalls");
          } catch {
            // ignore cleanup error
          }
        }

        if (pageWorkStarted) {
          onRenderSettled();
        }
      }
    })();

    return () => {
      cancelled = true;
      releaseCanvas(false);
    };
  }, [
    onPageActive,
    onRenderSettled,
    onRenderStart,
    pageNumber,
    pdf,
    releaseCanvas,
    shouldRender,
  ]);

  return (
    <div
      ref={wrapperRef}
      data-page-number={pageNumber}
      style={{
        position: "relative",
        margin: "0 auto 16px",
        maxWidth: 900,
        aspectRatio: `1 / ${PAGE_RATIO}`,
        background: "#f3f4f6",
      }}
    >
      {shouldRender && (
        <canvas
          ref={canvasRef}
          style={{
            display: "block",
            width: "100%",
            height: "100%",
          }}
        />
      )}
    </div>
  );
}
