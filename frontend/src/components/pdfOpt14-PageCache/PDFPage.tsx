"use client";

import React, {
  useRef,
  useEffect,
  useState,
  useCallback,
  forwardRef,
} from "react";
import { type PDFDocumentProxy, type PDFPageProxy, type RenderTask } from "pdfjs-dist";

export interface RenderHandle {
  renderPage: () => Promise<void>;
  isRendered: () => boolean;
}

interface PDFPageProps {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  onRenderReady: (pageNumber: number, handle: RenderHandle) => void;
}

const PDFPage = forwardRef<HTMLDivElement, PDFPageProps>(
  ({ pdf, pageNumber, onRenderReady }, ref) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const renderTaskRef = useRef<RenderTask | null>(null);
    const renderedRef = useRef(false);
    // [A] getPage() 결과 캐시 — 이중 호출 방지
    const pageRef = useRef<PDFPageProxy | null>(null);

    const [rendered, setRendered] = useState(false);
    const [viewportSize, setViewportSize] = useState<{ w: number; h: number } | null>(null);

    // placeholder 높이 계산 + 페이지 객체 캐시
    useEffect(() => {
      let cancelled = false;
      (async () => {
        try {
          const page = await pdf.getPage(pageNumber);
          if (cancelled) return;
          pageRef.current = page; // [A] 캐시 저장
          const viewport = page.getViewport({ scale: 2 });
          setViewportSize({ w: viewport.width, h: viewport.height });
        } catch {
          // ignore
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [pdf, pageNumber]);

    const renderPage = useCallback(async () => {
      if (renderedRef.current || !canvasRef.current) return;

      try {
        // [A] 캐시된 페이지 우선 사용 → getPage() 중복 호출 제거
        const page = pageRef.current ?? (await pdf.getPage(pageNumber));
        if (!pageRef.current) pageRef.current = page;

        const viewport = page.getViewport({ scale: 2 });
        const canvas = canvasRef.current;
        if (!canvas) return;

        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        canvas.width = viewport.width;
        canvas.height = viewport.height;

        if (renderTaskRef.current) {
          try {
            renderTaskRef.current.cancel();
          } catch {
            // ignore cancel error
          }
        }

        const task = page.render({ canvasContext: ctx, viewport });
        renderTaskRef.current = task;

        await task.promise;
        renderedRef.current = true;
        setRendered(true);
      } catch (e: unknown) {
        const err = e as { name?: string; message?: string };
        if (err?.name !== "RenderingCancelledException") {
          console.error(`[pdfOpt14] page ${pageNumber} render error:`, err);
        }
      }
    }, [pdf, pageNumber]);

    useEffect(() => {
      onRenderReady(pageNumber, {
        renderPage,
        isRendered: () => renderedRef.current,
      });
    }, [pageNumber, renderPage, onRenderReady]);

    const placeholderStyle: React.CSSProperties = viewportSize
      ? { width: "100%", height: viewportSize.h, background: "#f3f4f6" }
      : { width: "100%", aspectRatio: "1/1.414", background: "#f3f4f6" };

    return (
      <div
        ref={ref}
        data-page-number={pageNumber}
        style={{ position: "relative", marginBottom: 16 }}
      >
        <canvas
          ref={canvasRef}
          style={{ display: rendered ? "block" : "none", width: "100%" }}
        />
        {!rendered && <div style={placeholderStyle} />}
      </div>
    );
  }
);

PDFPage.displayName = "PDFPage";
export default PDFPage;
