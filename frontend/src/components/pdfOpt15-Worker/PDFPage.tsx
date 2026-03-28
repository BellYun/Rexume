"use client";

import React, {
  useRef,
  useState,
  useCallback,
  useEffect,
  forwardRef,
} from "react";

export interface RenderHandle {
  displayBitmap: (bitmap: ImageBitmap) => void;
  setSize: (w: number, h: number) => void;
  isRendered: () => boolean;
}

interface PDFPageProps {
  pageNumber: number;
  onRenderReady: (pageNumber: number, handle: RenderHandle) => void;
}

/**
 * pdfOpt15 PDFPage
 *
 * - pdfjs import 없음 (렌더링은 Worker에서 완료)
 * - displayBitmap(bitmap): bitmaprenderer context로 GPU-to-GPU 전송
 * - setSize(w, h): Worker에서 받은 viewport 크기로 placeholder 확보
 */
const PDFPage = forwardRef<HTMLDivElement, PDFPageProps>(
  ({ pageNumber, onRenderReady }, ref) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const renderedRef = useRef(false);
    const [rendered, setRendered] = useState(false);
    const [viewportSize, setViewportSize] = useState<{ w: number; h: number } | null>(null);

    const displayBitmap = useCallback((bitmap: ImageBitmap) => {
      if (renderedRef.current || !canvasRef.current) return;
      const canvas = canvasRef.current;
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;

      // bitmaprenderer: GPU 메모리 직접 이전, 픽셀 복사 없음
      const ctx = canvas.getContext("bitmaprenderer");
      if (ctx) {
        ctx.transferFromImageBitmap(bitmap);
      } else {
        // fallback: bitmaprenderer 미지원 브라우저
        const ctx2d = canvas.getContext("2d");
        ctx2d?.drawImage(bitmap, 0, 0);
        bitmap.close();
      }

      renderedRef.current = true;
      setRendered(true);
    }, []);

    const setSize = useCallback((w: number, h: number) => {
      setViewportSize({ w, h });
    }, []);

    useEffect(() => {
      onRenderReady(pageNumber, {
        displayBitmap,
        setSize,
        isRendered: () => renderedRef.current,
      });
    }, [pageNumber, displayBitmap, setSize, onRenderReady]);

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
