# PDF 최적화 버전 비교 가이드

이 문서는 PDF Simple 버전에서 PDF RAF 버전으로 발전하면서 적용된 최적화 기술들을 개별적으로 측정할 수 있도록 분리한 버전들을 설명합니다.

## 📊 최적화 버전 목록

### 1. **pdfSimple** (기준선 - Baseline)
- **경로**: `pdfSimple/`
- **설명**: 가장 기본적인 버전으로, 스케줄러 없이 IntersectionObserver만 사용
- **URL 파라미터**: `?version=simple`
- **특징**:
  - 뷰포트에 보이면 즉시 렌더링
  - 인라인 ref 함수 사용
  - RAF 없이 렌더링 완료 즉시 메트릭 수집

### 2. **pdfOpt1-RAF** (최적화 1: RAF 페인트 안정화)
- **경로**: `pdfOpt1-RAF/`
- **설명**: Simple 버전에 **requestAnimationFrame 페인트 안정화**만 추가
- **URL 파라미터**: `?version=opt1-raf`
- **적용된 최적화**:
  ```typescript
  // 🎯 최적화 포인트
  await task.promise;
  const t2 = performance.now();
  
  // requestAnimationFrame을 통한 페인트 안정화
  await new Promise<void>((r) =>
    requestAnimationFrame(() => requestAnimationFrame(() => r()))
  );
  const t3 = performance.now();
  ```
- **측정 가능한 메트릭**:
  - `paintMs`: 페인트 안정화 대기 시간
  - `totalMs`: 전체 렌더링 시간 (페인트 포함)

### 3. **pdfOpt2-CallbackRef** (최적화 2: Callback Ref 패턴)
- **경로**: `pdfOpt2-CallbackRef/`
- **설명**: Simple 버전에 **useCallback ref 메모이제이션**만 추가
- **URL 파라미터**: `?version=opt2-callback-ref`
- **적용된 최적화**:
  ```typescript
  // 🎯 최적화 포인트
  const setHostRef = useCallback(
    (el: HTMLDivElement | null) => {
      hostRef.current = el;
      if (!el) return;
      (el as any).renderPage = renderPage;
      (el as any).rendered = () => renderedRef.current;
      
      // forwardRef 연결
      if (typeof ref === "function") ref(el);
      else if (ref) ref.current = el;
    },
    [renderPage, ref, pageNumber]
  );
  ```
- **효과**:
  - ref 함수의 불필요한 재생성 방지
  - 컴포넌트 리렌더링 최적화

### 4. **pdfOpt3-Combined** (최적화 3: 전체 최적화)
- **경로**: `pdfOpt3-Combined/`
- **설명**: **RAF 페인트 안정화 + Callback Ref 패턴** 모두 적용
- **URL 파라미터**: `?version=opt3-combined`
- **적용된 최적화**:
  - ✅ requestAnimationFrame 페인트 안정화
  - ✅ useCallback ref 메모이제이션
- **비고**: pdfRAF와 거의 동일하지만 성능 측정을 위해 별도로 분리

### 5. **pdfOpt4-Scheduler** (최적화 4: RenderScheduler)
- **경로**: `pdfOpt4-Scheduler/`
- **설명**: Simple 버전에 **RenderScheduler(K=4)** 만 추가
- **URL 파라미터**: `?version=opt4-scheduler`
- **적용된 최적화**:
  ```typescript
  // 🎯 최적화 포인트
  class RenderScheduler {
    private K: number = 4; // 동시 렌더링 최대 4개
    private inFlight = 0;
    
    enqueue(job) {
      if (this.inFlight < this.K) {
        // 동시 렌더링 제한
        this.run(job);
      } else {
        // 큐에 대기
        this.q.push(job);
      }
    }
  }
  ```
- **효과**:
  - 과도한 동시 렌더링 방지
  - 메모리 사용량 제어

### 6. **pdfOpt5-RAFBatching** (최적화 5: RAF 배칭)
- **경로**: `pdfOpt5-RAFBatching/`
- **설명**: Simple 버전에 **requestAnimationFrame 배칭**만 추가
- **URL 파라미터**: `?version=opt5-raf-batching`
- **적용된 최적화**:
  ```typescript
  // 🎯 최적화 포인트
  const flushInRaf = useCallback(() => {
    if (scheduledRef.current) return;
    scheduledRef.current = true;
    
    requestAnimationFrame(() => {
      // IO 콜백들을 rAF로 배칭하여 한번에 처리
      const pages = Array.from(pendingRef.current);
      pendingRef.current.clear();
      
      pages.forEach(page => renderPage(page));
    });
  }, []);
  ```
