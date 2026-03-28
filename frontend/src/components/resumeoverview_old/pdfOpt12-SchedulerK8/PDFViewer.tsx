"use client";

import { useEffect, useState, useRef } from "react";
import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentProxy,
} from "pdfjs-dist/build/pdf"; 

import PDF from "./PDF";
import { FeedbackPoint } from "@/types/FeedbackPointType";
import { AddFeedbackPoint } from "@/types/AddFeedbackPointType";

// PDF DOM 요소 타입 정의
interface PDFElement extends HTMLDivElement {
  renderPage?: () => Promise<void>;
  rendered?: () => boolean;
}

// 워커 초기화 상태 관리
let workerInitialized = false;

// 워커 초기화 함수
const initializeWorker = (): void => {
  if (workerInitialized) return;
  
  try {
    console.log('PDF 워커 초기화 시작');
    GlobalWorkerOptions.workerSrc = '/pdf.worker.min.js';
    console.log('PDF 워커 경로 설정 완료:', GlobalWorkerOptions.workerSrc);
    workerInitialized = true;
  } catch (error) {
    console.error('PDF 워커 초기화 실패:', error);
    throw error;
  }
};

// 🎯 최적화 4: RenderScheduler - 동시 렌더링 제한
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
    // priority 낮을수록 먼저 (나중에 우선순위 추가 시 활용)
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

interface PDFViewerProps {
  pdfSrc: string;
  pageNumber?: number; // optional for compatibility
  addFeedbackPoint: (point: Omit<AddFeedbackPoint, "id">) => void;
  editFeedbackPoint: (point: FeedbackPoint) => void;
  feedbackPoints: FeedbackPoint[];
  hoveredCommentId: number | null;
  setHoveredCommentId: (id: number | null) => void;
  setClickedCommentId: (id: number | null) => void;
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

  // 각 페이지별 요소 관리
  const pageElements = useRef<Map<number, PDFElement>>(new Map());
  const observerRef = useRef<IntersectionObserver | null>(null);
  
  // 🎯 Scheduler 추가
  const schedulerRef = useRef<RenderScheduler>(new RenderScheduler(8)); // K=8

  // PDF 로딩
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);

    (async () => {
      if (!pdfSrc || typeof pdfSrc !== "string" || !pdfSrc.trim()) {
        setErr("PDF URL이 비어있습니다.");
        setLoading(false);
        return;
      }
      
      try {
        console.log(`[Opt4-Scheduler] PDF 로딩 시작: ${pdfSrc}`);
        
        if (typeof window !== 'undefined') {
          initializeWorker();
          if (cancelled) return;
        }
        
        console.log('[Opt4-Scheduler] 워커 초기화 완료, PDF 문서 로딩 시작');
        
        const task = getDocument({ 
          url: pdfSrc,
          cMapUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/cmaps/',
          cMapPacked: true,
          standardFontDataUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/standard_fonts/',
          isEvalSupported: false,
          useSystemFonts: false,
        });
        
        const loaded = await task.promise;
        if (cancelled) return;
        
        console.log(`[Opt4-Scheduler] PDF 문서 로딩 완료: ${loaded.numPages}페이지`);
        
        setPdf(loaded);
        setNumPages(loaded.numPages);
        setLoading(false);
        
      } catch (e: any) {
        if (cancelled) return;
        console.error("[Opt4-Scheduler] PDF 로딩 실패:", e);
        setErr(`PDF 로딩에 실패했습니다: ${e.message || '알 수 없는 오류'}`);
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [pdfSrc]);

  // IntersectionObserver - Scheduler를 통한 렌더링
  useEffect(() => {
    if (!pdf || numPages === 0) return;

    observerRef.current = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const pageElement = entry.target as PDFElement;
          const pageNumber = parseInt(pageElement.dataset.pageNumber || '1');

          if (entry.isIntersecting) {
            console.log(`[Opt4-Scheduler] Page ${pageNumber} is intersecting`);
            
            if (pageElement.rendered && pageElement.rendered()) {
              console.log(`[Opt4-Scheduler] Page ${pageNumber} already rendered`);
              return;
            }

            // 🎯 Scheduler를 통한 렌더링 (동시성 제한)
            schedulerRef.current.enqueue({
              id: `page-${pageNumber}`,
              priority: pageNumber, // 단순히 페이지 번호로 우선순위 (우선순위 정렬은 Opt6에서)
              run: async () => {
                if (pageElement.renderPage) {
                  console.log(`[Opt4-Scheduler] Rendering page ${pageNumber} via scheduler`);
                  await pageElement.renderPage();
                }
              },
            });
          }
        });
      },
      {
        root: null,
        threshold: 0,
        rootMargin: `${typeof window !== 'undefined' ? window.innerHeight * 0.25 : 2000}px 0px`,
      }
    );

    pageElements.current.forEach((element) => {
      if (element && observerRef.current) {
        observerRef.current.observe(element);
      }
    });

    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect();
      }
    };
  }, [pdf, numPages]);

  if (err) return <div>{err}</div>;
  if (!pdf) return <div>PDF 로딩 중... (Opt4-Scheduler)</div>;

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
            ref={(el) => {
              if (el) {
                pageElements.current.set(pageNumber, el as PDFElement);
                
                const checkAndObserve = () => {
                  if ((el as any).renderPage) {
                    if (observerRef.current) {
                      observerRef.current.observe(el);
                    }
                  } else {
                    setTimeout(checkAndObserve, 10);
                  }
                };
                
                checkAndObserve();
              }
            }}
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

