"use client";

import React, {
  useRef,
  useEffect,
  useState,
  useCallback,
  forwardRef,
} from "react";
import { type PDFDocumentProxy, type RenderTask } from "pdfjs-dist";

export interface RenderHandle {
  renderPage: () => Promise<void>;
  isRendered: () => boolean;
}

interface PDFPageProps {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  /** 마운트 후 renderPage/isRendered 함수를 부모에게 전달 */
  onRenderReady: (pageNumber: number, handle: RenderHandle) => void;
}

/**
 * forwardRef → HTMLDivElement (IntersectionObserver에서 observe 가능)
 * onRenderReady 콜백으로 renderPage 함수를 부모(PDFViewer)에 전달
 */
const PDFPage = forwardRef<HTMLDivElement, PDFPageProps>(
  ({ pdf, pageNumber, onRenderReady }, ref) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const renderTaskRef = useRef<RenderTask | null>(null);
    const renderedRef = useRef(false);
    const [rendered, setRendered] = useState(false);
    const [viewportSize, setViewportSize] = useState<{
      w: number;
      h: number;
    } | null>(null);

    // placeholder 높이 확보를 위한 사전 계산
    useEffect(() => {
      let cancelled = false;
      (async () => {
        try {
          const page = await pdf.getPage(pageNumber);
          if (cancelled) return;
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
        const page = await pdf.getPage(pageNumber);
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
          console.error(`[PDFPage] page ${pageNumber} render error:`, err);
        }
      }
    }, [pdf, pageNumber]);

    // 마운트 시 renderPage/isRendered 핸들을 부모에 등록
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
