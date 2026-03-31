"use client";

/**
 * 벤치마크 전용: IO만 붙은 Simple 뷰어 (pdfSimple)
 */
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

const PDFViewer = dynamic(
  () => import("@/components/resumeoverview_old/pdfSimple/PDFViewer"),
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

export default function BenchSimpleIOPage() {
  return (
    <Suspense fallback={<div>로딩 중...</div>}>
      <Content />
    </Suspense>
  );
}
