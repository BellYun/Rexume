"use client";

import React, { useState, useRef, useEffect, forwardRef, useCallback } from "react";
import CommentForm from "../../comment_old/CommentForm";
import { FeedbackPoint } from "@/types/FeedbackPointType";
import {
  type PDFDocumentProxy,
  RenderTask,
} from "pdfjs-dist";

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

const PDF = forwardRef<HTMLDivElement, PDFProps>(({
  pdf,
  pageNumber,
  addFeedbackPoint,
  feedbackPoints,
  hoveredCommentId,
}, ref) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const renderedRef = useRef(false);

  const [rendered, setRendered] = useState(false);
  const [viewportWH, setViewportWH] = useState<{ w: number; h: number } | null>(
    null
  );

  // 페이지 크기 미리 계산 (placeholder 높이 확보)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const page = await pdf.getPage(pageNumber);
        if (cancelled) return;
        const viewport = page.getViewport({ scale: 2, rotation: 0 });
        setViewportWH({ w: viewport.width, h: viewport.height });
      } catch {}
    })();
    return () => {
      cancelled = true;
    };
  }, [pdf, pageNumber]);

  // 외부에서 렌더링 트리거할 수 있는 함수
  const renderPage = useCallback(async () => {
    if (renderedRef.current || !canvasRef.current) return;

    try {
      console.log(`[Opt1-RAF] Starting render for page ${pageNumber}`);
      
      // 성능 측정 시작
      const t0 = performance.now();
      
      const page = await pdf.getPage(pageNumber);
      const t1 = performance.now();
      
      const viewport = page.getViewport({ scale: 2, rotation: 0 });
      const canvas = canvasRef.current;
      const ctx = canvas.getContext("2d");
      
      if (!ctx) {
        console.error(`Context not found for page ${pageNumber}`);
        return;
      }

      canvas.width = viewport.width;
      canvas.height = viewport.height;

      // 기존 렌더 취소
      if (renderTaskRef.current) {
        try {
          renderTaskRef.current.cancel();
        } catch {}
      }

      const task = page.render({ canvasContext: ctx, viewport });
      renderTaskRef.current = task;

      await task.promise;
      const t2 = performance.now();
      
      // 🎯 최적화 1: requestAnimationFrame을 통한 페인트 안정화
      await new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => r()))
      );
      const t3 = performance.now();
      
      renderedRef.current = true;
      setRendered(true);
      
      // 메트릭 수집 - paintMs 추가
      const metrics = {
        page: pageNumber,
        getPageMs: parseFloat((t1 - t0).toFixed(1)),
        renderMs: parseFloat((t2 - t1).toFixed(1)),
        paintMs: parseFloat((t3 - t2).toFixed(1)),
        totalMs: parseFloat((t3 - t0).toFixed(1)),
      };
      
      console.log(`[pdfOpt1-RAF] 페이지 ${pageNumber} 렌더링 완료: ${metrics.totalMs.toFixed(1)}ms (paint: ${metrics.paintMs.toFixed(1)}ms)`);
      
      // 벤치마크 메트릭 수집기에 전달
      if (typeof window !== 'undefined' && (window as any).pdfRenderMetricsCollector) {
        (window as any).pdfRenderMetricsCollector.add(metrics);
      }
    } catch (e: any) {
      if (e?.name === "RenderingCancelledException") {
        console.log(`Page ${pageNumber} rendering cancelled`);
      } else {
        console.error(`page ${pageNumber} render error`, e);
      }
    }
  }, [pdf, pageNumber]);


  // 드래그 선택 / 코멘트 로직
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
    if (selectedArea && ref && typeof ref !== 'function') {
      const element = ref.current;
      if (element && 'getBoundingClientRect' in element) {
        const rect = (element as HTMLDivElement).getBoundingClientRect();
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
      }
    }
  };

  const handleAddSubmit = (comment: string) => {
    if (addingFeedback) {
      addFeedbackPoint({
        pageNumber: addingFeedback.pageNumber,
        x1: addingFeedback.x1,
        x2: addingFeedback.x2,
        y1: addingFeedback.y1,
        y2: addingFeedback.y2,
        content: comment,
      });
      setAddingFeedback(null);
    }
  };

  // 렌더 전 placeholder 높이
  const placeholderStyle: React.CSSProperties = viewportWH
    ? {
        width: "100%",
        height: viewportWH.h,
        background: "#f3f4f6",
      }
    : { width: "100%", aspectRatio: "1/1.414", background: "#f3f4f6" };

  return (
    <div
      ref={(element) => {
        // forwardRef의 ref 설정
        if (typeof ref === 'function') {
          ref(element);
        } else if (ref) {
          (ref as React.MutableRefObject<HTMLDivElement | null>).current = element;
        }
        
        // 함수 바로 연결
        if (element) {
          (element as any).renderPage = renderPage;
          (element as any).rendered = () => renderedRef.current;
          console.log(`Page ${pageNumber}: renderPage function attached (Opt1-RAF)`);
        }
      }}
      data-page-number={pageNumber}
      style={{ position: "relative", marginBottom: 20 }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    >
      {/* Canvas는 항상 렌더링, 렌더 완료 전에는 placeholder 표시 */}
      <canvas 
        ref={canvasRef} 
        style={{ 
          display: rendered ? "block" : "none",
          width: "100%",
        }} 
      />
      {!rendered && <div className="pdf-placeholder" style={placeholderStyle} />}

      {/* 드래그 선택 영역 */}
      {selectedArea && (
        <div
          style={{
            position: "absolute",
            left: selectedArea.x,
            top: selectedArea.y,
            width: selectedArea.width,
            height: selectedArea.height,
            border: "2px dashed blue",
            pointerEvents: "none",
          }}
        />
      )}

      {/* 피드백 하이라이트 */}
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
                border: isHovered
                  ? "2px solid #3B82F6"
                  : "2px solid #EF4444",
                background: isHovered
                  ? "rgba(59,130,246,0.3)"
                  : "rgba(255,0,0,0.3)",
                cursor: "pointer",
              }}
            />
          );
        })}

      {/* 코멘트 입력 */}
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
});

PDF.displayName = 'PDF';

export default PDF;

