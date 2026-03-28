#!/bin/bash

# PDF 첫페이지 렌더링 성능 벤치마크 - 그룹1 실행
# 최적화 1,2,3 + 기준선

echo "🚀 PDF 첫페이지 벤치마크 시작 - 그룹1 (Opt 1,2,3 + 기준선)"
echo "측정 대상:"
echo "  - Basic (개선 전)"
echo "  - Opt1: RAF 페인트 안정화"
echo "  - Opt2: Callback Ref 패턴"
echo "  - Opt3: Combined (RAF + Callback)"
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
node bench/pdf-firstpage-group1.js

echo ""
echo "✅ 그룹1 벤치마크 완료!"
echo "📁 결과는 bench/results/ 디렉토리에 저장되었습니다."

