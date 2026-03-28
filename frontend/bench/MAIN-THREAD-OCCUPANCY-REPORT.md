# PDF 렌더링 메인스레드 점유율 비교 리포트

> **측정 환경:** CPU 4x Throttling · Puppeteer Headless · 3회 반복 · settle 5000ms
> **측정 지표:** Main Thread Occupancy (%) = sum(Long Task durations) / measurement_window * 100
> **측정일:** 2026-03-24

---

## 결과 요약

| 버전 | 적용 기술 | 점유율 (median) | vs Basic | TBT (median) | LongTask 수 |
|------|----------|:---:|:---:|:---:|:---:|
| **Basic** | - | **16.73%** | baseline | 1,068ms | 5개 |
| **Simple** | IO | **14.15%** | **↓15.4%** | 789ms | 4개 |
| **Optimized** | IO + RAF + Limit | **14.73%** | ↓12.0% | 816ms | 5개 |
| **Opt14** | IO + RAF + Limit + Cache | **14.77%** | ↓11.7% | 860ms | 5개 |
| **Opt15** | IO + RAF + Limit + Worker | **2.11%** | **↓87.4%** | 631ms | 2.3개 |
| **Opt15-NoLimit** | IO + RAF + Worker | **2.28%** | ↓86.4% | 657ms | 2.7개 |
| **WorkerOnly** | Worker only | **2.25%** | ↓86.6% | 666ms | 2.3개 |

---

## 버전별 적용 기술

### 1. Basic (pdfOld) — 점유율 16.73%

| 항목 | 내용 |
|------|------|
| 렌더링 | Canvas 2D, **메인스레드** |
| 스케줄링 | 없음 |
| 동시성 | 모든 페이지 즉시 렌더 |
| 캐싱 | 없음 |

- PDF 로드 완료 시 **모든 페이지를 동시에 렌더링**
- `page.render({canvasContext, viewport})` 직접 호출
- 메인스레드가 모든 렌더링 작업을 직접 수행 → **높은 점유율**

---

### 2. Simple (IntersectionObserver) — 점유율 14.15% (↓15.4%)

| 항목 | 내용 |
|------|------|
| 렌더링 | Canvas 2D, **메인스레드** |
| 스케줄링 | **IntersectionObserver** (75vh rootMargin) |
| 동시성 | 제한 없음 |
| 캐싱 | 없음 |

**추가된 기술:**
- **IntersectionObserver**: 뷰포트 + 75vh 사전 워밍 영역에 진입한 페이지만 렌더
- 화면 밖 페이지의 불필요한 렌더링 제거 → **2.58%p 감소**

---

### 3. Optimized (Baseline) — 점유율 14.73% (↓12.0%)

| 항목 | 내용 |
|------|------|
| 렌더링 | Canvas 2D, **메인스레드** |
| 스케줄링 | **IO + requestAnimationFrame 배칭** |
| 동시성 | **CONCURRENT_LIMIT = 3** |
| 캐싱 | 없음 |

**추가된 기술:**
- **RAF 배칭**: IO 트리거 → pendingSet → RAF flush → 정렬(상단 우선) → 순차 렌더
- **동시성 제한 (3개)**: 동시에 최대 3페이지만 렌더링하여 프레임 안정성 확보
- 메인스레드 작업을 프레임 단위로 분산

---

### 4. Opt14 (getPage Cache) — 점유율 14.77% (↓11.7%)

| 항목 | 내용 |
|------|------|
| 렌더링 | Canvas 2D, **메인스레드** |
| 스케줄링 | IO + RAF 배칭 |
| 동시성 | CONCURRENT_LIMIT = 3 |
| 캐싱 | **PDFPageProxy 캐싱** |

**추가된 기술:**
- **PDFPageProxy 캐싱**: `pageRef.current`에 페이지 객체 저장
- `getPage()` 중복 호출 제거 (PDF 파싱 비용 절감)
- 점유율 차이는 미미 (Optimized와 거의 동일) — 파싱 비용보다 렌더링 비용이 지배적

---

### 5. Opt15 (RAF + IO + Worker, Limit=3) — 점유율 2.11% (↓87.4%)

| 항목 | 내용 |
|------|------|
| 렌더링 | **OffscreenCanvas, Web Worker** |
| 스케줄링 | IO + RAF 배칭 |
| 동시성 | CONCURRENT_LIMIT = 3 |
| 전송 | **ImageBitmap transferable (zero-copy)** |

**추가된 기술:**
- **OffscreenCanvas**: Worker 스레드에서 캔버스 렌더링 (메인스레드 해방)
- **Web Worker**: PDF 로드 + 페이지 캐시 + 렌더링 모두 Worker에서 처리
- **ImageBitmap zero-copy 전송**: `transferToImageBitmap()` → `transferFromImageBitmap()` (GPU → GPU, 픽셀 복사 없음)
- **bitmaprenderer context**: 메인스레드에서 비트맵을 직접 GPU에 전달

