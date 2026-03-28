"use client";

import React, {
  useState,
  useRef,
  useEffect,
  forwardRef,
  useCallback,
} from "react";
import CommentForm from "../../comment_old/CommentForm";
import { FeedbackPoint } from "@/types/FeedbackPointType";
import { type PDFDocumentProxy, RenderTask } from "pdfjs-dist";

interface PDFProps {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  feedback: FeedbackPoint[];
  addFeedbackPoint: (point: {
    pageNumber: number;
    x1: number;
    x2: number;
    y1: number;
    y2: number;
    content: string;
  }) => void;
  feedbackPoints: FeedbackPoint[];
  hoveredCommentId: number | null;
  setHoveredCommentId: (id: number | null) => void;
  setClickedCommentId: (id: number | null) => void;
}

const PDF = forwardRef<HTMLDivElement, PDFProps>(
  (
    {
      pdf,
      pageNumber,
      addFeedbackPoint,
      feedbackPoints,
      hoveredCommentId,
    },
    ref
  ) => {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const renderTaskRef = useRef<RenderTask | null>(null);
    const renderedRef = useRef(false);

    const [rendered, setRendered] = useState(false);
    // Lazy getPage 적용: 교차/렌더 시점까지 getPage 호출을 지연

    const renderPage = useCallback(async () => {
      if (renderedRef.current || !canvasRef.current) return;
      try {
        const t0 = performance.now();
        const page = await pdf.getPage(pageNumber);
        const t1 = performance.now();

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
        const t2 = performance.now();

        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        );
        const t3 = performance.now();

        renderedRef.current = true;
        setRendered(true);

        if (typeof window !== "undefined" && (window as any).pdfRenderMetricsCollector) {
          (window as any).pdfRenderMetricsCollector.add({
            page: pageNumber,
            getPageMs: +(t1 - t0).toFixed(1),
            renderMs: +(t2 - t1).toFixed(1),
            paintMs: +(t3 - t2).toFixed(1),
            totalMs: +(t3 - t0).toFixed(1),
          });
        }
      } catch (e: any) {
        if (e?.name !== "RenderingCancelledException") {
          console.error(`page ${pageNumber} render error`, e);
        }
      }
    }, [pdf, pageNumber]);

    const setHostRef = useCallback(
      (el: HTMLDivElement | null) => {
        hostRef.current = el;
        if (!el) return;

        (el as any).renderPage = renderPage;
        (el as any).rendered = () => renderedRef.current;

        if (typeof ref === "function") ref(el);
        else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = el;
      },
      [renderPage, ref]
    );

    const [selectedArea, setSelectedArea] = useState<{
      x: number;
      y: number;
      width: number;
      height: number;
    } | null>(null);
    const [isSelecting, setIsSelecting] = useState(false);
    const [startPos, setStartPos] = useState({ x: 0, y: 0 });
    const [addingFeedback, setAddingFeedback] = useState<{
      x1: number;
      x2: number;
      y1: number;
      y2: number;
      pageNumber: number;
    } | null>(null);
    const [editingFeedback] = useState<FeedbackPoint | null>(null);

    const handleMouseDown = (e: React.MouseEvent) => {
      const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      setStartPos({ x, y });
      setSelectedArea({ x, y, width: 0, height: 0 });
      setIsSelecting(true);
    };

    const handleMouseMove = (e: React.MouseEvent) => {
      if (!isSelecting || !selectedArea) return;
      const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      setSelectedArea({
        x: Math.min(startPos.x, cx),
        y: Math.min(startPos.y, cy),
        width: Math.abs(cx - startPos.x),
        height: Math.abs(cy - startPos.y),
      });
    };

    const handleMouseUp = () => {
      setIsSelecting(false);
      const el = hostRef.current;
      if (!selectedArea || !el) return;
      const rect = el.getBoundingClientRect();
      const px = (selectedArea.x / rect.width) * 100;
      const px2 = ((selectedArea.x + selectedArea.width) / rect.width) * 100;
      const py = (selectedArea.y / rect.height) * 100;
      const py2 = ((selectedArea.y + selectedArea.height) / rect.height) * 100;
      setAddingFeedback({
        x1: px,
        x2: px2,
        y1: py,
        y2: py2,
        pageNumber,
      });
    };

    const handleAddSubmit = (comment: string) => {
      if (!addingFeedback) return;
      addFeedbackPoint({
        pageNumber: addingFeedback.pageNumber,
        x1: addingFeedback.x1,
        x2: addingFeedback.x2,
        y1: addingFeedback.y1,
        y2: addingFeedback.y2,
        content: comment,
      });
      setAddingFeedback(null);
    };

    const placeholderStyle: React.CSSProperties = { width: "100%", aspectRatio: "1/1.414", background: "#f3f4f6" };

    return (
      <div
        ref={setHostRef}
        data-page-number={pageNumber}
        style={{ position: "relative", marginBottom: 20 }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
      >
        <canvas
          ref={canvasRef}
          style={{ display: rendered ? "block" : "none", width: "100%" }}
        />
        {!rendered && <div style={placeholderStyle} />}

        {selectedArea && (
          <div
            style={{
              position: "absolute",
              left: selectedArea.x,
              top: selectedArea.y,
              width: selectedArea.width,
              height: selectedArea.height,
              border: "1px dashed #6366f1",
              backgroundColor: "rgba(99,102,241,0.15)",
              pointerEvents: "none",
            }}
          />
        )}

        {feedbackPoints
          .filter((item) => item.pageNumber === pageNumber)
          .map((fp) => {
            const left = fp.x1 ?? 0;
            const top = fp.y1 ?? 0;
            const width = (fp.x2 ?? left) - left || 10;
            const height = (fp.y2 ?? top) - top || 10;
            const isHovered = (fp.id ?? 0) === hoveredCommentId;
            return (
              <div
                key={fp.id ?? `${pageNumber}-${left}-${top}`}
                style={{
                  position: "absolute",
                  left: `${left}%`,
                  top: `${top}%`,
                  width: `${width}%`,
                  height: `${height}%`,
                  border: isHovered ? "2px solid #3B82F6" : "2px solid #EF4444",
                  background: isHovered
                    ? "rgba(59,130,246,0.3)"
                    : "rgba(255,0,0,0.3)",
                  cursor: "pointer",
                }}
              />
            );
          })}

        {addingFeedback && (
          <CommentForm
            position={{ x1: addingFeedback.x1, y1: addingFeedback.y1 }}
            onSubmit={handleAddSubmit}
          />
        )}
        {editingFeedback && (
          <CommentForm
            position={{
              x1: editingFeedback.x1,
              y1: editingFeedback.y1,
            }}
            initialComment={editingFeedback.content}
          />
        )}
      </div>
    );
  }
);

PDF.displayName = "PDFSimple75vhRAFBatchingPaint";
export default PDF;


