"use client";

import { useEffect, useState, useRef, useMemo, useCallback } from "react";
import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentProxy,
} from "pdfjs-dist/build/pdf";

import PDF from "./PDF";
import { FeedbackPoint } from "@/types/FeedbackPointType";
import { AddFeedbackPoint } from "@/types/AddFeedbackPointType";

// ForwardRef로 받은 DOM에 붙는 메서드 타입
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
  addFeedbackPoint: (point: Omit<AddFeedbackPoint, "id">) => void;
  editFeedbackPoint: (point: FeedbackPoint) => void;
  feedbackPoints: FeedbackPoint[];
  hoveredCommentId: number | null;
  setHoveredCommentId: (id: number | null) => void;
  setClickedCommentId: (id: number | null) => void;
}

/** 간단한 우선순위 스케줄러: 근접도 우선 + 동시성 K */
class RenderScheduler {
  private K: number;
  private inFlight = 0;
  private q: { id: string; priority: number; run: () => Promise<void> }[] = [];
  private enqueued = new Set<string>();

  constructor(K = 4) {
    this.K = K;
  }
  setConcurrency(k: number) {
    this.K = Math.max(1, k);
    this.drain();
  }
  enqueue(job: { id: string; priority: number; run: () => Promise<void> }) {
    if (this.enqueued.has(job.id)) return;
    this.enqueued.add(job.id);
    this.q.push(job);
    // priority 낮을수록 먼저
    this.q.sort((a, b) => a.priority - b.priority);
    this.drain();
  }
  private drain() {
    while (this.inFlight < this.K && this.q.length) {
      const job = this.q.shift()!;
      this.inFlight++;
      job
        .run()
        .catch(() => {})
        .finally(() => {
          this.inFlight--;
          this.enqueued.delete(job.id);
          this.drain();
        });
    }
  }
}

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

  // 페이지 DOM 보관
  const pageElements = useRef<Map<number, PDFElement>>(new Map());
  // Shared IO / Scheduler
  const observerRef = useRef<IntersectionObserver | null>(null);
  const schedulerRef = useRef<RenderScheduler>(new RenderScheduler(4));

  // PDF 로딩
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

  /** rAF 배칭을 위한 pending 집합 */
  const pendingRef = useRef<Set<number>>(new Set());
  const scheduledRef = useRef(false);

  const flushInRaf = useCallback(() => {
    if (scheduledRef.current) return;
    scheduledRef.current = true;
    requestAnimationFrame(() => {
      scheduledRef.current = false;
      const pages = Array.from(pendingRef.current);
      pendingRef.current.clear();

      // 우선순위 = viewport 중심으로부터의 거리(px)
      const viewportCenter =
        typeof window !== "undefined"
          ? window.scrollY + window.innerHeight / 2
          : 0;

      pages
        .map((n) => {
          const el = pageElements.current.get(n);
          const rect = el?.getBoundingClientRect();
          const pageCenter =
            (rect?.top ?? 0) + window.scrollY + (rect?.height ?? 0) / 2;
          const priority = Math.abs(pageCenter - viewportCenter);
          return { n, el, priority };
        })
        .sort((a, b) => a.priority - b.priority)
        .forEach(({ n, el, priority }) => {
          if (!el) return;
          // 이미 렌더링 완료면 스킵
          if (el.rendered?.()) return;

          schedulerRef.current.enqueue({
            id: `page-${n}`,
            priority,
            run: async () => {
              // 중간에 attach 안됐으면 skip
              if (!el.renderPage) return;
              await el.renderPage();
            },
          });
        });
    });
  }, []);

  // Shared IO 생성/정리
  useEffect(() => {
    if (!pdf || numPages === 0) return;

    const margin =
      typeof window !== "undefined"
        ? Math.round(window.innerHeight * 0.75) // 75vh 프리워밍
        : 1200;

    observerRef.current = new IntersectionObserver(
      (entries) => {
        let touched = false;
        for (const entry of entries) {
          const target = entry.target as PDFElement;
          const n = Number((target.dataset.pageNumber as string) ?? "1");
          if (entry.isIntersecting) {
            touched = true;
            pendingRef.current.add(n);
          } else {
            // 교차 해제 시 굳이 큐에 남겨둘 필요 없음
            pendingRef.current.delete(n);
          }
        }
        if (touched) flushInRaf(); // IO 콜백 → rAF 배칭
      },
      {
        root: null,
        threshold: 0,
        rootMargin: `${margin}px 0px`,
      }
    );

    // 이미 등록된 페이지 attach
    pageElements.current.forEach((el) => observerRef.current!.observe(el));

    return () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      pendingRef.current.clear();
      scheduledRef.current = false;
      // 스케줄러는 유지(리스트 새로 렌더 시에도 in-flight 마무리 가능)
    };
  }, [pdf, numPages, flushInRaf]);

  // callback ref: 마운트 순간에 바로 observe (Effect 재실행 최소화)
  const attachPageRef = useCallback((pageNumber: number) => {
    return (el: HTMLDivElement | null) => {
      if (!el) {
        pageElements.current.delete(pageNumber);
        return;
      }
      const cast = el as PDFElement;
      cast.dataset.pageNumber = String(pageNumber);
      pageElements.current.set(pageNumber, cast);
      observerRef.current?.observe(cast);
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
