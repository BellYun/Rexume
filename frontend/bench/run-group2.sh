#!/bin/bash

# PDF 첫페이지 렌더링 성능 벤치마크 - 그룹2 실행
# 최적화 4,5,6,7 + 기준선

echo "🚀 PDF 첫페이지 벤치마크 시작 - 그룹2 (Opt 4,5,6,7 + 기준선)"
echo "측정 대상:"
echo "  - Basic (개선 전)"
echo "  - Opt4: RenderScheduler (K=4)"
echo "  - Opt5: RAF 배칭"
echo "  - Opt6: 우선순위 정렬"
echo "  - Opt7: 전체 스케줄링"
echo ""
echo "설정: CPU 4x 스로틀링, 각 버전당 3회 측정"
echo ""

# Node.js 환경 확인
if ! command -v node &> /dev/null; then
    echo "❌ Node.js가 설치되지 않았습니다."
    exit 1
fi

# 현재 디렉토리에서 실행
cd "$(dirname "$0")/.."

# 개발 서버가 실행 중인지 확인
if ! curl -s http://localhost:3000 > /dev/null; then
    echo "⚠️  localhost:3000에 연결할 수 없습니다."
    echo "   Next.js 개발 서버가 실행 중인지 확인해주세요."
    echo "   npm run dev"
    exit 1
fi

echo "✅ 개발 서버 연결 확인됨"
echo ""

# 벤치마크 실행
node bench/pdf-firstpage-group2.js

echo ""
echo "✅ 그룹2 벤치마크 완료!"
echo "📁 결과는 bench/results/ 디렉토리에 저장되었습니다."

