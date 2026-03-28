#!/bin/bash

# PDF 첫페이지 성능 벤치마크 그룹1 실행 스크립트 (Playwright)
# 최적화 1,2,3 + 기준선

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR/.."

echo "======================================"
echo "PDF 첫페이지 성능 벤치마크 - 그룹1"
echo "======================================"
echo ""

# Node.js 확인
if ! command -v node &> /dev/null; then
    echo "❌ Node.js가 설치되어 있지 않습니다."
    exit 1
fi

echo "✅ Node.js 버전: $(node --version)"
echo ""

# localhost:3000 확인
echo "🔍 localhost:3000 서버 확인 중..."
if ! curl -s -o /dev/null -w "%{http_code}" http://localhost:3000 | grep -q "200\|301\|302"; then
    echo "❌ localhost:3000에 연결할 수 없습니다."
    echo "   Next.js 개발 서버를 먼저 시작해주세요:"
    echo "   npm run dev"
    exit 1
fi

echo "✅ localhost:3000 서버 실행 중"
echo ""

# Playwright 설치 확인
if [ ! -d "node_modules/playwright" ]; then
    echo "❌ Playwright가 설치되어 있지 않습니다."
    echo "   설치: npm install playwright"
    exit 1
fi

echo "✅ Playwright 설치 확인됨"
echo ""

# 벤치마크 실행
echo "🚀 그룹1 벤치마크 시작..."
echo ""

node bench/pdf-firstpage-group1-playwright.js

echo ""
echo "✅ 그룹1 벤치마크 완료!"
echo ""