- **효과**:
  - 여러 IO 콜백을 한 프레임에 묶어서 처리
  - 불필요한 레이아웃 재계산 감소

### 7. **pdfOpt6-Priority** (최적화 6: 우선순위 정렬)
- **경로**: `pdfOpt6-Priority/`
- **설명**: Simple + **RAF 배칭 + viewport 중심 거리 기반 우선순위 정렬**
- **URL 파라미터**: `?version=opt6-priority`
- **적용된 최적화**:
  ```typescript
  // 🎯 최적화 포인트
  requestAnimationFrame(() => {
    const viewportCenter = window.scrollY + window.innerHeight / 2;
    
    pages
      .map(n => {
        const pageCenter = getPageCenter(n);
        const priority = Math.abs(pageCenter - viewportCenter);
        return { n, priority };
      })
      .sort((a, b) => a.priority - b.priority) // 가까운 페이지 먼저
      .forEach(({ n }) => renderPage(n));
  });
  ```
- **효과**:
  - 사용자가 보고 있는 페이지 우선 렌더링
  - 체감 성능 향상

### 8. **pdfOpt7-AllScheduling** (최적화 7: 전체 스케줄링)
- **경로**: `pdfOpt7-AllScheduling/`
- **설명**: **Scheduler + RAF 배칭 + 우선순위 정렬** 모두 적용
- **URL 파라미터**: `?version=opt7-all-scheduling`
- **적용된 최적화**:
  - ✅ RenderScheduler (K=4)
  - ✅ requestAnimationFrame 배칭
  - ✅ viewport 중심 거리 기반 우선순위
- **비고**: pdfRAF의 스케줄링 로직과 동일 (PDF 컴포넌트는 Simple 사용)

### 9. **pdfRAF** (원본 RAF 버전)
- **경로**: `pdfRAF/`
- **설명**: 원본 RAF 최적화 버전 (스케줄링 + RAF 페인트 안정화)
- **URL 파라미터**: `?version=raf`

## 🔬 성능 측정 방법

### 1. 각 버전 접속 방법

```bash
# Simple 버전 (기준선)
http://localhost:3000/resume?version=simple

## PDF 컴포넌트 레벨 최적화 ##
# 최적화 1: RAF 페인트 안정화만
http://localhost:3000/resume?version=opt1-raf

# 최적화 2: Callback Ref 패턴만
http://localhost:3000/resume?version=opt2-callback-ref

# 최적화 3: RAF + Callback Ref
http://localhost:3000/resume?version=opt3-combined

## PDFViewer 레벨 스케줄링 최적화 ##
# 최적화 4: RenderScheduler (K=4)만
http://localhost:3000/resume?version=opt4-scheduler

# 최적화 5: RAF 배칭만
http://localhost:3000/resume?version=opt5-raf-batching

# 최적화 6: RAF 배칭 + 우선순위
http://localhost:3000/resume?version=opt6-priority

# 최적화 7: 전체 스케줄링
http://localhost:3000/resume?version=opt7-all-scheduling

# 원본 RAF 버전
http://localhost:3000/resume?version=raf
```

### 2. 메트릭 수집

각 버전은 콘솔에 다음과 같은 메트릭을 출력합니다:

```javascript
// pdfSimple
{
  page: 1,
  getPageMs: 45.2,
  renderMs: 123.4,
  totalMs: 168.6
}

// pdfOpt1-RAF, pdfOpt3-Combined
{
  page: 1,
  getPageMs: 45.2,
  renderMs: 123.4,
  paintMs: 16.7,  // ⭐ RAF 대기 시간
  totalMs: 185.3
}
```

### 3. 성능 비교 분석

```javascript
// 브라우저 콘솔에서 메트릭 수집
if (window.pdfRenderMetricsCollector) {
  const metrics = window.pdfRenderMetricsCollector.getAll();
  console.table(metrics);
}
```

## 📈 예상 결과

