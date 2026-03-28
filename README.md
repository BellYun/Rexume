# ReXume Frontend

PDF 이력서 뷰어의 렌더링 성능을 최적화한 Next.js 프로젝트입니다.

## 프로젝트 소개

이력서 PDF를 웹에서 빠르게 열람하고 피드백을 남길 수 있는 서비스입니다.
`react-pdf` 없이 `pdfjs-dist`를 직접 사용하며, **OffscreenCanvas Worker + IntersectionObserver**로 대용량 PDF의 렌더링 성능을 개선했습니다.

## 시작하기

```bash
cd frontend
npm install
npm run dev
```

[http://localhost:3000](http://localhost:3000)에서 확인할 수 있습니다.

### 빌드

```bash
npm run build
npm start
```

## 최적화 전략

### 최종 버전: OffscreenCanvas Worker + IntersectionObserver

| 기법 | 설명 |
| --- | --- |
| **pdfjs-dist 직접 사용** | react-pdf 제거, 번들 사이즈 감소 |
| **OffscreenCanvas Worker** | Canvas 2D 드로잉을 메인 스레드에서 완전히 제거, ImageBitmap zero-copy 전송 |
| **IntersectionObserver (75vh)** | 뷰포트 + 75vh 프리워밍으로 렌더링 대상을 3~5개로 축소 |
| **로컬 Worker/cMap/Font** | 네트워크 의존 제거, `/api/pdfjs/` 경로로 서빙 |
| **bitmaprenderer** | GPU 메모리 직접 이전으로 픽셀 복사 없이 표시 |
| **Placeholder 사전 계산** | getViewport로 정확한 크기 확보, 레이아웃 시프트 방지 |

### 핵심 구조

```
[기존] pdf.js Worker (파싱) → operator list → 메인 스레드에서 Canvas 2D 드로잉 ← blocking
[개선] Render Worker에서 PDF 로드 + OffscreenCanvas 드로잉
        → ImageBitmap (zero-copy) → bitmaprenderer로 표시 (GPU-to-GPU)
```

### 실험한 접근법들

15+ 버전의 최적화를 실험했으며, 주요 접근법은 다음과 같습니다:

- **기본**: 최적화 없는 순차 렌더링
- **IntersectionObserver only**: IO 기반 지연 렌더링
- **rAF Batch**: IO + rAF 배칭 (React 18+ automatic batching과 중복되어 효과 미미)
- **Scheduler (K=5, K=8, K=16)**: 동시 렌더링 수 제한
- **OffscreenCanvas Worker**: Canvas 드로잉을 메인 스레드에서 제거 (핵심 개선)
- **Worker + IO 결합**: Worker 오프로드 + 뷰포트 기반 렌더링 제한 (최종 채택)
- **Page Cache**: 렌더링 결과 캐싱

## 성능 측정 결과

PDF 렌더링 시점은 Lighthouse에서 측정할 수 없어 Puppeteer + web-vitals 기반으로 직접 측정했습니다. (10회 반복, CPU 4x 쓰로틀링)

### Total Blocking Time (TBT)

| 버전 | TBT 평균 | vs Basic | Long Task 수 |
| --- | --- | --- | --- |
| **Basic (개선 전)** | 1,343ms | - | 6개 |
| **OffscreenCanvas Worker 단독** | 808ms | **↓39.8%** | 3개 |
| **IO + Worker 결합 (최종)** | 720ms | **↓46.4%** | 3개 |

### 각 레이어의 기여

```
Worker 기여:  -535ms (39.8%)  ████████████████████████████████████████
IO 추가 기여:  -88ms ( 6.6%)  ███████
합계:         -623ms (46.4%)
Long Task:    6개 → 3개       ████████████████████
```

### 핵심 결론

- **rAF Batching은 효과 없음**: React 18+의 automatic batching이 이미 동일한 역할을 수행하여, rAF의 TBT 개선은 측정 노이즈에 불과했음
- **병목의 본질**: setState 타이밍이 아니라 **Canvas 2D 드로잉의 메인 스레드 점유** 자체가 원인
- **OffscreenCanvas Worker**로 Canvas 드로잉을 메인 스레드에서 완전히 제거 → **TBT 39.8% 감소**
- **IntersectionObserver**로 렌더링 대상을 147개 → 3~5개로 축소 → **TBT 추가 6.6% 감소**
- 최종: **TBT 1,343ms → 720ms (↓46.4%), Long Task 6개 → 3개**

## 기술 스택

| 분류 | 기술 |
| --- | --- |
| **Framework** | Next.js 15.5, React 19 |
| **PDF 렌더링** | pdfjs-dist 3.11 (react-pdf 미사용) |
| **UI** | Tailwind CSS 4, Material-UI 7 |
| **상태 관리** | Zustand 5 |
| **데이터 페칭** | TanStack Query 5, Axios |
| **성능 측정** | Puppeteer, Playwright, Lighthouse |
| **차트** | Recharts |

## 프로젝트 구조

```
frontend/
├── src/
│   ├── app/
│   │   ├── page.tsx                # 메인 (버전 비교 허브)
│   │   ├── feedback/[id]/          # 이력서 피드백 페이지
│   │   ├── feedback-basic/[id]/    # 기본 버전
│   │   ├── pdf-bench/              # 벤치마크용 페이지 (9개 버전)
│   │   ├── performance-chart/      # 성능 차트 대시보드
│   │   └── api/pdfjs/              # PDF.js 리소스 (cMap, fonts)
│   ├── components/
│   │   ├── pdfOptimized-RAFBatch/  # 최종 버전 (RAF 배칭)
│   │   ├── pdfOptimized/           # RAF + IO 버전
│   │   ├── pdfOptimized-NoLimit/   # 동시성 제한 없는 버전
│   │   ├── feedback/               # 피드백 UI (댓글, 포인트)
│   │   ├── layout/                 # 레이아웃 (Navbar, ResumeLayout)
│   │   └── common/                 # 공통 (PerformanceMonitor 등)
│   ├── libs/                       # 렌더링 스케줄러 (고정/적응형)
│   ├── store/                      # Zustand 스토어
│   ├── api/                        # API 클라이언트
│   └── types/                      # TypeScript 타입 정의
├── bench/                          # 벤치마크 스크립트 & 결과
└── public/                         # 정적 파일 (PDF Worker 등)
```

## 주요 기능

- PDF 이력서 열람 및 피드백 시스템
- 뷰포트 기반 지연 렌더링 (IntersectionObserver + 75vh 프리워밍)
- OffscreenCanvas Worker로 메인 스레드 블로킹 제거
- 실시간 성능 모니터 (FPS, 메모리, CPU, Long Task)
- Puppeteer/Playwright 기반 자동화 벤치마크

## 성능 벤치마크 실행

```bash
npm run bench:firstpage    # PDF 첫 페이지 렌더링 시간
npm run bench:webvitals    # Web Vitals (LCP, FID, CLS 등)
npm run bench:longtask     # Long Task 분석
npm run bench:scenario     # 시나리오 기반 벤치마크
```

결과는 `bench/results/`에 JSON으로 저장됩니다.
