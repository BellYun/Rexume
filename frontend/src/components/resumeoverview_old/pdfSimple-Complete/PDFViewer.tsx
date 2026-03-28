"use client";

import { useEffect, useState, useRef, useCallback } from "react";
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
    
    // public 폴더의 워커 파일 사용 (가장 안정적)
    GlobalWorkerOptions.workerSrc = '/pdf.worker.min.js';
    
    console.log('PDF 워커 경로 설정 완료:', GlobalWorkerOptions.workerSrc);
    workerInitialized = true;
    
  } catch (error) {
    console.error('PDF 워커 초기화 실패:', error);
    throw error;
  }
};

interface PDFViewerProps {
  pdfSrc: string;
  pageNumber: number;
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

  // 성능 추적을 위한 useEffect 훅
  useEffect(() => {
    if (typeof window !== 'undefined' && (window as any).__reactPerformanceTracker) {
      const startTime = (window as any).__reactPerformanceTracker.renderStart('PDFViewerOpt1RAF');
      return () => (window as any).__reactPerformanceTracker.renderEnd('PDFViewerOpt1RAF', startTime);
    }
  });

  // setState 호출 추적
  useEffect(() => {
    if (typeof window !== 'undefined' && (window as any).setStateTracker) {
      (window as any).setStateTracker.trackStateChange('PDFViewerOpt1RAF', 'pdf-updated', performance.now(), performance.now() + 1);
    }
  }, [pdf]);

  useEffect(() => {
    if (typeof window !== 'undefined' && (window as any).setStateTracker) {
      (window as any).setStateTracker.trackStateChange('PDFViewerOpt1RAF', 'numPages-updated', performance.now(), performance.now() + 1);
    }
  }, [numPages]);
  
  // 각 페이지별 요소 관리
  const pageElements = useRef<Map<number, PDFElement>>(new Map());
  const observerRef = useRef<IntersectionObserver | null>(null);
  
  // 🎯 최적화 8: RAF 배칭을 위한 pending 집합
  const pendingRef = useRef<Set<number>>(new Set());
  const scheduledRef = useRef(false);

  const flushInRaf = useCallback(() => {
    if (scheduledRef.current) return;
    scheduledRef.current = true;
    
    // 🎯 IntersectionObserver 콜백을 rAF로 배칭
    requestAnimationFrame(() => {
      scheduledRef.current = false;
      const pages = Array.from(pendingRef.current);
      pendingRef.current.clear();

      // 순서대로 렌더링
      pages.forEach((n) => {
        const el = pageElements.current.get(n);
        if (!el) return;
        
        // 이미 렌더링 완료면 스킵
        if (el.rendered?.()) return;

        // 직접 렌더링
        if (el.renderPage) {
          console.log(`[Opt8-RAF-Paint-Batching] Rendering page ${n} in rAF batch`);
          el.renderPage();
        }
      });
    });
  }, []);

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
        console.log(`[Opt8-RAF-Paint-Batching] PDF 로딩 시작: ${pdfSrc}`);
        
        // 1단계: 워커 초기화 (필수)
        if (typeof window !== 'undefined') {
          initializeWorker();
          if (cancelled) return;
        }
        
        console.log('[Opt8-RAF-Paint-Batching] 워커 초기화 완료, PDF 문서 로딩 시작');
        
        // 2단계: PDF 문서 로딩
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
        
        console.log(`[Opt8-RAF-Paint-Batching] PDF 문서 로딩 완료: ${loaded.numPages}페이지`);
        
        // 커밋 추적 - PDF 로드 완료
        if (typeof window !== 'undefined' && (window as any).commitTracker) {
          const commitStartTime = performance.now();
          setPdf(loaded);
          setNumPages(loaded.numPages);
          setLoading(false);
          const commitEndTime = performance.now();
          (window as any).commitTracker.trackCommit('pdf-loaded', commitStartTime, commitEndTime, {
            numPages: loaded.numPages
          });
        } else {
          setPdf(loaded);
          setNumPages(loaded.numPages);
          setLoading(false);
        }
        
      } catch (e: any) {
        if (cancelled) return;
        console.error("[Opt8-RAF-Paint-Batching] PDF 로딩 실패:", e);
        setErr(`PDF 로딩에 실패했습니다: ${e.message || '알 수 없는 오류'}`);
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [pdfSrc]);

  // IntersectionObserver - RAF 배칭
  useEffect(() => {
    if (!pdf || numPages === 0) return;

    observerRef.current = new IntersectionObserver(
      (entries) => {
        let touched = false;
        
        for (const entry of entries) {
          const target = entry.target as PDFElement;
          const n = Number((target.dataset.pageNumber as string) ?? "1");
          
          if (entry.isIntersecting) {
            touched = true;
            pendingRef.current.add(n);
            console.log(`[Opt8-RAF-Paint-Batching] Page ${n} added to pending batch`);
          } else {
            // 교차 해제 시 큐에서 제거
            pendingRef.current.delete(n);
          }
        }
        
        // 🎯 IO 콜백 → rAF 배칭
        if (touched) {
          flushInRaf();
        }
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
      pendingRef.current.clear();
      scheduledRef.current = false;
    };
  }, [pdf, numPages, flushInRaf]);

  // DOM 초기화 커밋 추적
  useEffect(() => {
    if (pdf && numPages > 0) {
      if (typeof window !== 'undefined' && (window as any).commitTracker) {
        const commitStartTime = performance.now();
        setTimeout(() => {
          const commitEndTime = performance.now();
          (window as any).commitTracker.trackCommit('dom-initialization', commitStartTime, commitEndTime, {
            totalPages: numPages,
            type: 'opt1-raf-all-pages-at-once'
          });
        }, 100);
      }
    }
  }, [pdf, numPages]);

  if (err) return <div>{err}</div>;
  if (!pdf) return <div>PDF 로딩 중... (Opt8-RAF-Paint-Batching)</div>;

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
                
                if (typeof window !== 'undefined' && (window as any).commitTracker) {
                  const commitStartTime = performance.now();
                  setTimeout(() => {
                    const commitEndTime = performance.now();
                    (window as any).commitTracker.trackCommit('page-dom-added', commitStartTime, commitEndTime, {
                      pageNumber,
                      type: 'opt1-raf-initial-render'
                    });
                  }, 50);
                }
                
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

