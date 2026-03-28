"use client";

import React, { useState, useRef, useCallback, forwardRef } from "react";
import { type PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { FeedbackPoint } from "@/types/FeedbackPointType";

interface PDFProps {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  feedback: FeedbackPoint[];
  addFeedbackPoint: (point: {
    pageNumber: number;
    x1: number; x2: number; y1: number; y2: number;
    content: string;
  }) => void;
  feedbackPoints: FeedbackPoint[];
  hoveredCommentId: number | null;
  setHoveredCommentId: (id: number | null) => void;
  setClickedCommentId: (id: number | null) => void;
}

const PDF = forwardRef<HTMLDivElement, PDFProps>(function PDF(
  { pdf, pageNumber, feedbackPoints, hoveredCommentId },
  ref
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const renderedRef = useRef(false);
  const [rendered, setRendered] = useState(false);

  const renderPage = useCallback(async () => {
    if (renderedRef.current || !canvasRef.current) return;
    try {
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 2, rotation: 0 });
      const canvas = canvasRef.current!;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      canvas.width = viewport.width;
      canvas.height = viewport.height;

      try {
        renderTaskRef.current?.cancel();
      } catch {}

      const task = page.render({ canvasContext: ctx, viewport });
      renderTaskRef.current = task;
      await task.promise;

      renderedRef.current = true;
      setRendered(true);
    } catch (e: any) {
      if (e?.name !== "RenderingCancelledException") {
        console.error(`page ${pageNumber} render error`, e);
      }
    }
  }, [pdf, pageNumber]);

  return (
    <div
      ref={(el) => {
        if (typeof ref === "function") ref(el);
        else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = el;
        if (el) {
          (el as any).renderPage = renderPage;
          (el as any).rendered = () => renderedRef.current;
        }
      }}
      data-page-number={pageNumber}
      style={{ position: "relative", marginBottom: 16, background: "#fff" }}
    >
      <div
        style={{
          width: 1200,
          height: 1200 * 1.414,
          position: "relative",
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          backgroundColor: rendered ? "transparent" : "#f5f5f5",
        }}
      >
        <canvas
          ref={canvasRef}
          style={{
            display: "block",
            width: "100%",
            height: "auto",
            opacity: rendered ? 1 : 0,
            transition: "opacity 0.2s",
          }}
        />
        {!rendered && (
          <div style={{ position: "absolute", color: "#999" }}>
            페이지 {pageNumber} 로딩 중...
          </div>
        )}
      </div>

      {rendered &&
        feedbackPoints
          .filter((item) => item.pageNumber === pageNumber)
          .map((item) => {
            const left = item.x1 ?? 0;
            const top = item.y1 ?? 0;
            const width = (item.x2 ?? left) - left || 10;
            const height = (item.y2 ?? top) - top || 10;
            const isHovered = (item.id ?? 0) === hoveredCommentId;
            return (
              <div
                key={item.id ?? `${pageNumber}-${left}-${top}`}
                style={{
                  position: "absolute",
                  left: `${left}%`,
                  top: `${top}%`,
                  width: `${width}%`,
                  height: `${height}%`,
                  border: isHovered ? "2px solid #3B82F6" : "2px solid #EF4444",
                  background: isHovered ? "rgba(59,130,246,0.3)" : "rgba(255,0,0,0.3)",
                  pointerEvents: "none",
                }}
              />
            );
          })}
    </div>
  );
});

export default PDF;


