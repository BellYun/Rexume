"use client";

import dynamic from "next/dynamic";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";

const PDFViewer = dynamic(
  () => import("@/components/pdfOptimized/PDFViewer"),
  {
    ssr: false,
    loading: () => (
      <div className="p-6 text-gray-400 text-sm">PDF 뷰어 초기화 중...</div>
    ),
  }
);

function PageContent() {
  const searchParams = useSearchParams();
  const initial = searchParams.get("url") ?? "/sample4.pdf";
  const [inputUrl, setInputUrl] = useState(initial);
  const [activeUrl, setActiveUrl] = useState(initial);

  return (
    <div className="min-h-screen bg-[#F9FAFB]">
      {/* 헤더 */}
      <div className="bg-white border-b px-6 py-4 shadow-sm">
        <h1 className="text-xl font-bold text-gray-800 mb-1">
          PDF Viewer — 번들 최적화 (RAF + IntersectionObserver)
        </h1>
        <p className="text-xs text-gray-500">
          pdfjs-dist 직접 사용 · Worker/cMap/Font 전부 로컬 · CDN 의존 없음
        </p>
      </div>

      {/* URL 입력 */}
      <div className="max-w-4xl mx-auto px-6 py-4">
        <div className="flex gap-2">
          <input
            type="text"
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && setActiveUrl(inputUrl)}
            placeholder="PDF URL을 입력하세요..."
            className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
          />
          <button
            onClick={() => setActiveUrl(inputUrl)}
            className="bg-blue-500 hover:bg-blue-600 text-white text-sm px-5 py-2 rounded-lg transition-colors"
          >
            로드
          </button>
        </div>

        {/* 최적화 배지 */}
        <div className="flex flex-wrap gap-2 mt-3">
          {[
            { label: "로컬 Worker", color: "bg-green-100 text-green-700" },
            { label: "로컬 cMap", color: "bg-green-100 text-green-700" },
            { label: "로컬 폰트", color: "bg-green-100 text-green-700" },
            {
              label: "RAF 배칭",
              color: "bg-blue-100 text-blue-700",
            },
            {
              label: "IO 75vh 프리워밍",
              color: "bg-blue-100 text-blue-700",
            },
            {
              label: "동시 렌더 3개 제한",
              color: "bg-purple-100 text-purple-700",
            },
            {
              label: "react-pdf 미사용",
              color: "bg-orange-100 text-orange-700",
            },
          ].map((badge) => (
            <span
              key={badge.label}
              className={`text-xs font-medium px-2 py-1 rounded-full ${badge.color}`}
            >
              {badge.label}
            </span>
          ))}
        </div>
      </div>

      {/* PDF 뷰어 */}
      <div className="max-w-4xl mx-auto px-6 pb-12">
        <Suspense
          fallback={
            <div className="p-6 text-gray-400 text-sm">로딩 중...</div>
          }
        >
          <PDFViewer url={activeUrl} />
        </Suspense>
      </div>
    </div>
  );
}

export default function PDFOptimizationPage() {
  return (
    <Suspense
      fallback={<div className="p-6 text-gray-400 text-sm">로딩 중...</div>}
    >
      <PageContent />
    </Suspense>
  );
}
