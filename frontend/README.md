# ReXume Frontend

이력서와 디자이너 포트폴리오를 위한 고성능 PDF 뷰어. Next.js 기반.

## 왜 만들었나

이력서(1-5페이지)는 어떤 방식으로 렌더링해도 빠르다. 문제는 **디자이너 포트폴리오**다. 고해상도 이미지가 가득한 30-100페이지 PDF(50MB+)를 브라우저에서 열면, PDF.js가 메인 스레드를 수백ms씩 점유하면서 스크롤, 버튼 클릭 등 모든 인터랙션이 먹통이 된다.

이 프로젝트는 **15회의 A/B 실험**을 통해 렌더링 파이프라인의 병목을 하나씩 격리하고, 최종적으로 OffscreenCanvas Worker 아키텍처에 도달했다.

## 핵심 최적화: OffscreenCanvas Worker

기존 방식은 PDF 파싱, 캔버스 렌더링, UI 업데이트가 모두 메인 스레드에서 실행된다. Worker 아키텍처는 이를 분리한다:

```
[메인 스레드]                    [Web Worker]
   │                                │
   ├─ UI 렌더링, 이벤트 처리        ├─ PDF.js 초기화 & 파싱
   ├─ IntersectionObserver          ├─ OffscreenCanvas 렌더링
   ├─ 스크롤, 클릭 응답             ├─ ImageBitmap 생성
   │                                │
   └──── transferable ◄────────────┘
         (zero-copy GPU 전송)
```

- PDF 파싱과 캔버스 렌더링이 Worker에서 실행되므로 메인 스레드가 블로킹되지 않음
- `ImageBitmap`을 `transferable`로 전송하여 메모리 복사 없이 GPU에 직접 전달
- `bitmaprenderer` 컨텍스트로 zero-copy 캔버스 출력

### Worker 환경 기술적 챌린지

Web Worker에서 pdfjs-dist를 실행하려면 브라우저 전용 API가 없는 환경을 극복해야 한다:

| 문제 | 원인 | 해결 |
|------|------|------|
| `window is not defined` | pdfjs가 `window.location`으로 URL을 해석 | `self.window = self` 폴리필로 Worker의 location 활용 |
| `document is not defined` | pdfjs가 내부적으로 DOM 요소 생성 시도 | 최소한의 fake document 폴리필 제공 |
| 폰트 렌더링 깨짐 | Worker에는 CSS `@font-face` 주입 불가 | `disableFontFace: true`로 캔버스 기반 폰트 렌더링 전환 |
| cMap/Font 경로 해석 실패 | Worker URL이 webpack chunk 경로라 상대경로 불일치 | `self.location.origin` 기반 절대 URL로 변환 |

## 벤치마크 결과

### 대용량 포트폴리오 PDF (CPU 4x throttle, 5회 median)

| 버전 | TBT | FCP | LongTask | maxDur |
|------|-----|-----|----------|--------|
| Basic (메인스레드) | **350ms** | 308ms | 4개 | **251ms** |
| IO only (메인스레드) | **344ms** | 316ms | 4개 | **267ms** |
| **OffscreenCanvas Worker** | **129ms** | 304ms | 3개 | **204ms** |

**TBT 63% 감소** (350ms -> 129ms). 메인 스레드 블로킹이 줄어 렌더링 중에도 UI 인터랙션이 끊기지 않는다.

### 경량 이력서 PDF (1페이지, 213KB / CPU 4x throttle)

| 버전 | TBT | FCP | LongTask | maxDur |
|------|-----|-----|----------|--------|
| Basic | 0ms | 128ms | 1개 | 55ms |
| IO only | 0ms | 120ms | 1개 | 53ms |
| **Worker** | **0ms** | **104ms** | **0개** | **0ms** |

경량 PDF에서도 Worker가 LongTask를 완전히 제거한다. 단, 이력서 수준에서는 체감 차이가 미미하며, 포트폴리오급 대용량 문서에서 최적화 효과가 극대화된다.

## 15회 실험 과정

각 실험은 단일 변수만 변경하여 효과를 격리 측정했다:

| 단계 | 최적화 기법 | 결과 |
|------|------------|------|
| v1-v3 | react-pdf 제거, pdfjs-dist 직접 사용 | 번들 크기 감소, 불필요한 추상화 제거 |
| v4-v6 | IntersectionObserver + 뷰포트 기반 렌더링 | 화면 밖 페이지 렌더링 제거 |
| v7-v9 | requestAnimationFrame 배칭 + 동시성 제한 (K=2,3,5,8,16) | 프레임 드롭 감소, K=3이 최적 |
| v10-v12 | RenderScheduler 우선순위 큐 | 뷰포트 근접 페이지 우선 렌더링 |
| v13 | 페이지 객체 캐싱 | getPage() 중복 호출 제거 |
| v14 | Worker 전환 (canvas 렌더링 오프로드) | TBT 개선 시작 |
| **v15** | **OffscreenCanvas + ImageBitmap transferable** | **TBT 63% 감소 달성** |

## 아키텍처

```
frontend/
├── src/
│   ├── app/
│   │   ├── feedback/[id]/       # 실서비스 피드백 페이지
│   │   ├── pdf-bench/           # 벤치마크용 각 버전 비교 페이지
│   │   │   ├── basic/           # 베이스라인 (메인스레드)
│   │   │   ├── simple-io/       # IO only
│   │   │   └── opt15/           # OffscreenCanvas Worker (최종)
│   │   └── api/                 # API 라우트
│   ├── components/
│   │   ├── pdfOpt15-Worker/     # Worker 기반 PDF 뷰어 (최종)
│   │   │   ├── PDFViewer.tsx    # 뷰어 컨테이너, Worker 관리
│   │   │   ├── PDFPage.tsx      # 페이지 컴포넌트, bitmaprenderer
│   │   │   └── pdf-render.worker.ts  # Web Worker (OffscreenCanvas)
│   │   ├── pdfOptimized/        # RAF + 스케줄러 버전
│   │   └── pdfOld/              # 기본 버전 (베이스라인)
│   └── libs/
│       └── renderScheduler.ts   # 우선순위 큐 + 동시성 제한
├── bench/                       # Puppeteer 자동 벤치마크
│   ├── pc-pages12-basic-vs-worker.js  # 메인 비교 벤치마크
│   ├── tbt-*.js                 # TBT 측정
│   ├── inp-*.js                 # INP(인터랙션 응답성) 측정
│   └── results/                 # 벤치마크 결과 JSON
└── public/
    └── sample4.pdf              # 테스트용 대용량 포트폴리오 PDF
```

## 기술 스택

- **Framework**: Next.js 15, React 19
- **PDF 렌더링**: pdfjs-dist (직접 사용, react-pdf 미사용)
- **멀티스레딩**: Web Worker + OffscreenCanvas + ImageBitmap transferable
- **성능 측정**: Puppeteer (CPU throttle, Long Task 감지, Performance Timeline API)
- **UI**: Tailwind CSS
- **상태 관리**: Zustand
- **데이터 페칭**: TanStack Query

## 실행

```bash
npm install
npm run dev
```

### 벤치마크

```bash
# 기본 (CPU 4x throttle, 5회)
node bench/pc-pages12-basic-vs-worker.js

# CPU 쓰로틀링 변경
CPU_THROTTLE=6 node bench/pc-pages12-basic-vs-worker.js

# TBT 비교
node bench/tbt-basic-vs-worker.js

# INP 측정
node bench/inp-raf-batch.js
```

결과는 `bench/results/`에 JSON으로 저장된다.
