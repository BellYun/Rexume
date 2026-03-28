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
  
  // 🎯 최적화 5: RAF 배칭을 위한 pending 집합
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

      // 순서대로 렌더링 (우선순위 없음)
      pages.forEach((n) => {
        const el = pageElements.current.get(n);
        if (!el) return;
        
        // 이미 렌더링 완료면 스킵
        if (el.rendered?.()) return;

        // 직접 렌더링 (스케줄러 없음)
        if (el.renderPage) {
          console.log(`[Opt5-RAFBatching] Rendering page ${n} in rAF batch`);
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
        console.log(`[Opt5-RAFBatching] PDF 로딩 시작: ${pdfSrc}`);
        
        if (typeof window !== 'undefined') {
          initializeWorker();
          if (cancelled) return;
        }
        
        console.log('[Opt5-RAFBatching] 워커 초기화 완료, PDF 문서 로딩 시작');
        
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
        
        console.log(`[Opt5-RAFBatching] PDF 문서 로딩 완료: ${loaded.numPages}페이지`);
        
        setPdf(loaded);
        setNumPages(loaded.numPages);
        setLoading(false);
        
      } catch (e: any) {
        if (cancelled) return;
        console.error("[Opt5-RAFBatching] PDF 로딩 실패:", e);
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
            console.log(`[Opt5-RAFBatching] Page ${n} added to pending batch`);
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

  if (err) return <div>{err}</div>;
  if (!pdf) return <div>PDF 로딩 중... (Opt5-RAFBatching)</div>;

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