```
메인스레드: IO 감지 → RAF 큐 → postMessage({render})
Worker:     OffscreenCanvas 렌더 → transferToImageBitmap()
메인스레드: transferFromImageBitmap() (GPU 직접 전달)
```

---

### 6. Opt15-NoLimit (Worker, 동시성 제한 없음) — 점유율 2.28% (↓86.4%)

| 항목 | 내용 |
|------|------|
| 렌더링 | OffscreenCanvas, Web Worker |
| 스케줄링 | IO + RAF 배칭 |
| 동시성 | **제한 없음** |
| 전송 | ImageBitmap transferable |

**Opt15와의 차이:**
- CONCURRENT_LIMIT 제거 → 모든 대기 페이지를 RAF마다 즉시 전송
- 점유율 차이 미미 (2.11% vs 2.28%) — Worker가 렌더링하므로 메인스레드 영향 적음
- 동시성 제한은 **Worker 부하 관리**에 의미가 있지 메인스레드 점유율에는 큰 영향 없음

---

### 7. WorkerOnly (OffscreenCanvas만) — 점유율 2.25% (↓86.6%)

| 항목 | 내용 |
|------|------|
| 렌더링 | OffscreenCanvas, Web Worker |
| 스케줄링 | **없음** (모든 페이지 즉시 렌더) |
| 동시성 | 제한 없음 |
| 전송 | ImageBitmap transferable |

**Opt15와의 차이:**
- IO/RAF 스케줄링 없이 PDF 로드 즉시 전 페이지 렌더 요청
- 점유율은 Opt15와 거의 동일 (2.25% vs 2.11%)
- **IO/RAF 스케줄링은 메인스레드 점유율에 거의 영향 없음** (Worker가 렌더하므로)

---

## 기술별 영향도 분석

### 메인스레드 점유율 기준

```
적용 기술                          점유율 변화        기여도
──────────────────────────────────────────────────────────
IntersectionObserver (Lazy)       16.73% → 14.15%     ↓2.58%p
RAF 배칭 + 동시성 제한             14.15% → 14.73%     ~ 동일
PDFPageProxy 캐싱                 14.73% → 14.77%     ~ 동일
OffscreenCanvas + Web Worker      14.77% → 2.11%      ↓12.66%p  ★★★
동시성 제한 제거 (Worker)          2.11% → 2.28%       ~ 동일
IO/RAF 제거 (Worker)              2.11% → 2.25%       ~ 동일
```

### 핵심 인사이트

1. **OffscreenCanvas + Web Worker가 압도적** — 점유율 87% 감소의 거의 전부를 차지
2. **IntersectionObserver는 소폭 개선** — 불필요한 렌더링 제거로 ~15% 감소
3. **RAF 배칭/동시성 제한은 점유율에 미미** — 메인스레드 렌더링에서는 작업 분산일 뿐, 총량은 동일
4. **Worker 환경에서 스케줄링은 무의미** — 렌더링이 메인스레드를 벗어나면 IO/RAF/Limit 모두 점유율에 영향 없음

---

## 상세 수치

| 버전 | 점유율 avg | 점유율 min~max | TBT avg | LongTask 총 시간 | 측정 윈도우 | maxDur |
|------|:---:|:---:|:---:|:---:|:---:|:---:|
| Basic | 16.78% | 16.73~16.89% | 1,086ms | 1,341ms | 7,990ms | 697ms |
| Simple | 13.92% | 12.53~15.09% | 795ms | 1,058ms | 7,572ms | 634ms |
| Optimized | 14.60% | 13.84~15.22% | 836ms | 1,131ms | 7,834ms | 682ms |
| Opt14 | 14.64% | 14.08~15.08% | 854ms | 1,158ms | 7,784ms | 694ms |
| Opt15 | 2.12% | 2.04~2.22% | 628ms | 786ms | 36,776ms | 681ms |
| Opt15-NL | 2.28% | 2.15~2.41% | 657ms | 854ms | 36,867ms | 707ms |
| WorkerOnly | 2.28% | 2.18~2.42% | 661ms | 827ms | 36,853ms | 716ms |

---

## 결론

**메인스레드 점유율을 낮추는 유일하게 유의미한 방법은 OffscreenCanvas + Web Worker로 렌더링을 오프로드하는 것.**

- 메인스레드 렌더링 내에서의 최적화(IO, RAF, 캐싱)는 **~15% 수준의 소폭 개선**
- Worker 도입 시 **16.73% → 2.11%로 87% 감소** (14.62%p 절대 감소)
- Worker 환경에서는 추가 스케줄링(IO/RAF/Limit)이 점유율에 영향을 주지 않음
- **TBT도 1,068ms → 631ms로 40% 감소** (Worker + 스케줄링 조합)
