#!/bin/bash

set -e

echo "======================================"
echo "PDF 벤치마크 (Docker) - 전체 실행"
echo "======================================"
echo ""

# 사용법 확인
GROUP=${1:-"all"}

if [ "$GROUP" != "group1" ] && [ "$GROUP" != "group2" ] && [ "$GROUP" != "all" ] && [ "$GROUP" != "simple-only" ] && [ "$GROUP" != "three-versions" ]; then
    echo "사용법: $0 [group1|group2|all|simple-only|three-versions]"
    echo "  group1: 최적화 1,2,3 + 기준선"
    echo "  group2: 최적화 4,5,6,7 + 기준선"
    echo "  all:    전체 9개 버전 (Basic, Simple, Simple No Track, Simple 75vh + rAF, RAF, Lazy, Opt9, Opt9B, Opt9C)"
    echo "  simple-only: Simple (No Track) vs Simple 75vh + rAF 비교"
    echo "  three-versions: Basic, Simple (No Track), Simple 75vh + rAF 세 가지 버전만 테스트"
    exit 1
fi

# Docker 확인
if ! command -v docker &> /dev/null; then
    echo "❌ Docker가 설치되어 있지 않습니다."
    exit 1
fi

echo "✅ Docker 확인됨"
echo "📦 테스트 범위: $GROUP"
echo ""

# CPU 스로틀링 설정 (기본 4)
CPU_THROTTLE=${CPU_THROTTLE:-4}
echo "⚙️  CPU 스로틀링 배율: ${CPU_THROTTLE}x"

# 반복 횟수 설정 (기본 10)
RUNS_PER_URL=${RUNS_PER_URL:-10}
echo "🔄 URL당 반복 횟수: ${RUNS_PER_URL}회"
echo ""

# docker-compose.benchmark.yml 파일에서 command 변경
EXTRA_ENV=()
if [ "$GROUP" == "group1" ]; then
    SCRIPT="bench/pdf-firstpage-group1.js"
elif [ "$GROUP" == "group2" ]; then
    SCRIPT="bench/pdf-firstpage-group2.js"
elif [ "$GROUP" == "simple-only" ]; then
    SCRIPT="bench/pdf-firstpage-performance.js"
    EXTRA_ENV+=(-e TEST_SCOPE=simple-only)
elif [ "$GROUP" == "three-versions" ]; then
    SCRIPT="bench/pdf-firstpage-performance.js"
    EXTRA_ENV+=(-e TEST_SCOPE=three-versions)
else
    SCRIPT="bench/pdf-firstpage-performance.js"
fi

echo "🐳 Docker 빌드 및 벤치마크 시작..."
echo ""

# Docker Compose로 실행
docker-compose -f docker-compose.benchmark.yml run --rm \
    -e TEST_URL=http://nextjs:3000 \
    -e CPU_THROTTLE="$CPU_THROTTLE" \
    -e RUNS_PER_URL="$RUNS_PER_URL" \
    "${EXTRA_ENV[@]}" \
    benchmark node "$SCRIPT"

echo ""
echo "✅ 벤치마크 완료!"
echo "📊 결과 파일: bench/results/"
echo ""

