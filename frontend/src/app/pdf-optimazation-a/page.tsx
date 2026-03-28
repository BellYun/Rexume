"use client";

import dynamic from "next/dynamic";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";

const PDFViewerOptimized = dynamic(
  () => import("@/components/pdfOptimized/PDFViewer"),
  { ssr: false, loading: () => <div className="p-4 text-gray-400 text-sm">로딩 중...</div> }
);

const PDFViewerOpt14 = dynamic(
  () => import("@/components/pdfOpt14-PageCache/PDFViewer"),
  { ssr: false, loading: () => <div className="p-4 text-gray-400 text-sm">로딩 중...</div> }
);

function PageContent() {
  const searchParams = useSearchParams();
  const initial = searchParams.get("url") ?? "/sample4.pdf";
  const [inputUrl, setInputUrl] = useState(initial);
  const [activeUrl, setActiveUrl] = useState(initial);

  return (
    <div className="min-h-screen bg-[#F9FAFB]">
      <div className="bg-white border-b px-6 py-4 shadow-sm">
        <h1 className="text-xl font-bold text-gray-800 mb-1">
          PDF 최적화 비교 — A: getPage() 캐싱
        </h1>
        <p className="text-xs text-gray-500">
          좌: 기존 (pdfOptimized, getPage 이중 호출) · 우: Opt14 (getPage 캐싱)
        </p>
      </div>

      <div className="max-w-[1800px] mx-auto px-6 py-4">
        <div className="flex gap-2 mb-4">
          <input
            type="text"
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && setActiveUrl(inputUrl)}
            placeholder="PDF URL..."
            className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
          />
          <button
            onClick={() => setActiveUrl(inputUrl)}
            className="bg-blue-500 hover:bg-blue-600 text-white text-sm px-5 py-2 rounded-lg transition-colors"
          >
            로드
          </button>
        </div>

        <div className="grid grid-cols-2 gap-6">
          {/* 기존 버전 */}
          <div>
            <div className="bg-white border rounded-lg p-3 mb-3 flex items-center gap-2">
              <span className="text-xs font-bold text-gray-600">BASELINE</span>
              <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">
                pdfOptimized (getPage 이중 호출)
              </span>
            </div>
            <Suspense fallback={<div className="p-4 text-gray-400 text-sm">로딩 중...</div>}>
              <PDFViewerOptimized url={activeUrl} />
            </Suspense>
          </div>

          {/* Opt14 버전 */}
          <div>
            <div className="bg-white border rounded-lg p-3 mb-3 flex items-center gap-2">
              <span className="text-xs font-bold text-blue-600">OPT-A</span>
              <span className="text-xs bg-blue-50 text-blue-600 px-2 py-0.5 rounded-full">
                pdfOpt14 (getPage 캐싱 — 호출 1회)
              </span>
            </div>
            <Suspense fallback={<div className="p-4 text-gray-400 text-sm">로딩 중...</div>}>
              <PDFViewerOpt14 url={activeUrl} />
            </Suspense>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function PDFOptimizationAPage() {
  return (
    <Suspense fallback={<div className="p-6 text-gray-400 text-sm">로딩 중...</div>}>
      <PageContent />
    </Suspense>
  );
}
