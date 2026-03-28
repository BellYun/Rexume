import Link from "next/link";

export default function Page() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 py-8">
      <div className="w-full max-w-2xl mx-auto p-6">
        <h1 className="text-3xl font-bold text-gray-900 mb-2 text-center">PDF 렌더링 최적화 분석</h1>
        <p className="text-center text-gray-600 mb-8 text-sm">현재 테스트 중인 버전 링크</p>
        
        <div className="space-y-6">
          {/* 번들 최적화 버전 */}
          <div>
            <h2 className="text-sm font-semibold text-gray-700 mb-2 uppercase tracking-wide">✨ 번들 최적화 버전</h2>
            <Link
              href="/pdf-optimazation"
              className="block w-full px-4 py-3 rounded-lg bg-gradient-to-r from-blue-500 to-indigo-500 border-4 border-blue-600 shadow-lg hover:shadow-xl transition transform hover:scale-105 text-white font-bold relative overflow-hidden"
            >
              <div className="absolute top-2 right-2 bg-green-400 text-green-900 text-xs font-bold px-2 py-1 rounded-full">
                NEW
              </div>
              <div className="font-semibold text-lg mb-1">🚀 PDF Optimization (RAF + IO)</div>
              <div className="text-xs text-blue-100 mt-1 font-medium">
                번들 중복 제거 · 로컬 Worker/cMap/Font · RAF 배칭 · IO 75vh 프리워밍
              </div>
              <div className="text-xs text-blue-200 mt-2 pt-2 border-t border-blue-400/30">
                react-pdf 미사용 · pdfjs-dist 단일 버전 · CDN 의존 없음
              </div>
            </Link>
          </div>

          {/* 현재 테스트 세트 */}
          <div>
            <h2 className="text-sm font-semibold text-gray-700 mb-2 uppercase tracking-wide">🧪 현재 테스트 링크</h2>
            <div className="space-y-2">
              <Link
                href="/feedback/4?version=lazy"
                className="block w-full px-4 py-3 rounded-lg bg-yellow-50 border-2 border-yellow-200 shadow hover:shadow-md transition text-gray-900"
              >
                <div className="font-semibold">🐌 Lazy (지연된 getPage)</div>
                <div className="text-xs text-gray-600 mt-1">페이지 관찰 후 getPage 호출</div>
              </Link>
              <Link
                href="/feedback/4?version=opt9-raf-nopaint"
                className="block w-full px-4 py-3 rounded-lg bg-emerald-50 border-2 border-emerald-200 shadow hover:shadow-md transition text-gray-900"
              >
                <div className="font-semibold">⚡ Opt9: RAF 페인트 제거</div>
                <div className="text-xs text-gray-600 mt-1">RAF 배칭 + 스케줄러 (페인트 안정화 제거)</div>
              </Link>
              <Link
                href="/feedback/4?version=opt9-raf-nobatch"
                className="block w-full px-4 py-3 rounded-lg bg-emerald-100 border-2 border-emerald-300 shadow hover:shadow-md transition text-gray-900"
              >
                <div className="font-semibold">🧪 Opt9B: RAF 배칭 제거</div>
                <div className="text-xs text-gray-600 mt-1">Opt9에서 RAF 배칭만 제거</div>
              </Link>
              <Link
                href="/feedback/4?version=opt9-raf-nobatch-noscheduler"
                className="block w-full px-4 py-3 rounded-lg bg-emerald-200 border-2 border-emerald-300 shadow hover:shadow-md transition text-gray-900"
              >
                <div className="font-semibold">🧪 Opt9C: Scheduler 제거</div>
                <div className="text-xs text-gray-600 mt-1">Opt9B에서 스케줄러/우선순위까지 제거</div>
              </Link>
              <Link
                href="/feedback/4?version=opt10-lazy-pure-raf"
                className="block w-full px-4 py-3 rounded-lg bg-red-50 border-2 border-red-200 shadow hover:shadow-md transition text-gray-900"
              >
                <div className="font-semibold">🚀 Opt10: Lazy + Pure RAF</div>
                <div className="text-xs text-gray-600 mt-1">스케줄러 제거, 순수 IO + rAF</div>
              </Link>
              <Link
                href="/feedback/4?version=simple-notrack"
                className="block w-full px-4 py-3 rounded-lg bg-purple-50 border-2 border-purple-200 shadow hover:shadow-md transition text-gray-900"
              >
                <div className="font-semibold">🎯 Simple (No Track)</div>
                <div className="text-xs text-gray-600 mt-1">IntersectionObserver 기반 (추적 로직 제거)</div>
              </Link>
              <Link
                href="/feedback/4?version=simple-75vh-raf-paint"
                className="block w-full px-4 py-3 rounded-lg bg-gradient-to-r from-teal-500 to-emerald-500 border-4 border-teal-600 shadow-lg hover:shadow-xl transition transform hover:scale-105 text-white font-bold relative overflow-hidden"
              >
                <div className="absolute top-2 right-2 bg-yellow-400 text-yellow-900 text-xs font-bold px-2 py-1 rounded-full animate-pulse">
                  ⭐ 최적화
                </div>
                <div className="font-semibold text-lg mb-1">🚀 Simple 75vh + rAF (최적화)</div>
                <div className="text-xs text-teal-50 mt-1 font-medium">
                  동시 렌더 2개 제한 + rAF 슬라이싱 큐 | TBT 8.5% 개선
                </div>
                <div className="text-xs text-teal-100 mt-2 pt-2 border-t border-teal-400/30">
                  ✅ 75vh 프리워밍 + 동시성 제어 + rAF 배칭
                </div>
              </Link>
              <Link
                href="/feedback/4?version=lazy-pure-raf-lean"
                className="block w-full px-4 py-3 rounded-lg bg-yellow-100 border-2 border-yellow-300 shadow hover:shadow-md transition text-gray-900"
              >
                <div className="font-semibold">🐌🎬 Lazy + Pure rAF (Lean)</div>
                <div className="text-xs text-gray-600 mt-1">뷰포트 진입 시 Lazy getPage + 순수 rAF 트리거</div>
              </Link>
            </div>
          </div>
        </div>

        {/* 간단 안내 */}
        <div className="mt-8 p-4 bg-gradient-to-r from-blue-50 to-indigo-50 rounded-lg border border-blue-200">
          <h2 className="text-sm font-semibold text-gray-900 mb-3">💡 안내</h2>
          <p className="text-xs text-gray-700">
            위 목록은 현재 벤치마크/비교 중인 버전들만 노출됩니다.
          </p>
        </div>
      </div>
    </div>
  );
}