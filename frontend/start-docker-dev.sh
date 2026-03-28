#!/bin/bash

echo "======================================"
echo "Next.js 개발 서버 시작 (Docker)"
echo "======================================"
echo ""

# Docker 확인
if ! command -v docker &> /dev/null; then
    echo "❌ Docker가 설치되어 있지 않습니다."
    exit 1
fi

echo "✅ Docker 확인됨"
echo ""

# Docker Compose 확인
if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
    echo "❌ Docker Compose가 설치되어 있지 않습니다."
    exit 1
fi

echo "✅ Docker Compose 확인됨"
echo ""

echo "🐳 Docker 이미지 빌드 및 서버 시작 중..."
echo ""

# Docker Compose로 서버 시작
docker-compose -f docker-compose.dev.yml up --build

echo ""
echo "✅ Next.js 서버가 http://localhost:3000 에서 실행 중입니다"
echo ""

