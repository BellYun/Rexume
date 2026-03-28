#!/bin/bash

# Docker를 사용한 PDF 첫페이지 성능 벤치마크 그룹1 실행 스크립트

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR/.."

echo "======================================"
echo "PDF 첫페이지 성능 벤치마크 - 그룹1 (Docker)"
echo "======================================"
echo ""

# Docker 확인
if ! command -v docker &> /dev/null; then
    echo "❌ Docker가 설치되어 있지 않습니다."
    exit 1
fi

echo "✅ Docker 확인됨"
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

# Docker 이미지 빌드
echo "🐳 Docker 이미지 빌드 중..."
docker build -f Dockerfile.bench -t pdf-benchmark:latest .

echo ""
echo "🚀 그룹1 벤치마크 시작 (Docker)..."
echo ""

# Docker 컨테이너 실행
docker run --rm \
  --network host \
  -v "$(pwd)/bench/results:/app/bench/results" \
  --cap-add=SYS_ADMIN \
  --shm-size=2g \
  pdf-benchmark:latest \
  node bench/pdf-firstpage-group1.js

echo ""
echo "✅ 그룹1 벤치마크 완료!"
echo ""

