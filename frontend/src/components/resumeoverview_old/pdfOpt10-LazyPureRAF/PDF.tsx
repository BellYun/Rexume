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
  ({ pdf, pageNumber, addFeedbackPoint, feedbackPoints, hoveredCommentId }, ref) => {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const renderTaskRef = useRef<RenderTask | null>(null);
    const renderedRef = useRef(false);

    const [rendered, setRendered] = useState(false);

    // Lazy: 실제 렌더링 시점에만 getPage() 호출 (페이지 크기 미리 계산 제거)
    const renderPage = useCallback(async () => {
      if (renderedRef.current || !canvasRef.current) return;
      try {
        const t0 = performance.now();
        // Lazy getPage: 렌더링 시점에 호출
        const page = await pdf.getPage(pageNumber);
        const t1 = performance.now();

        const viewport = page.getViewport({ scale: 2, rotation: 0 });
        const canvas = canvasRef.current!;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        canvas.width = viewport.width;
        canvas.height = viewport.height;

        // 기존 작업 취소
        try {
          renderTaskRef.current?.cancel();
        } catch {}

        const task = page.render({ canvasContext: ctx, viewport });
        renderTaskRef.current = task;
        await task.promise;
        const t2 = performance.now();

        renderedRef.current = true;
        setRendered(true);

        console.log(`[Opt10-LazyPureRAF] 페이지 ${pageNumber} 렌더링: ${(t2-t0).toFixed(1)}ms`);
      } catch (e: any) {
        if (e?.name !== "RenderingCancelledException") {
          console.error(`page ${pageNumber} render error`, e);
        }
      }
    }, [pdf, pageNumber]);

    // callback ref: 마운트 순간에 hostRef + 외부 API 부착
    const setHostRef = useCallback(
      (el: HTMLDivElement | null) => {
        hostRef.current = el;
        if (!el) return;

        // 외부에서 호출 가능하도록 attach
        (el as any).renderPage = renderPage;
        (el as any).rendered = () => renderedRef.current;

        // forwardRef 체인
        if (typeof ref === "function") ref(el);
        else if (ref) ref.current = el;
      },
      [ref, renderPage]
    );

    // Placeholder 고정 비율 사용 (A4: 1.414)
    const placeholderHeight = 1200 * 1.414; // width 1200 기준

    return (
      <div
        ref={setHostRef}
        data-page-number={pageNumber}
        style={{ position: "relative", marginBottom: 16, backgroundColor: "#fff" }}
      >
        <div
          style={{
            width: 1200,
            height: placeholderHeight,
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
              const canvas = canvasRef.current;
              if (!canvas) return null;

              const scaleX = canvas.offsetWidth / canvas.width;
              const scaleY = canvas.offsetHeight / canvas.height;

              const left = item.x1 * scaleX;
              const top = item.y1 * scaleY;
              const width = (item.x2 - item.x1) * scaleX;
              const height = (item.y2 - item.y1) * scaleY;

              const isHovered = item.id === hoveredCommentId;

              return (
                <div
                  key={item.id}
                  style={{
                    position: "absolute",
                    left,
                    top,
                    width,
                    height,
                    border: "2px solid red",
                    backgroundColor: isHovered ? "rgba(255,0,0,0.2)" : "transparent",
                    pointerEvents: "none",
                    zIndex: isHovered ? 10 : 1,
                  }}
                />
              );
            })}

        {/* Opt10-LazyPureRAF: 선택 입력 폼 생략 */}
      </div>
    );
  }
);

PDF.displayName = "PDF-Opt10-LazyPureRAF";
export default PDF;

