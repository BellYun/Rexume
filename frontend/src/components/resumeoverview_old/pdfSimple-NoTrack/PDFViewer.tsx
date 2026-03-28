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

  // 각 페이지별 요소 관리
  const pageElements = useRef<Map<number, PDFElement>>(new Map());
  const observerRef = useRef<IntersectionObserver | null>(null);

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
        // 1단계: 워커 초기화 (필수)
        if (typeof window !== 'undefined') {
          initializeWorker();
          if (cancelled) return;
        }

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
        setPdf(loaded);
        setNumPages(loaded.numPages);
        setLoading(false);

      } catch (e: any) {
        if (cancelled) return;
        console.error("PDF 로딩 실패:", e);
        setErr(`PDF 로딩에 실패했습니다: ${e.message || '알 수 없는 오류'}`);
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [pdfSrc]);

  // IntersectionObserver 설정 - 스케줄러 없이 직접 렌더링
  useEffect(() => {
    if (!pdf || numPages === 0) return;

    const margin =
      typeof window !== 'undefined'
        ? Math.round(window.innerHeight * 0.75) // 75vh 프리워밍
        : 1200;

    // observer 생성
    observerRef.current = new IntersectionObserver(
      (entries) => {
        entries.forEach(async (entry) => {
          const pageElement = entry.target as PDFElement;
          const pageNumber = parseInt(pageElement.dataset.pageNumber || '1');

          if (entry.isIntersecting) {
            if (pageElement.rendered && pageElement.rendered()) {
              return;
            }

            // 직접 렌더링
            if (pageElement.renderPage) {
              await pageElement.renderPage();
            } else {
              // 잠시 후 다시 시도
              setTimeout(() => {
                if (pageElement.renderPage) {
                  pageElement.renderPage();
                }
              }, 100);
            }
          }
        });
      },
      {
        root: null,
        threshold: 0,
        rootMargin: `${margin}px 0px`,
      }
    );

    // 이미 등록된 페이지들을 observer에 추가
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
  if (!pdf) return <div>PDF 로딩 중...</div>;

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
                // 바로 observer에 등록하고 요소 저장
                pageElements.current.set(pageNumber, el as PDFElement);
                
                // Simple 버전에서 각 페이지 DOM 추가 시 커밋 추적
                // 함수가 설정될 때까지 잠시 기다린 후 observer 등록
                const checkAndObserve = () => {
                  if ((el as any).renderPage) {
                    if (observerRef.current) {
                      observerRef.current.observe(el);
                    }
                  } else {
                    // 함수가 아직 없으면 10ms 후 다시 시도
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
