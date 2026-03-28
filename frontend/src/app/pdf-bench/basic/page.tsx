"use client";

/**
 * 벤치마크 전용: Basic PDF 뷰어 (개선 전)
 * pdfOld — 모든 페이지 즉시 렌더링, 스케줄링 없음
 */
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

const PDFViewer = dynamic(
  () => import("@/components/resumeoverview_old/pdfOld/PDFViewer"),
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

export default function BenchBasicPage() {
  return (
    <Suspense fallback={<div>로딩 중...</div>}>
      <Content />
    </Suspense>
  );
}
