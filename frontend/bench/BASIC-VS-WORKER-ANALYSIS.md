# Basic vs WorkerOnly vs RAF+IO+OffscreenWorker 성능 분석

## 개요

세 가지 구현을 비교한다:
1. **Basic** (`pdfOld`): 아무 최적화 없음, 전 페이지 즉시 메인 스레드 렌더
2. **WorkerOnly**: OffscreenCanvas Worker만 사용, IO/RAF 스케줄링 없음
3. **RAF+IO+Worker** (`pdfOpt15`): Worker + IntersectionObserver + RAF 배칭 모두 결합

---

## 벤치마크 결과

**환경:** macOS, CPU 4x throttle, 5회 반복, `/sample4.pdf` (147페이지)

| 지표 | Basic | WorkerOnly | RAF+IO+Worker |
|------|-------|-----------|---------------|
| **TBT median** | 1326ms | 662ms | **550ms** |
| **vs Basic** | (base) | **↓50.1%** | **↓58.5%** |
| TBT avg | 1286ms | 638ms | 566ms |
| TBT min/max | 1153~1342ms | 328~803ms | 491~709ms |
| **FCP median** | 372ms | 324ms | 384ms |
| **LongTask avg** | 6개 | 3개 | **2개** |
| LongTask maxDur | 798ms | 700ms | **586ms** |
| 안정성 (max-min) | 189ms | **475ms** | **218ms** |

---

## 각 구현 구조

### Basic (pdfOld)

```
[메인 스레드]
  페이지 로드 즉시
    → 147개 전부 page.render({ canvasContext }) 동시 실행  ← 메인 스레드
      → canvas write × 147 페이지                           ← LongTask 6개
        → TBT 1326ms
```

### WorkerOnly (IO/RAF 없음)

```
[메인 스레드]               [Render Worker]
  numPages 수신 즉시
    → 147개 render 메시지 전송

                            OffscreenCanvas × 147 렌더     ← Worker 스레드
                            transferToImageBitmap()
                            postMessage(bitmap, [bitmap])

  bitmap 수신
    → bitmaprenderer.transferFromImageBitmap()             ← GPU-to-GPU
    → TBT 662ms
```

### RAF+IO+Worker (pdfOpt15)

```
[메인 스레드]               [Render Worker]
  IntersectionObserver
  (viewport 진입 시만)
    → RAF 배치 (프레임당 3개)
    → render 메시지 전송

                            OffscreenCanvas 렌더            ← Worker 스레드
                            postMessage(bitmap)

  bitmap 수신
    → bitmaprenderer.transferFromImageBitmap()
    → TBT 550ms
```

---

## 최적화 레이어별 기여 분석

### Worker 단독 효과: Basic → WorkerOnly (↓50.1%)

TBT 1326ms → 662ms. **Worker 하나만으로 절반 감소.**

원인:
- 메인 스레드에서 `page.render()` + canvas write가 사라짐
- GPU 메모리 직접 이전 (`transferToImageBitmap` + `bitmaprenderer`) → paint 비용 최소화
- pdfjs 래스터라이징이 Worker 스레드에서 병렬 실행

단, IO/RAF가 없으므로:
- 147개 render 메시지가 한꺼번에 Worker로 전송됨
- Worker 내부에서 147개 getPage + OffscreenCanvas 생성 → 병렬 폭주
- **변동폭이 큼** (328~803ms): Worker 큐 포화 시 일부 지연

### IO+RAF 추가 효과: WorkerOnly → RAF+IO+Worker (↓17.0%, 662→550ms)

TBT 662ms → 550ms. **스케줄링으로 추가 17% 개선, 안정성 크게 향상.**

원인:
- IntersectionObserver: 초기 렌더 대상을 ~3~5페이지로 제한 (147개 → 3개)
- RAF 배칭: CONCURRENT_LIMIT=3으로 Worker 요청 수 제한 → Worker 큐 과부하 방지
- 결과: LongTask 3개 → 2개, maxDur 700ms → 586ms

스케줄링의 핵심 역할은 TBT 수치보다 **안정성**:
- WorkerOnly 변동폭: 475ms (328~803ms)
- RAF+IO+Worker 변동폭: 218ms (491~709ms) → 절반 이하

---

## 지표별 상세 분석

### TBT: Basic(1326) → WorkerOnly(662) → RAF+IO+Worker(550)

```
Worker 기여:  -664ms (50.1%)  ██████████████████████████████████████████████████
IO+RAF 기여:  -112ms ( 8.5%)  ████████
```

Worker 오프로드가 가장 큰 단일 기여 요소.
IO+RAF는 Worker 위에서 "안정화 레이어" 역할을 한다.

### LongTask 개수: 6 → 3 → 2

- Basic: 6개 (147 페이지 메인 스레드 렌더 → 여러 LongTask 발생)
- WorkerOnly: 3개 (canvas write 제거, 但 Worker 응답 수신 시 React 업데이트 발생)
- RAF+IO+Worker: 2개 (IO로 초기 렌더 수 제한 → 초기 업데이트 횟수 감소)

### FCP: Basic(372) vs WorkerOnly(324) vs RAF+IO+Worker(384)

WorkerOnly가 FCP가 가장 빠른 경향. Worker가 즉시 모든 페이지를 처리 시작하므로
첫 페이지 bitmap이 빨리 도착. RAF+IO+Worker는 IO 설정 오버헤드가 있어 FCP가 약간 늦음.

### 안정성 (변동폭)

- WorkerOnly의 큰 변동폭(475ms)은 Worker 큐 부하에 따른 편차
- RAF+IO+Worker는 CONCURRENT_LIMIT=3으로 Worker 부하를 제어 → 편차 절반

---

## 구현별 선택 기준

| 상황 | 권장 |
|------|------|
| 최대 TBT 감소, 안정성 필요 | RAF+IO+Worker (pdfOpt15) |
| 구현 단순성 + 충분한 개선 | WorkerOnly |
| 레거시 브라우저 지원 필요 | Basic (Worker 미지원 시) |

---

## 파일 구조

```
frontend/src/components/
  ├── pdfWorkerOnly/PDFViewer.tsx        WorkerOnly (IO/RAF 없음)
  └── pdfOpt15-Worker/
      ├── pdf-render.worker.ts           공유 Worker 구현
      ├── PDFPage.tsx                    bitmaprenderer 표시
      └── PDFViewer.tsx                  RAF+IO+Worker 스케줄링

frontend/src/app/pdf-bench/
  ├── basic/page.tsx                     Basic 벤치 (pdfOld)
  ├── opt-worker-only/page.tsx           WorkerOnly 벤치
  └── opt15/page.tsx                     RAF+IO+Worker 벤치

frontend/bench/
  ├── tbt-basic-vs-worker.js             3-way 비교 스크립트
  └── results/tbt-basic-vs-worker-*.json 측정 결과
```
