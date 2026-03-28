# pdfOpt15: OffscreenCanvas + Web Worker 분석

## 개요

PDF 렌더링을 메인 스레드에서 Web Worker로 이동하여 TBT(Total Blocking Time)를 줄이는 최적화.
`pdfjs-dist`를 Worker 내부에서 완전히 실행하고, 결과를 `ImageBitmap`으로 전송한다.

---

## 왜 OffscreenCanvas + Worker인가

### 기존 구조 (Baseline: RAF + IO)의 병목

```
[메인 스레드]
  IntersectionObserver 감지
    → RAF 예약
      → page.render({ canvasContext, viewport })   ← 메인 스레드에서 canvas write
        → setRendered(true)                         ← React 상태 업데이트
          → DOM 페인트                              ← LongTask 발생
```

`page.render()`가 pdfjs worker에서 래스터라이징하더라도, canvas context(`CanvasRenderingContext2D`)에 픽셀을 쓰는 작업은 **메인 스레드**에서 발생한다. 페이지당 수백만 픽셀 write가 LongTask의 주원인이다.

### Worker + OffscreenCanvas 구조 (Opt15)

```
[메인 스레드]          [Render Worker]
  IO 감지
  → Worker에 'render' 메시지만 전송

                       pdfjs 초기화 (worker 내부)
                       OffscreenCanvas 생성
                       page.render({ canvasContext: offscreenCtx })  ← Worker 스레드
                       canvas.transferToImageBitmap()                 ← GPU 메모리 이전
                       postMessage({ bitmap }, [bitmap])              ← transferable

  ImageBitmap 수신
  → canvas.getContext('bitmaprenderer')
      .transferFromImageBitmap(bitmap)    ← GPU-to-GPU, 픽셀 복사 없음
  → setRendered(true)
```

**핵심 변화:**
- 픽셀 write 작업이 Worker 스레드로 이동 → 메인 스레드 블록 제거
- `transferFromImageBitmap()`: GPU 메모리 직접 이전, 픽셀 복사 없음 → 디스플레이 단계 비용 최소화
- pdfjs가 Worker 내부에서 완전히 동작 → 메인 스레드에서 pdfjs import 제거

---

## 기술 선택 이유

### `OffscreenCanvas.transferToImageBitmap()`

`createImageBitmap(canvas)`와 달리, `transferToImageBitmap()`은:
- 복사 없이 canvas의 GPU backing store를 `ImageBitmap`으로 이전
- 이전 후 원본 canvas는 비워짐(neutered) → 메모리 즉시 해제
- postMessage의 **transferable** 리스트에 포함 → 메인 스레드로 복사 없이 전달

### `canvas.getContext('bitmaprenderer')`

`ImageBitmapRenderingContext`는:
- `drawImage(bitmap, 0, 0)` (픽셀 복사) 대신 GPU backing store 교환
- 메인 스레드의 paint 작업이 사실상 0ms
- 브라우저 지원: Chrome 66+, Firefox 46+, Safari 15.4+

### IO + RAF 스케줄링 유지

Worker 도입 후에도 IO + RAF 구조를 그대로 유지:
- `IntersectionObserver`: viewport 진입 감지 (75vh 프리워밍)
- `requestAnimationFrame`: 브라우저 페인트 사이클에 맞춰 render 요청 배치
- `CONCURRENT_LIMIT=3`: Worker에 동시 전송하는 render 요청 수 제한

Worker는 렌더링 실행 엔진이 바뀐 것이고, 스케줄링 정책은 동일하게 유지된다.

---

## 벤치마크 결과

**환경:** macOS, CPU 4x throttle, 5회 반복, `/sample4.pdf` (147페이지)

| 지표 | Baseline (RAF+IO) | Opt15 (Worker) | 변화 |
|------|-------------------|----------------|------|
| **TBT median** | 931ms | **828ms** | **↓11.1% (103ms 단축)** |
| TBT avg | 947ms | 752ms | ↓20.6% |
| TBT min/max | 803~1104ms | 560~848ms | 변동폭 감소 |
| FCP median | 456ms | 448ms | ≈동일 |
| LongTask avg | **5개** | **3개** | **↓40%** |
| LongTask maxDur | 712ms | 878ms | ↑166ms |

