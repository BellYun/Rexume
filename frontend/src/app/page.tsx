"use client";

import Link from "next/link";

export default function Page() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 py-8">
      <div className="w-full max-w-2xl mx-auto p-6">
        <h1 className="text-3xl font-bold text-gray-900 mb-2 text-center">
          ReXume PDF Viewer
        </h1>
        <p className="text-center text-gray-600 mb-8 text-sm">
          이력서 & 포트폴리오를 위한 고성능 PDF 렌더링
        </p>

        <div className="space-y-6">
          {/* OffscreenCanvas Worker - 최종 버전 */}
          <div>
            <h2 className="text-sm font-semibold text-gray-700 mb-2 uppercase tracking-wide">
              최종 렌더링 엔진
            </h2>
            <Link
              href="/pdf-bench/opt15"
              className="block w-full px-4 py-3 rounded-lg bg-gradient-to-r from-blue-500 to-indigo-500 border-4 border-blue-600 shadow-lg hover:shadow-xl transition transform hover:scale-105 text-white font-bold relative overflow-hidden"
            >
              <div className="absolute top-2 right-2 bg-green-400 text-green-900 text-xs font-bold px-2 py-1 rounded-full">
                FINAL
              </div>
              <div className="font-semibold text-lg mb-1">
                OffscreenCanvas Worker
              </div>
              <div className="text-xs text-blue-100 mt-1 font-medium">
                Web Worker + OffscreenCanvas + ImageBitmap transferable
              </div>
              <div className="text-xs text-blue-200 mt-2 pt-2 border-t border-blue-400/30">
                메인 스레드 블로킹 제거 · zero-copy GPU 전송 · TBT 63% 감소
              </div>
            </Link>
          </div>

          {/* 비교 대상 */}
          <div>
            <h2 className="text-sm font-semibold text-gray-700 mb-2 uppercase tracking-wide">
              비교 버전
            </h2>
            <div className="space-y-2">
              <Link
                href="/pdf-bench/basic"
                className="block w-full px-4 py-3 rounded-lg bg-gray-50 border-2 border-gray-200 shadow hover:shadow-md transition text-gray-900"
              >
                <div className="font-semibold">Basic (메인스레드)</div>
                <div className="text-xs text-gray-600 mt-1">
                  최적화 없음 · 베이스라인 측정용
                </div>
              </Link>
              <Link
                href="/pdf-bench/simple-io"
                className="block w-full px-4 py-3 rounded-lg bg-gray-50 border-2 border-gray-200 shadow hover:shadow-md transition text-gray-900"
              >
                <div className="font-semibold">IO Only (메인스레드)</div>
                <div className="text-xs text-gray-600 mt-1">
                  IntersectionObserver 뷰포트 기반 렌더링
                </div>
              </Link>
              <Link
                href="/pdf-optimazation"
                className="block w-full px-4 py-3 rounded-lg bg-gray-50 border-2 border-gray-200 shadow hover:shadow-md transition text-gray-900"
              >
                <div className="font-semibold">RAF + IO (메인스레드)</div>
                <div className="text-xs text-gray-600 mt-1">
                  requestAnimationFrame 배칭 + IO 75vh 프리워밍 + 동시성 제한
                </div>
              </Link>
            </div>
          </div>

          {/* 벤치마크 결과 요약 */}
          <div className="p-4 bg-gradient-to-r from-blue-50 to-indigo-50 rounded-lg border border-blue-200">
            <h2 className="text-sm font-semibold text-gray-900 mb-3">
              벤치마크 결과 (대용량 포트폴리오 PDF, CPU 4x throttle)
            </h2>
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left">
                <thead>
                  <tr className="border-b border-blue-200 text-gray-700">
                    <th className="py-1.5 pr-2">버전</th>
                    <th className="py-1.5 px-2 text-right">TBT</th>
                    <th className="py-1.5 px-2 text-right">FCP</th>
                    <th className="py-1.5 px-2 text-right">LongTask</th>
                    <th className="py-1.5 pl-2 text-right">maxDur</th>
                  </tr>
                </thead>
                <tbody className="text-gray-600">
                  <tr className="border-b border-blue-100">
                    <td className="py-1.5 pr-2">Basic</td>
                    <td className="py-1.5 px-2 text-right">350ms</td>
                    <td className="py-1.5 px-2 text-right">308ms</td>
                    <td className="py-1.5 px-2 text-right">4</td>
                    <td className="py-1.5 pl-2 text-right">251ms</td>
                  </tr>
                  <tr className="border-b border-blue-100">
                    <td className="py-1.5 pr-2">IO Only</td>
                    <td className="py-1.5 px-2 text-right">344ms</td>
                    <td className="py-1.5 px-2 text-right">316ms</td>
                    <td className="py-1.5 px-2 text-right">4</td>
                    <td className="py-1.5 pl-2 text-right">267ms</td>
                  </tr>
                  <tr className="font-semibold text-blue-700">
                    <td className="py-1.5 pr-2">Worker</td>
                    <td className="py-1.5 px-2 text-right">129ms</td>
                    <td className="py-1.5 px-2 text-right">304ms</td>
                    <td className="py-1.5 px-2 text-right">3</td>
                    <td className="py-1.5 pl-2 text-right">204ms</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="text-xs text-gray-500 mt-2">
              TBT 63% 감소 (350ms → 129ms) · 15회 A/B 실험으로 최적화
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
