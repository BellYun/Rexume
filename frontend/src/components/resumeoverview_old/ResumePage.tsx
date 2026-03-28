"use client";

import React, { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import useResumeStore from "@/store/ResumeStore";
import { FeedbackPoint } from "@/types/FeedbackPointType.js";
import { useSearchParams } from "next/navigation";

// 일반 PDF 버전 (IntersectionObserver)
const PDFViewerStandard = dynamic(() => import("./pdf/PDFViewer"), {
  ssr: false,
  loading: () => <div>PDF 로딩 중... (일반 버전)</div>,
});

// PDF Queue 버전 (RenderScheduler)
const PDFViewerQueue = dynamic(() => import("./pdfQueue/PDFViewer"), {
  ssr: false,
  loading: () => <div>PDF 로딩 중... (Queue 버전)</div>,
});

// PDF Simple 버전 (단순 IntersectionObserver)
const PDFViewerSimple = dynamic(() => import("./pdfSimple/PDFViewer"), {
  ssr: false,
  loading: () => <div>PDF 로딩 중... (Simple 버전)</div>,
});
const PDFViewerSimpleNoTrack = dynamic(() => import("./pdfSimple-NoTrack/PDFViewer"), {
  ssr: false,
  loading: () => <div>PDF 로딩 중... (Simple No Track)</div>,
});

// PDF rAF 버전 (requestAnimationFrame)
const PDFViewerRAF = dynamic(() => import("./pdfRAF/PDFViewer"), {
  ssr: false,
  loading: () => <div>PDF 로딩 중... (rAF 버전)</div>,
});

// PDF rAF 윈도잉 버전 (requestAnimationFrame + 윈도잉)
const PDFViewerRAFWindowing = dynamic(() => import("./pdfRAFWindowing/PDFViewer"), {
  ssr: false,
  loading: () => <div>PDF 로딩 중... (rAF 윈도잉 버전)</div>,
});

// PDF Lazy 버전 (지연된 getPage 호출)
const PDFViewerLazy = dynamic(() => import("./pdfLazy/PDFViewer"), {
  ssr: false,
  loading: () => <div>PDF 로딩 중... (Lazy 버전)</div>,
});

// PDF Opt1-RAF 버전 (requestAnimationFrame 페인트 안정화만 적용)
const PDFViewerOpt1RAF = dynamic(() => import("./pdfOpt1-RAF/PDFViewer"), {
  ssr: false,
  loading: () => <div>PDF 로딩 중... (Opt1-RAF 버전)</div>,
});

// PDF Opt2-CallbackRef 버전 (useCallback ref 패턴만 적용)
const PDFViewerOpt2CallbackRef = dynamic(() => import("./pdfOpt2-CallbackRef/PDFViewer"), {
  ssr: false,
  loading: () => <div>PDF 로딩 중... (Opt2-CallbackRef 버전)</div>,
});

// PDF Opt3-Combined 버전 (RAF + CallbackRef 모두 적용)
const PDFViewerOpt3Combined = dynamic(() => import("./pdfOpt3-Combined/PDFViewer"), {
  ssr: false,
  loading: () => <div>PDF 로딩 중... (Opt3-Combined 버전)</div>,
});

// PDF Opt4-Scheduler 버전 (RenderScheduler만 적용)
const PDFViewerOpt4Scheduler = dynamic(() => import("./pdfOpt4-Scheduler/PDFViewer"), {
  ssr: false,
  loading: () => <div>PDF 로딩 중... (Opt4-Scheduler 버전)</div>,
});

// PDF Opt5-RAFBatching 버전 (RAF 배칭만 적용)
const PDFViewerOpt5RAFBatching = dynamic(() => import("./pdfOpt5-RAFBatching/PDFViewer"), {
  ssr: false,
  loading: () => <div>PDF 로딩 중... (Opt5-RAFBatching 버전)</div>,
});

// PDF Opt6-Priority 버전 (RAF 배칭 + 우선순위 정렬)
const PDFViewerOpt6Priority = dynamic(() => import("./pdfOpt6-Priority/PDFViewer"), {
  ssr: false,
  loading: () => <div>PDF 로딩 중... (Opt6-Priority 버전)</div>,
});

// PDF Opt7-AllScheduling 버전 (모든 스케줄링 최적화)
const PDFViewerOpt7AllScheduling = dynamic(() => import("./pdfOpt7-AllScheduling/PDFViewer"), {
  ssr: false,
  loading: () => <div>PDF 로딩 중... (Opt7-AllScheduling 버전)</div>,
});

// PDF Opt8-RAF-Paint-Batching 버전 (RAF 페인트 안정화 + RAF 배칭)
const PDFViewerOpt8RAFPaintBatching = dynamic(() => import("./pdfOpt8-RAF-Paint-Batching/PDFViewer"), {
  ssr: false,
  loading: () => <div>PDF 로딩 중... (Opt8-RAF-Paint-Batching 버전)</div>,
});

// PDF Opt9-RAF-NoPaint 버전 (RAF 배칭 + 스케줄러, 페인트 안정화 제거)
const PDFViewerOpt9RAFNoPaint = dynamic(() => import("./pdfOpt9-RAF-NoPaint/PDFViewer"), {
  ssr: false,
  loading: () => <div>PDF 로딩 중... (Opt9-RAF-NoPaint 버전)</div>,
});

// PDF Opt9-RAF-NoPaint-NoBatch 버전 (RAF 배칭 제거)
const PDFViewerOpt9RAFNoPaintNoBatch = dynamic(() => import("./pdfOpt9-RAF-NoPaint-NoBatch/PDFViewer"), {
  ssr: false,
  loading: () => <div>PDF 로딩 중... (Opt9-RAF-NoBatch 버전)</div>,
});

// PDF Opt9-RAF-NoPaint-NoBatch-NoScheduler 버전 (스케줄러/우선순위 제거)
const PDFViewerOpt9RAFNoPaintNoBatchNoScheduler = dynamic(
  () => import("./pdfOpt9-RAF-NoPaint-NoBatch-NoScheduler/PDFViewer"),
  {
    ssr: false,
    loading: () => <div>PDF 로딩 중... (Opt9-NoScheduler 버전)</div>,
  }
);

// ==== 추가 검증 버전들 ====

// PDF Opt10-LazyPureRAF 버전 (Lazy getPage + Pure RAF, 스케줄러 제거)
const PDFViewerOpt10LazyPureRAF = dynamic(() => import("./pdfOpt10-LazyPureRAF/PDFViewer"), {
  ssr: false,
  loading: () => <div>PDF 로딩 중... (Opt10-LazyPureRAF 버전)</div>,
});

// Lazy + Pure rAF (Lean) - 요청 버전
const PDFViewerLazyPureRAFLean = dynamic(() => import("./pdfLazy-PureRAF/PDFViewer"), {
  ssr: false,
  loading: () => <div>PDF 로딩 중... (Lazy+Pure rAF)</div>,
});

// PDF Opt11-SchedulerK2 버전 (스케줄링 K=2)
const PDFViewerOpt11SchedulerK2 = dynamic(() => import("./pdfOpt11-SchedulerK2/PDFViewer"), {
  ssr: false,
  loading: () => <div>PDF 로딩 중... (Opt11-SchedulerK2 버전)</div>,
});

// PDF Opt12-SchedulerK8 버전 (스케줄링 K=8)
const PDFViewerOpt12SchedulerK8 = dynamic(() => import("./pdfOpt12-SchedulerK8/PDFViewer"), {
  ssr: false,
  loading: () => <div>PDF 로딩 중... (Opt12-SchedulerK8 버전)</div>,
});

// PDF Opt13-SchedulerK16 버전 (스케줄링 K=16)
const PDFViewerOpt13SchedulerK16 = dynamic(() => import("./pdfOpt13-SchedulerK16/PDFViewer"), {
  ssr: false,
  loading: () => <div>PDF 로딩 중... (Opt13-SchedulerK16 버전)</div>,
});

// ==== 점진적 개선 버전들 ====

// Step 2: Simple + 우선순위 정렬
const PDFViewerSimplePriority = dynamic(() => import("./pdfSimple-Priority/PDFViewer"), {
  ssr: false,
  loading: () => <div>PDF 로딩 중... (Simple+Priority 버전)</div>,
});

// Simple 75vh + rAF 배칭 + RAF 페인트 안정화
const PDFViewerSimple75vhRAFBatchingPaint = dynamic(
  () => import("./pdfSimple-75vh-RAFBatching-Paint/PDFViewer"),
  {
    ssr: false,
    loading: () => <div>PDF 로딩 중... (Simple-75vh-RAF 버전)</div>,
  }
);

// Simple 75vh + rAF (동시성 제한 없음 버전)
const PDFViewerSimple75vhRAFBatchingPaintNoConcurrent = dynamic(
  () => import("./pdfSimple-75vh-RAFBatching-Paint-NoConcurrent/PDFViewer"),
  {
    ssr: false,
    loading: () => <div>PDF 로딩 중... (Simple-75vh-RAF No Concurrent)</div>,
  }
);

// Step 3: Simple + 우선순위 + 스케줄링
const PDFViewerSimplePriorityScheduler = dynamic(() => import("./pdfSimple-Priority-Scheduler/PDFViewer"), {
  ssr: false,
  loading: () => <div>PDF 로딩 중... (Simple+Priority+Scheduler 버전)</div>,
});

// Step 4: Simple + 우선순위 + 스케줄링 + RAF
const PDFViewerSimplePrioritySchedulerRAF = dynamic(() => import("./pdfSimple-Priority-Scheduler-RAF/PDFViewer"), {
  ssr: false,
  loading: () => <div>PDF 로딩 중... (Simple+Priority+Scheduler+RAF 버전)</div>,
});

// Step 5: Simple + 모든 최적화
const PDFViewerSimpleComplete = dynamic(() => import("./pdfSimple-Complete/PDFViewer"), {
  ssr: false,
  loading: () => <div>PDF 로딩 중... (Simple+Complete 버전)</div>,
});


type ResumePageProps = {
  pageNumber: number;
  feedbackPoints: FeedbackPoint[];
  // addFeedbackPoint: (point: Omit<AddFeedbackPoint, "id">) => void;
  // deleteFeedbackPoint: (id: number) => void;
  // editFeedbackPoint: (item: AddFeedbackPoint) => void;
  hoveredCommentId: number | null;
  setHoveredCommentId: (id: number | null) => void;
  setClickedCommentId: (id: number | null) => void;
};

function ResumePage({
  pageNumber,
  feedbackPoints,
  // addFeedbackPoint,
  // editFeedbackPoint,
  hoveredCommentId,
  // setHoveredCommentId,
  // setClickedCommentId,
}: ResumePageProps) {
  const searchParams = useSearchParams();
  const version = searchParams.get('version') || 'pdf'; // 기본값: 'pdf'
  const pageRef = useRef<HTMLDivElement>(null);
  const [, setAddingFeedback] = useState<{
    x: number;
    y: number;
    pageNumber: number;
  } | null>(null);
  // const [editingFeedback, setEditingFeedback] = useState<FeedbackPoint | null>(
  //   null
  // );

  const handleClick = (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
    if (!pageRef.current) return;

    const rect = pageRef.current.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100; // 백분율
    const y = ((e.clientY - rect.top) / rect.height) * 100; // 백분율

    setAddingFeedback({ x, y, pageNumber });
  };

  // const handleMarkerClick = (point: FeedbackPoint) => {
  //   setEditingFeedback(point);
  // };

  // const handleAddSubmit = (comment: string) => {
  //   if (addingFeedback) {
  //     // addFeedbackPoint({
  //     //   pageNumber: addingFeedback.pageNumber,
  //     //   xCoordinate: addingFeedback.x,
  //     //   yCoordinate: addingFeedback.y,
  //     //   content: comment,
  //     // });
  //     setAddingFeedback(null);
  //   }
  // };

  // const handleEditSubmit = () => {
  //   if (editingFeedback) {
  //     const updatedPoint: AddFeedbackPoint = { ...editingFeedback };
  //     // editFeedbackPoint(updatedPoint);
  //     setEditingFeedback(null);
  //   }
  // };

  // const handleCancel = () => {
  //   setAddingFeedback(null);
  //   setEditingFeedback(null);
  // };

  const { ResumeUrl } = useResumeStore();

  useEffect(() => {
    console.log({ ResumeUrl, version });
  }, [ResumeUrl, version]);

  // 버전에 따라 사용할 PDFViewer 선택
  const PDFViewer = 
    version === 'queue' ? PDFViewerQueue :
    version === 'simple' ? PDFViewerSimple :
    version === 'simple-notrack' ? PDFViewerSimpleNoTrack :
    version === 'raf' ? PDFViewerRAF :
    version === 'raf-windowing' ? PDFViewerRAFWindowing:
    version === 'lazy' ? PDFViewerLazy :
    version === 'opt1-raf' ? PDFViewerOpt1RAF :
    version === 'opt2-callback-ref' ? PDFViewerOpt2CallbackRef :
    version === 'opt3-combined' ? PDFViewerOpt3Combined :
    version === 'opt4-scheduler' ? PDFViewerOpt4Scheduler :
    version === 'opt5-raf-batching' ? PDFViewerOpt5RAFBatching :
    version === 'opt6-priority' ? PDFViewerOpt6Priority :
    version === 'opt7-all-scheduling' ? PDFViewerOpt7AllScheduling :
    version === 'opt8-raf-paint-batching' ? PDFViewerOpt8RAFPaintBatching :
    version === 'opt9-raf-nopaint' ? PDFViewerOpt9RAFNoPaint :
    version === 'opt9-raf-nobatch' ? PDFViewerOpt9RAFNoPaintNoBatch :
    version === 'opt9-raf-nobatch-noscheduler' ? PDFViewerOpt9RAFNoPaintNoBatchNoScheduler :
    // 추가 검증 버전들
    version === 'opt10-lazy-pure-raf' ? PDFViewerOpt10LazyPureRAF :
    version === 'opt11-scheduler-k2' ? PDFViewerOpt11SchedulerK2 :
    version === 'opt12-scheduler-k8' ? PDFViewerOpt12SchedulerK8 :
    version === 'opt13-scheduler-k16' ? PDFViewerOpt13SchedulerK16 :
    // 점진적 개선 버전들
    version === 'simple-priority' ? PDFViewerSimplePriority :
    // Simple 75vh + rAF (동시성 제어 제거 버전)
    version === 'simple-75vh-raf-paint-nc' ? PDFViewerSimple75vhRAFBatchingPaintNoConcurrent :
    // Simple 75vh + rAF (기본 및 동시성 제한 테스트 버전들)
    version === 'simple-75vh-raf-paint' || (version && version.startsWith('simple-75vh-raf-paint-'))
      ? PDFViewerSimple75vhRAFBatchingPaint :
    version === 'simple-priority-scheduler' ? PDFViewerSimplePriorityScheduler :
    version === 'simple-priority-scheduler-raf' ? PDFViewerSimplePrioritySchedulerRAF :
    version === 'simple-priority-scheduler-raf-paint' ? PDFViewerSimpleComplete :
    // Lean 테스트 버전
    version === 'lazy-pure-raf-lean' ? PDFViewerLazyPureRAFLean :
    PDFViewerStandard;

  // 버전별 표시 정보
  const versionInfo: Record<string, { label: string; color: string; description: string }> = {
    pdf: { 
      label: '📄 일반 PDF (IntersectionObserver)', 
      color: 'bg-blue-100',
      description: '뷰포트에 보이면 즉시 렌더링'
    },
    simple: { 
      label: '🎯 PDF Simple (단순 IntersectionObserver)', 
      color: 'bg-purple-100',
      description: '스케줄러 없이 단순한 지연 로딩'
    },
    'simple-notrack': {
      label: '🎯 PDF Simple (추적 제거)',
      color: 'bg-purple-200',
      description: '추적 로직을 제거한 Simple 비교 버전'
    },
    'simple-75vh-raf-paint': {
      label: '🧪 Simple 75vh + rAF',
      color: 'bg-teal-100',
      description: '75vh 프리워밍 + rAF 배칭 + RAF 페인트 안정화'
    },
    'simple-75vh-raf-paint-nc': {
      label: '🧪 Simple 75vh + rAF (No Concurrent Limit)',
      color: 'bg-teal-200',
      description: '75vh 프리워밍 + rAF 배칭, 동시성 제한 제거 버전'
    },
    queue: { 
      label: '⚡ PDF Queue (RenderScheduler)', 
      color: 'bg-green-100',
      description: '렌더링 큐 관리, 우선순위 기반'
    },
    fixed: { 
      label: '🔒 고정 K=5 스케줄러', 
      color: 'bg-gray-100',
      description: '동시 렌더링 5개 고정'
    },
    adaptive: { 
      label: '⚡ 적응형 스케줄러', 
      color: 'bg-emerald-100',
      description: 'Long Task 기반 자동 조절 (1~6)'
    },
    raf: { 
      label: '🎬 PDF rAF (requestAnimationFrame)', 
      color: 'bg-orange-100',
      description: 'requestAnimationFrame을 사용한 렌더링 최적화'
    },
    'raf-windowing': { 
      label: '🧩 PDF Incremental Mount rAF', 
      color: 'bg-indigo-100',
      description: '한 프레임당 3개씩 점진적으로 DOM 마운트하는 rAF 버전'
    },
    lazy: { 
      label: '🐌 PDF Lazy (지연된 getPage)', 
      color: 'bg-yellow-100',
      description: '페이지 크기 미리 계산 제거, 관찰 후에만 getPage() 호출'
    },
    'opt1-raf': { 
      label: '🎯 최적화1: RAF 페인트 안정화', 
      color: 'bg-pink-100',
      description: 'Simple + requestAnimationFrame 페인트 안정화만 적용'
    },
    'opt2-callback-ref': { 
      label: '🔄 최적화2: Callback Ref 패턴', 
      color: 'bg-teal-100',
      description: 'Simple + useCallback ref 메모이제이션만 적용'
    },
    'opt3-combined': { 
      label: '⚡ 최적화3: Combined (RAF + Callback Ref)', 
      color: 'bg-amber-100',
      description: 'Simple + RAF 페인트 안정화 + Callback Ref 모두 적용'
    },
    'opt4-scheduler': { 
      label: '🔢 최적화4: RenderScheduler (K=4)', 
      color: 'bg-cyan-100',
      description: 'Simple + 동시 렌더링 4개로 제한'
    },
    'opt5-raf-batching': { 
      label: '📦 최적화5: RAF 배칭', 
      color: 'bg-lime-100',
      description: 'Simple + IntersectionObserver 콜백을 rAF로 배칭'
    },
    'opt6-priority': { 
      label: '🎯 최적화6: 우선순위 정렬', 
      color: 'bg-rose-100',
      description: 'Simple + RAF 배칭 + viewport 중심 거리 기반 우선순위'
    },
    'opt7-all-scheduling': { 
      label: '🚀 최적화7: 전체 스케줄링', 
      color: 'bg-violet-100',
      description: 'Simple + Scheduler + RAF 배칭 + 우선순위 정렬 모두 적용'
    },
    'opt8-raf-paint-batching': { 
      label: '🎨 최적화8: RAF 페인트 + 배칭', 
      color: 'bg-fuchsia-100',
      description: 'Opt1 RAF 페인트 안정화 + Opt5 RAF 배칭 조합'
    },
    'opt9-raf-nopaint': { 
      label: '⚡ 최적화9: RAF 페인트 제거', 
      color: 'bg-emerald-100',
      description: 'RAF 배칭 + 스케줄러 유지, 이중 RAF 페인트 안정화 제거'
    },
    'opt9-raf-nobatch': {
      label: '🧪 최적화9B: RAF 배칭 제거',
      color: 'bg-emerald-200',
      description: 'Opt9에서 RAF 배칭만 제거한 비교 버전'
    },
    'opt9-raf-nobatch-noscheduler': {
      label: '🧪 최적화9C: 스케줄러 제거',
      color: 'bg-emerald-300',
      description: 'Opt9B에서 RenderScheduler와 우선순위 정렬까지 제거한 비교 버전'
    },
    // 추가 검증 버전들
    'opt10-lazy-pure-raf': { 
      label: '🚀 최적화10: Lazy + Pure RAF', 
      color: 'bg-red-100',
      description: 'Lazy getPage + Pure RAF (스케줄러 제거, 순수 RAF만)'
    },
    'opt11-scheduler-k2': { 
      label: '2️⃣ 최적화11: 스케줄러 K=2', 
      color: 'bg-orange-100',
      description: 'Scheduler 동시 렌더링 2개로 제한 (K=2)'
    },
    'opt12-scheduler-k8': { 
      label: '8️⃣ 최적화12: 스케줄러 K=8', 
      color: 'bg-green-100',
      description: 'Scheduler 동시 렌더링 8개로 증가 (K=8)'
    },
    'opt13-scheduler-k16': { 
      label: '🔢 최적화13: 스케줄러 K=16', 
      color: 'bg-blue-100',
      description: 'Scheduler 동시 렌더링 16개로 증가 (K=16)'
    },
    // 점진적 개선 버전들
    'simple-priority': { 
      label: '📍 Step 2: Simple + 우선순위', 
      color: 'bg-sky-100',
      description: 'Simple + 뷰포트 내/외 우선순위 적용'
    },
    'simple-priority-scheduler': { 
      label: '📊 Step 3: Simple + 우선순위 + 스케줄링', 
      color: 'bg-blue-100',
      description: 'Step 2 + RenderScheduler (K=4) 적용'
    },
    'simple-priority-scheduler-raf': { 
      label: '⚡ Step 4: Simple + 우선순위 + 스케줄링 + RAF', 
      color: 'bg-indigo-100',
      description: 'Step 3 + RAF 배칭 적용'
    },
    'simple-priority-scheduler-raf-paint': { 
      label: '🚀 Step 5: Simple + 모든 최적화', 
      color: 'bg-purple-100',
      description: 'Step 4 + RAF 페인트 안정화 (완전체)'
    },
    'lazy-pure-raf-lean': {
      label: '🐌🎬 Lazy + Pure rAF (Lean)',
      color: 'bg-yellow-200',
      description: '뷰포트 진입 시 Lazy getPage + 순수 rAF 트리거 (스케줄러/우선순위 없음)'
    },
  };

  const currentVersion = versionInfo[version] || versionInfo.pdf;
  const PDFViewerAny = PDFViewer as unknown as React.ComponentType<any>;

  return (
    <div className="relative mb-8">
      {/* 현재 사용 중인 버전 표시 */}
      <div className={`mb-2 px-4 py-2 ${currentVersion.color} rounded-md text-sm text-gray-700 font-medium`}>
        <div>현재 버전: {currentVersion.label}</div>
        <div className="text-xs text-gray-600 mt-1">{currentVersion.description}</div>
      </div>
      <div
        ref={pageRef}
        className="w-full h-[903px] items-center relative cursor-pointer -mt-1"
        onClick={handleClick}
      >
        <PDFViewerAny
          pdfSrc={ResumeUrl}
          pageNumber={pageNumber}
          addFeedbackPoint={() => {}} // 임시 함수
          editFeedbackPoint={() => {}} // 임시 함수
          feedbackPoints={feedbackPoints}
          hoveredCommentId={hoveredCommentId}
          setHoveredCommentId={() => {}} // 임시 함수
          setClickedCommentId={() => {}} // 임시 함수
        />
      </div>
    </div>
  );
}

export default ResumePage;
