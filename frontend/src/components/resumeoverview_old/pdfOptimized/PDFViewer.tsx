"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentProxy,
} from "pdfjs-dist/build/pdf";
import PDF, { PAGE_GAP, SCALE, type PageAPI } from "./PDF";
import { FeedbackPoint } from "@/types/FeedbackPointType";
import { AddFeedbackPoint } from "@/types/AddFeedbackPointType";

// ─── 상수 ───────────────────────────────────────────────────────────────────
const CONTAINER_WIDTH = 1200; // px, 컨테이너 고정 너비
const BUFFER = 3;             // 뷰포트 밖으로 유지할 버퍼 페이지 수
const CONCURRENCY = 4;        // 동시 렌더링 최대 수

// ─── Worker 초기화 (한 번만) ─────────────────────────────────────────────────
let workerReady = false;
function initWorker() {
  if (workerReady || typeof window === "undefined") return;
  GlobalWorkerOptions.workerSrc = "/pdf.worker.min.js";
  workerReady = true;
}

// ─── 우선순위 스케줄러 ────────────────────────────────────────────────────────
/**
 * 동시성 K를 초과하지 않는 선에서 priority(viewport 거리) 오름차순으로 렌더링.
 *
 * invalidate(id): 페이지가 윈도우 밖으로 나갈 때 done·queue에서 제거해
 *                 재진입 시 다시 렌더링되도록 한다.
 */
class Scheduler {
  private K: number;
  private inFlight = 0;
  private queue: { id: string; priority: number; run: () => Promise<void> }[] =
    [];
  private inQueue = new Set<string>();
  private done = new Set<string>();

  constructor(k = CONCURRENCY) {
    this.K = k;
  }

  enqueue(job: { id: string; priority: number; run: () => Promise<void> }) {
    if (this.done.has(job.id) || this.inQueue.has(job.id)) return;
    this.inQueue.add(job.id);
    this.queue.push(job);
    this.queue.sort((a, b) => a.priority - b.priority);
    this.flush();
  }

  /** 페이지 언마운트 시 호출: done·queue에서 제거해 재진입 시 재렌더 가능 */
  invalidate(id: string) {
    this.done.delete(id);
    this.queue = this.queue.filter((j) => j.id !== id);
    this.inQueue.delete(id);
  }

  private flush() {
    while (this.inFlight < this.K && this.queue.length) {
      const job = this.queue.shift()!;
      this.inQueue.delete(job.id);
      this.inFlight++;
      job
        .run()
        .then(() => this.done.add(job.id))
        .catch(() => {
          /* RenderingCancelledException 등 – PDF 컴포넌트에서 이미 처리 */
        })
        .finally(() => {
          this.inFlight--;
          this.flush();
        });
    }
  }
}

// ─── Props ───────────────────────────────────────────────────────────────────
interface PDFViewerProps {
  pdfSrc: string;
  addFeedbackPoint: (point: Omit<AddFeedbackPoint, "id">) => void;
  editFeedbackPoint: (point: FeedbackPoint) => void;
  feedbackPoints: FeedbackPoint[];
  hoveredCommentId: number | null;
  setHoveredCommentId: (id: number | null) => void;
  setClickedCommentId: (id: number | null) => void;
}

// ─── PDFViewer ───────────────────────────────────────────────────────────────
/**
 * True DOM Windowing 기반 PDF 뷰어
 *
 * 핵심 아이디어:
 *   - 스크롤 위치를 기준으로 현재 뷰포트에 보이는 페이지 ± BUFFER만 DOM에 마운트.
 *   - 나머지 페이지는 높이만 차지하는 spacer div로 대체.
 *   - 700페이지 PDF라도 항상 BUFFER*2 + 화면 내 페이지 수(~1) ≈ 7~9개 컴포넌트만 존재.
 *
 * 개선 포인트 vs feedback-basic:
 *   1. DOM 노드 수: 700개 → 7~9개 (Long Task, Layout 비용 제거)
 *   2. Canvas 메모리: ~11 GB → ~130 MB 수준으로 감소
 *   3. 동시 렌더링: 무제한 → Scheduler K=4
 *   4. 스크롤 핸들러: 매 이벤트 setState → RAF 디바운스 + range 변경 시에만 setState
 *
 * 개선 포인트 vs feedback-raf (pdfRAFWindowing):
 *   1. O(N²) 재조정 없음: setVisiblePages([1..7],[1..14],...) 대신
 *      [start, end] 두 숫자만 setState → O(1) 재조정
 *   2. IntersectionObserver 불필요: mount 자체가 뷰포트 진입 신호
 *   3. visiblePages 의존성으로 IO가 100번 재생성되는 문제 없음
 */
