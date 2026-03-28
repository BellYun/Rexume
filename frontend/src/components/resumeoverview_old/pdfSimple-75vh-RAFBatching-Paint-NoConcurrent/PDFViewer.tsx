"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentProxy,
} from "pdfjs-dist/build/pdf";

// 원본 Simple 75vh + rAF 버전의 PDF 컴포넌트를 재사용
import PDF from "../pdfSimple-75vh-RAFBatching-Paint/PDF";
import { FeedbackPoint } from "@/types/FeedbackPointType";
import { AddFeedbackPoint } from "@/types/AddFeedbackPointType";

interface PDFElement extends HTMLDivElement {
  renderPage?: () => Promise<void>;
  rendered?: () => boolean;
}

let workerInitialized = false;
const initializeWorker = (): void => {
  if (workerInitialized) return;
  GlobalWorkerOptions.workerSrc = "/pdf.worker.min.js";
  workerInitialized = true;
};

interface PDFViewerProps {
  pdfSrc: string;
  pageNumber?: number;
  addFeedbackPoint: (point: Omit<AddFeedbackPoint, "id">) => void;
  editFeedbackPoint: (point: FeedbackPoint) => void;
  feedbackPoints: FeedbackPoint[];
  hoveredCommentId: number | null;
  setHoveredCommentId: (id: number | null) => void;
  setClickedCommentId: (id: number | null) => void;
}

/**
 * Simple 75vh + rAF 배칭 + 페인트 안정화 (동시성 제한 없음 버전)
 * - 기존 pdfSimple-75vh-RAFBatching-Paint/PDFViewer 에서 동시성 제한 큐만 제거
 * - rAF 배칭과 75vh 프리워밍 동작은 그대로 유지
 */
const PDFViewer = ({
  pdfSrc,
  addFeedbackPoint,
  feedbackPoints,
  hoveredCommentId,
  setHoveredCommentId,
  setClickedCommentId,
}: PDFViewerProps) => {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const pageElements = useRef<Map<number, PDFElement>>(new Map());
  const observerRef = useRef<IntersectionObserver | null>(null);
  const pendingRef = useRef<Set<number>>(new Set());
  const scheduledRef = useRef(false);
  const queueRef = useRef<number[]>([]);

  // rAF 슬라이스로 다음 배치를 예약 (동시성 제한 없이 들어오는 대로 렌더)
  const scheduleNextFrame = useCallback(() => {
    if (scheduledRef.current) return;
    scheduledRef.current = true;
    requestAnimationFrame(() => {
      scheduledRef.current = false;
      // pending -> queue 병합(중복 제거)
      if (pendingRef.current.size > 0) {
        const incoming = Array.from(pendingRef.current).sort((a, b) => a - b);
        pendingRef.current.clear();
        const existing = new Set(queueRef.current);
        for (const p of incoming) {
          if (!existing.has(p)) {
            queueRef.current.push(p);
          }
        }
      }
      // 모든 대기중인 페이지를 rAF로 한 번에 렌더 (동시성 제한 없음)
      while (queueRef.current.length > 0) {
        const pageNumber = queueRef.current.shift()!;
        const el = pageElements.current.get(pageNumber);
        if (!el) continue;
        if (el.rendered?.()) continue;
        if (!el.renderPage) continue;
        requestAnimationFrame(() => {
          el.renderPage!().catch(() => {});
        });
      }
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        setErr(null);
        if (!pdfSrc?.trim()) {
          throw new Error("PDF URL이 비어있습니다.");
        }
        initializeWorker();
        const task = getDocument({
          url: pdfSrc,
          cMapUrl:
            "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/cmaps/",
          cMapPacked: true,
          standardFontDataUrl:
            "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/standard_fonts/",
          isEvalSupported: false,
          useSystemFonts: false,
        });
        const loaded = await task.promise;
        if (cancelled) return;
        setPdf(loaded);
        setNumPages(loaded.numPages);
      } catch (e: any) {
        if (!cancelled) setErr(e?.message ?? "PDF 로딩 실패");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pdfSrc]);

  const flushInRaf = scheduleNextFrame;

  useEffect(() => {
    if (!pdf || numPages === 0) return;

    const margin =
      typeof window !== "undefined"
        ? Math.round(window.innerHeight * 0.75)
        : 1200;

    observerRef.current = new IntersectionObserver(
      (entries) => {
        let touched = false;
        for (const entry of entries) {
          const target = entry.target as PDFElement;
          const pageNumber = Number(target.dataset.pageNumber ?? "1");
          if (entry.isIntersecting) {
            touched = true;
            pendingRef.current.add(pageNumber);
          } else {
            pendingRef.current.delete(pageNumber);
          }
        }
        if (touched) flushInRaf();
      },
      {
        root: null,
        threshold: 0,
        rootMargin: `${margin}px 0px`,
      }
    );

    pageElements.current.forEach((el) => observerRef.current?.observe(el));

    return () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      pendingRef.current.clear();
      scheduledRef.current = false;
      queueRef.current = [];
    };
  }, [pdf, numPages, flushInRaf]);

  const attachPageRef = useCallback((pageNumber: number) => {
    return (el: HTMLDivElement | null) => {
      if (!el) {
        pageElements.current.delete(pageNumber);
        return;
      }
      const cast = el as PDFElement;
      cast.dataset.pageNumber = String(pageNumber);
      pageElements.current.set(pageNumber, cast);
      if (observerRef.current) {
        observerRef.current.observe(cast);
      }
    };
  }, []);

  if (err) return <div>{err}</div>;
  if (loading || !pdf) return <div>PDF 로딩 중...</div>;

  return (
    <div
      style={{
        width: 1200,
        margin: "auto",
        overflowY: "auto",
        maxHeight: "90vh",
      }}
    >
      {Array.from({ length: numPages }).map((_, idx) => {
        const pageNumber = idx + 1;
        return (
          <PDF
            key={`page-${pageNumber}`}
            ref={attachPageRef(pageNumber)}
            pdf={pdf}
            pageNumber={pageNumber}
            feedback={[]}
            addFeedbackPoint={addFeedbackPoint}
            feedbackPoints={feedbackPoints}
            hoveredCommentId={hoveredCommentId}
            setHoveredCommentId={setHoveredCommentId}
            setClickedCommentId={setClickedCommentId}
          />
        );
      })}
    </div>
  );
};

export default PDFViewer;


