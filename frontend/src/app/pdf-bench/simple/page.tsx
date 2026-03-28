"use client";

/**
 * 벤치마크 전용: Simple 75vh + rAF 뷰어 (기존 최고 버전)
 * pdfSimple-75vh-RAFBatching-Paint — IO + 75vh 프리워밍 + RAF 배칭
 */
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

const PDFViewer = dynamic(
  () => import("@/components/resumeoverview_old/pdfSimple-75vh-RAFBatching-Paint/PDFViewer"),
  { ssr: false, loading: () => <div>로딩 중...</div> }
);

function Content() {
  const searchParams = useSearchParams();
  const url = searchParams.get("url") ?? "/sample4.pdf";

  return (
    <PDFViewer
      pdfSrc={url}
      pageNumber={1}
      addFeedbackPoint={() => {}}
      editFeedbackPoint={() => {}}
      feedbackPoints={[]}
      hoveredCommentId={null}
      setHoveredCommentId={() => {}}
      setClickedCommentId={() => {}}
    />
  );
}

export default function BenchSimplePage() {
  return (
    <Suspense fallback={<div>로딩 중...</div>}>
      <Content />
    </Suspense>
  );
}
