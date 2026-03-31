"use client";

import React, { useRef, useState, useEffect, useCallback } from "react";
import { type PDFDocumentProxy, type RenderTask } from "pdfjs-dist";
import { FeedbackPoint } from "@/types/FeedbackPointType";
import CommentForm from "@/components/comment_old/CommentForm";

export const SCALE = 2;
export const PAGE_GAP = 20; // marginBottom px

export interface PageAPI {
  renderPage: () => Promise<void>;
  rendered: () => boolean;
}

interface PDFProps {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  pageHeight: number; // placeholder 높이 (px)
  feedbackPoints: FeedbackPoint[];
  hoveredCommentId: number | null;
  addFeedbackPoint: (point: {
    pageNumber: number;
    x1: number;
    x2: number;
    y1: number;
    y2: number;
    content: string;
  }) => void;
  setHoveredCommentId: (id: number | null) => void;
  setClickedCommentId: (id: number | null) => void;
  onRegister: (pageNum: number, api: PageAPI) => void;
  onUnregister: (pageNum: number) => void;
}

/**
 * PDF 단일 페이지 컴포넌트
 *
 * - 마운트 즉시 렌더링하지 않는다. 부모(PDFViewer)의 스케줄러가
 *   onRegister로 받은 api.renderPage()를 우선순위에 따라 호출한다.
 * - 언마운트 시 진행 중인 RenderTask를 취소하고 api를 해제한다.
 * - React.memo로 감싸 불필요한 리렌더를 방지한다.
 */
const PDF = React.memo(function PDF({
  pdf,
  pageNumber,
  pageHeight,
  feedbackPoints,
  hoveredCommentId,
  addFeedbackPoint,
  setHoveredCommentId,
  setClickedCommentId,
  onRegister,
  onUnregister,
}: PDFProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const renderedRef = useRef(false);
  const [rendered, setRendered] = useState(false);

  // 드래그 선택 상태
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

  // 부모 스케줄러가 호출하는 렌더 함수
  const renderPage = useCallback(async () => {
    if (renderedRef.current || !canvasRef.current) return;
    try {
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: SCALE });
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      canvas.width = viewport.width;
      canvas.height = viewport.height;

      renderTaskRef.current?.cancel();
      const task = page.render({ canvasContext: ctx, viewport });
      renderTaskRef.current = task;
      await task.promise;

      renderedRef.current = true;
      setRendered(true);
    } catch (e: unknown) {
      if (e instanceof Error && e.name !== "RenderingCancelledException") {
        console.error(`page ${pageNumber} render error`, e);
      }
    }
  }, [pdf, pageNumber]);

  // 마운트: API 등록 / 언마운트: 렌더 취소 + API 해제
  // React는 자식 effect를 부모보다 먼저 실행하므로,
  // 부모의 visibleRange effect가 실행될 때 api는 이미 등록되어 있다.
  useEffect(() => {
    onRegister(pageNumber, { renderPage, rendered: () => renderedRef.current });
    return () => {
      renderTaskRef.current?.cancel();
      onUnregister(pageNumber);
    };
  }, [pageNumber, renderPage, onRegister, onUnregister]);

  // --- 드래그 선택 핸들러 ---
  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setStartPos({ x, y });
    setSelectedArea({ x, y, width: 0, height: 0 });
    setIsSelecting(true);
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isSelecting) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    setSelectedArea({
      x: Math.min(startPos.x, cx),
      y: Math.min(startPos.y, cy),
      width: Math.abs(cx - startPos.x),
      height: Math.abs(cy - startPos.y),
    });
  };

  const handleMouseUp = (e: React.MouseEvent<HTMLDivElement>) => {
    setIsSelecting(false);
    if (!selectedArea || selectedArea.width < 5 || selectedArea.height < 5) {
      setSelectedArea(null);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    setAddingFeedback({
      x1: (selectedArea.x / rect.width) * 100,
      x2: ((selectedArea.x + selectedArea.width) / rect.width) * 100,
      y1: (selectedArea.y / rect.height) * 100,
      y2: ((selectedArea.y + selectedArea.height) / rect.height) * 100,
      pageNumber,
    });
    setSelectedArea(null);
  };

  const pageFeedbacks = feedbackPoints.filter(
    (fp) => fp.pageNumber === pageNumber
  );

  return (
    <div
      style={{ position: "relative", marginBottom: PAGE_GAP }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    >
      {/* 캔버스: 렌더 완료 전까지 숨김 */}
      <canvas
        ref={canvasRef}
        style={{ display: rendered ? "block" : "none", width: "100%" }}
      />

      {/* 렌더 전 placeholder: 정확한 높이를 미리 점유해 스크롤 계산 정확도 유지 */}
      {!rendered && (
        <div
          style={{
            width: "100%",
            height: pageHeight,
            background: "#f3f4f6",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#9ca3af",
            fontSize: 13,
            userSelect: "none",
          }}
        >
          {pageNumber}
        </div>
      )}

      {/* 드래그 선택 오버레이 */}
      {selectedArea && isSelecting && (
        <div
          style={{
            position: "absolute",
            left: selectedArea.x,
            top: selectedArea.y,
            width: selectedArea.width,
            height: selectedArea.height,
            border: "2px dashed #3b82f6",
            pointerEvents: "none",
          }}
        />
      )}

      {/* 피드백 포인트 오버레이 */}
      {pageFeedbacks.map((fp) => {
        const isHovered = fp.id === hoveredCommentId;
        return (
          <div
            key={fp.id}
            style={{
              position: "absolute",
              left: `${fp.x1}%`,
              top: `${fp.y1}%`,
              width: `${fp.x2 - fp.x1}%`,
              height: `${fp.y2 - fp.y1}%`,
              border: isHovered ? "2px solid #3B82F6" : "2px solid #EF4444",
              background: isHovered
                ? "rgba(59,130,246,0.3)"
                : "rgba(255,0,0,0.3)",
              cursor: "pointer",
            }}
            onMouseEnter={() => setHoveredCommentId(fp.id)}
            onMouseLeave={() => setHoveredCommentId(null)}
            onClick={() => setClickedCommentId(fp.id)}
          />
        );
      })}

      {/* 피드백 작성 폼 */}
      {addingFeedback && (
        <CommentForm
          position={{ x1: addingFeedback.x1, y1: addingFeedback.y1 }}
          onSubmit={(content) => {
            addFeedbackPoint({ ...addingFeedback, content });
            setAddingFeedback(null);
          }}
          onCancel={() => setAddingFeedback(null)}
        />
      )}
    </div>
  );
});

export default PDF;