### 결과 해석

**긍정적:**
- TBT 중간값 11% 감소, 평균 20% 감소 — 실질적 개선
- LongTask 개수 40% 감소 — 메인 스레드가 덜 자주 막힘
- TBT 변동폭 감소 (803~1104 → 560~848) — 더 안정적인 성능

**주목할 점:**
- LongTask 최대 지속 시간은 증가 (712ms → 878ms)
  → 남아 있는 LongTask(React 상태 업데이트, pdfjs 내부 worker 통신)가 더 집중적으로 발생
  → 개수는 줄었지만 각 태스크가 더 무거워진 경향

- 개선 폭이 기대보다 작은 이유:
  pdfjs는 이미 자체 worker(`pdf.worker.min.js`)에서 래스터라이징을 수행한다.
  메인 스레드 부하는 canvas write 외에도 React 렌더 사이클과 IO 콜백이 있어,
  canvas write만 Worker로 옮겨도 전체 TBT의 일부만 제거된다.

---

## IO + RAF 구조와의 관계

```
IO+RAF (스케줄링 레이어)   +   Worker+OffscreenCanvas (실행 레이어)
        ↕                               ↕
  "언제 렌더할지"           +     "어디서 렌더할지"
  (변동 없음)                     (메인 → Worker)
```

두 최적화는 **수직으로 분리**된 관심사를 다룬다:
- IO+RAF: viewport 기반 지연 렌더링, 동시 렌더 수 제한
- Worker: 렌더 연산 자체를 메인 스레드 밖으로 이동

두 가지를 함께 사용하면 상호 보완적이다.

---

## 한계 및 향후 방향

### 현재 한계

1. **pdfjs 이중 Worker 로드**
   메인 스레드에서 `pdf.worker.min.js`를 로드하던 것이 Render Worker 내부에서도 로드됨.
   총 Worker 2개 (`pdf-render.worker` + `pdf.worker.min.js`) 동작.

2. **메모리 증가**
   Worker 프로세스와 pdfjs 인스턴스가 별도로 존재 → 메모리 오버헤드.

3. **첫 페이지 렌더 지연**
   Worker 초기화 + pdfjs 로드 시간이 추가되어 첫 canvas 표시가 약간 늦어질 수 있음.

4. **최대 LongTask 길이 증가**
   Worker 스레드와의 MessageChannel 통신 오버헤드가 일부 LongTask에 더해짐.

### 향후 방향

| 최적화 | 예상 효과 | 난이도 |
|--------|-----------|--------|
| 첫 페이지 IO bypass (page 1 즉시 렌더) | FCP 감소 | 쉬움 |
| Worker 싱글톤 (공유 pdfjs 인스턴스) | 메모리 절감 | 중간 |
| `content-visibility: auto` | 스크롤 TBT 감소 | 쉬움 |
| DPR-aware scale (`Math.min(DPR, 2)`) | 저DPR 연산 50% 절감 | 쉬움 |
| `getSize` 배치 요청 최적화 | 초기 placeholder 표시 단축 | 쉬움 |

---

## 파일 구조

```
frontend/src/components/pdfOpt15-Worker/
  ├── pdf-render.worker.ts   Worker: pdfjs 로드 + OffscreenCanvas 렌더
  ├── PDFPage.tsx            bitmaprenderer context로 ImageBitmap 표시
  └── PDFViewer.tsx          Worker 관리 + IO+RAF 스케줄링

frontend/src/app/pdf-bench/opt15/page.tsx   벤치 전용 단독 페이지
frontend/bench/tbt-opt15-worker.js          TBT 측정 스크립트
frontend/bench/results/tbt-opt15-worker-*.json  측정 결과 JSON
```