### Simple vs Opt1-RAF (RAF 페인트 안정화)
- **예상**: Opt1-RAF가 `paintMs` 만큼 총 시간이 증가하지만, 실제 사용자 체감 성능은 개선
- **이유**: 브라우저 페인트 타이밍과 동기화되어 레이아웃 시프트 감소

### Simple vs Opt2-CallbackRef (Callback Ref 패턴)
- **예상**: 초기 렌더링 시간은 비슷하지만, 재렌더링 시 성능 개선
- **이유**: ref 함수 재생성 방지로 불필요한 작업 감소

### Simple vs Opt3-Combined (전체 최적화)
- **예상**: 두 최적화의 복합 효과
- **이유**: RAF의 페인트 안정화 + Callback Ref의 리렌더링 최적화

## 🧪 벤치마크 실행

기존 벤치마크 스크립트를 각 버전에 맞게 실행할 수 있습니다:

```bash
# 기준선 (Simple)
npm run bench:pdf-firstpage -- --version=simple

# 최적화 1 (RAF 페인트 안정화)
npm run bench:pdf-firstpage -- --version=opt1-raf

# 최적화 2 (Callback Ref)
npm run bench:pdf-firstpage -- --version=opt2-callback-ref

# 최적화 3 (전체 최적화)
npm run bench:pdf-firstpage -- --version=opt3-combined
```

## 📝 구현 차이점 요약

### PDF 컴포넌트 레벨 최적화

| 항목 | Simple | Opt1 | Opt2 | Opt3 |
|------|--------|------|------|------|
| RAF 페인트 안정화 | ❌ | ✅ | ❌ | ✅ |
| Callback Ref | ❌ | ❌ | ✅ | ✅ |
| paintMs 메트릭 | ❌ | ✅ | ❌ | ✅ |

### PDFViewer 레벨 스케줄링 최적화

| 항목 | Simple | Opt4 | Opt5 | Opt6 | Opt7 | RAF |
|------|--------|------|------|------|------|-----|
| RenderScheduler | ❌ | ✅ | ❌ | ❌ | ✅ | ✅ |
| RAF 배칭 | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ |
| 우선순위 정렬 | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ |
| rootMargin | 0.25vh | 0.25vh | 0.25vh | 0.25vh | 0.75vh | 0.75vh |

### 전체 조합

| 항목 | Simple | RAF |
|------|--------|-----|
| PDF: RAF 페인트 안정화 | ❌ | ✅ |
| PDF: Callback Ref | ❌ | ✅ |
| Viewer: RenderScheduler | ❌ | ✅ |
| Viewer: RAF 배칭 | ❌ | ✅ |
| Viewer: 우선순위 정렬 | ❌ | ✅ |

## 🎯 분석 포인트

### PDF 컴포넌트 레벨 최적화

1. **RAF 페인트 안정화의 효과**:
   - Simple vs Opt1-RAF
   - paintMs 메트릭으로 정량적 분석

2. **Callback Ref 패턴의 효과**:
   - Simple vs Opt2-CallbackRef
   - 리렌더링 시 성능 차이

3. **복합 최적화**:
   - Opt1 + Opt2 vs Opt3
   - 시너지 효과 검증

### PDFViewer 레벨 스케줄링 최적화

4. **RenderScheduler의 효과**:
   - Simple vs Opt4-Scheduler
   - 동시 렌더링 제한(K=4)의 메모리/CPU 영향

5. **RAF 배칭의 효과**:
   - Simple vs Opt5-RAFBatching
   - IO 콜백 배칭으로 인한 레이아웃 재계산 감소

6. **우선순위 정렬의 효과**:
   - Opt5 vs Opt6-Priority
   - 사용자 체감 성능 개선

7. **전체 스케줄링 최적화**:
   - Simple vs Opt7-AllScheduling
   - Opt4 + Opt5 + Opt6 vs Opt7 비교

### 전체 조합 분석

8. **Simple vs RAF 전체 비교**:
   - 모든 최적화의 복합 효과
   - 각 최적화가 전체에 기여하는 정도 분석

## 💡 추가 정보

- 모든 버전은 원본 코드를 그대로 유지하며, 새로운 폴더에 분리되어 있습니다
- 각 버전은 독립적으로 동작하며 서로 영향을 주지 않습니다
- 콘솔 로그에 버전명이 표시되어 어떤 버전이 실행 중인지 쉽게 확인할 수 있습니다