export default function PDFViewer({
  pdfSrc,
  addFeedbackPoint,
  feedbackPoints,
  hoveredCommentId,
  setHoveredCommentId,
  setClickedCommentId,
}: PDFViewerProps) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [pageHeight, setPageHeight] = useState(0); // 실제 렌더 높이(px)
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // [start, end]: 0-indexed, 현재 DOM에 마운트된 페이지 범위
  const [visibleRange, setVisibleRange] = useState({ start: 0, end: 0 });

  const containerRef = useRef<HTMLDivElement>(null);
  const schedulerRef = useRef(new Scheduler());
  const pageAPIs = useRef<Map<number, PageAPI>>(new Map()); // pageNumber → API
  const rafRef = useRef<number | null>(null);

  // ── PDF 로드 + 첫 페이지로 높이 추정 ────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    initWorker();

    (async () => {
      try {
        setLoading(true);
        setErr(null);

        if (!pdfSrc?.trim()) throw new Error("PDF URL이 비어있습니다.");

        const loaded = await getDocument({ url: pdfSrc }).promise;
        if (cancelled) return;

        // 첫 페이지의 viewport aspect ratio로 렌더 높이 계산.
        // 대부분의 PDF는 모든 페이지 크기가 동일하므로 이 값을 uniform height로 사용.
        const page1 = await loaded.getPage(1);
        const vp = page1.getViewport({ scale: SCALE });
        // canvas는 width: "100%" → CONTAINER_WIDTH로 스케일링되므로:
        // 렌더 높이 = CONTAINER_WIDTH * (vp.height / vp.width)
        const renderedH = Math.round(
          CONTAINER_WIDTH * (vp.height / vp.width)
        );

        if (cancelled) return;

        const containerH = containerRef.current?.clientHeight ?? 800;
        const stride = renderedH + PAGE_GAP;
        const initEnd = Math.min(
          loaded.numPages - 1,
          Math.ceil(containerH / stride) + BUFFER
        );

        // React 18 Automatic Batching: 아래 setState들은 단일 렌더로 배칭됨
        setPdf(loaded);
        setNumPages(loaded.numPages);
        setPageHeight(renderedH);
        setVisibleRange({ start: 0, end: initEnd });
      } catch (e: unknown) {
        if (!cancelled) {
          setErr(e instanceof Error ? e.message : "PDF 로딩 실패");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [pdfSrc]);

  // ── 스크롤 핸들러 ────────────────────────────────────────────────────────────
  /**
   * rAF로 디바운스 후, range가 실제로 달라질 때만 setState.
   *
   * 여기서 rAF를 쓰는 이유는 React state update batching이 아니라
   * 스크롤 이벤트 중복 처리 방지(한 프레임에 한 번만 계산)이다.
   * rAF와 React Automatic Batching은 해결하는 문제 레이어가 다르다.
   */
  const handleScroll = useCallback(() => {
    if (rafRef.current !== null) return; // 이미 예약됨 → 스킵
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const container = containerRef.current;
      if (!container || pageHeight === 0 || numPages === 0) return;

      const { scrollTop, clientHeight } = container;
      const stride = pageHeight + PAGE_GAP;
      const newStart = Math.max(0, Math.floor(scrollTop / stride) - BUFFER);
      const newEnd = Math.min(
        numPages - 1,
        Math.ceil((scrollTop + clientHeight) / stride) + BUFFER
      );

      // 범위가 실제로 변경됐을 때만 setState → 불필요한 React re-render 방지
      setVisibleRange((prev) =>
        prev.start === newStart && prev.end === newEnd
          ? prev
          : { start: newStart, end: newEnd }
      );
    });
  }, [pageHeight, numPages]);

  // ── visible range 변경 시 미렌더 페이지 스케줄링 ────────────────────────────
  /**
   * React 실행 순서 보장:
   *   자식(PDF) effect → 부모(PDFViewer) effect
   * 따라서 이 effect가 실행될 때 새로 마운트된 PDF 컴포넌트들은
   * 이미 onRegister를 통해 pageAPIs에 등록된 상태이다.
   */
  useEffect(() => {
    if (!pdf || pageHeight === 0) return;

    const container = containerRef.current;
    const scrollTop = container?.scrollTop ?? 0;
    const clientH = container?.clientHeight ?? 800;
    const scrollCenter = scrollTop + clientH / 2;
    const stride = pageHeight + PAGE_GAP;

    for (let idx = visibleRange.start; idx <= visibleRange.end; idx++) {
      const pageNum = idx + 1;
      const api = pageAPIs.current.get(pageNum);
      if (!api || api.rendered()) continue;

      // 우선순위: 뷰포트 중심으로부터의 거리 (가까울수록 먼저 렌더)
      const pageMid = idx * stride + stride / 2;
      const priority = Math.abs(pageMid - scrollCenter);

      schedulerRef.current.enqueue({
        id: `page-${pageNum}`,
        priority,
        run: () => api.renderPage(),
      });
    }
  }, [visibleRange, pdf, pageHeight]);

  // ── PDF 컴포넌트에서 호출하는 register / unregister (stable) ─────────────────
  const registerPage = useCallback((pageNum: number, api: PageAPI) => {
    pageAPIs.current.set(pageNum, api);
  }, []); // ref 기반이라 deps 없음 → 항상 동일한 함수 참조

  const unregisterPage = useCallback((pageNum: number) => {
    pageAPIs.current.delete(pageNum);
    // done·queue에서 제거해 재진입 시 재렌더되도록 함
    schedulerRef.current.invalidate(`page-${pageNum}`);
  }, []);

  // ── 렌더 ─────────────────────────────────────────────────────────────────────
  if (err) return <div className="p-4 text-red-500">{err}</div>;
  if (loading || !pdf || pageHeight === 0)
    return <div className="p-4">PDF 로딩 중...</div>;

  const stride = pageHeight + PAGE_GAP;
  const topSpacerH = visibleRange.start * stride;
  const bottomSpacerH = Math.max(0, (numPages - 1 - visibleRange.end) * stride);

  return (
    <div style={{ position: "relative" }}>
      {/* 현재 윈도우 상태 표시 */}
      <div
        style={{
          position: "fixed",
          bottom: 16,
          right: 16,
          background: "rgba(0,0,0,0.7)",
          color: "#fff",
          padding: "6px 12px",
          borderRadius: 6,
          fontSize: 12,
          zIndex: 50,
          lineHeight: 1.6,
        }}
      >
        <div>DOM 마운트: {visibleRange.end - visibleRange.start + 1} / {numPages}페이지</div>
        <div>
          범위: {visibleRange.start + 1} – {visibleRange.end + 1}
        </div>
      </div>

      <div
        ref={containerRef}
        onScroll={handleScroll}
        data-testid="pdf-scroll-container"
        style={{
          width: CONTAINER_WIDTH,
          margin: "auto",
          overflowY: "auto",
          maxHeight: "90vh",
        }}
      >
        {/* 앞 페이지 spacer: 실제 높이를 점유해 스크롤바 비율 정확히 유지 */}
        <div style={{ height: topSpacerH }} />

        {/* 뷰포트 ± BUFFER 범위만 실제 컴포넌트로 마운트 */}
        {Array.from(
          { length: visibleRange.end - visibleRange.start + 1 },
          (_, i) => visibleRange.start + i + 1
        ).map((pageNumber) => (
          <PDF
            key={pageNumber}
            pdf={pdf}
            pageNumber={pageNumber}
            pageHeight={pageHeight}
            feedbackPoints={feedbackPoints}
            hoveredCommentId={hoveredCommentId}
            addFeedbackPoint={addFeedbackPoint}
            setHoveredCommentId={setHoveredCommentId}
            setClickedCommentId={setClickedCommentId}
            onRegister={registerPage}
            onUnregister={unregisterPage}
          />
        ))}

        {/* 뒷 페이지 spacer */}
        <div style={{ height: bottomSpacerH }} />
      </div>
    </div>
  );
}
