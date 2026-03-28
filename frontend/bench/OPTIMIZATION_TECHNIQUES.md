# PDF 렌더링 최적화 기술 정리

## 📋 현재 적용된 기술들

### 1. IntersectionObserver 기반 최적화
- **버전**: Simple, 모든 최적화 버전의 기본
- **설명**: 뷰포트에 보이는 PDF 페이지만 렌더링
- **효과**: 초기 렌더링 부하 감소
- **적용 위치**: 모든 최적화 버전

### 2. 우선순위 기반 렌더링
- **버전**: opt6-priority, step2-priority
- **설명**: 뷰포트 내 요소를 먼저 렌더링, 외부 요소는 후순위
- **구현**:
  ```typescript
  const priority = entry.isIntersecting ? 0 : 1;
  ```
- **효과**: 사용자가 보는 콘텐츠 우선 표시

### 3. 렌더링 스케줄링 (RenderScheduler)
- **버전**: opt4-scheduler, opt7-all-scheduling, step3-scheduler
- **설명**: 여러 렌더링 요청을 배치로 묶어 처리 (K=4)
- **구현**: 
  ```typescript
  class RenderScheduler {
    schedule(task, priority) {
      // K개씩 배치 처리
    }
  }
  ```
- **효과**: 렌더링 작업을 그룹화하여 효율성 향상

### 4. RAF (requestAnimationFrame) 기반 렌더링
- **버전**: raf, opt1-raf, opt5-raf-batching, step4-raf
- **설명**: 브라우저 렌더링 타이밍에 맞춰 작업 실행
- **구현**:
  ```typescript
  requestAnimationFrame(() => {
    // 렌더링 작업
  });
  ```
- **효과**: 브라우저 페인트 사이클과 동기화, 부드러운 렌더링

### 5. RAF 페인트 안정화
- **버전**: opt1-raf, opt8-raf-paint-batching, step5-complete
- **설명**: RAF 내에서 한 프레임에 하나의 페이지만 렌더링
- **구현**:
  ```typescript
  requestAnimationFrame(() => {
    renderOnePage(); // 한 번에 하나만
  });
  ```
- **효과**: 프레임 드롭 방지, 안정적인 렌더링

### 6. RAF 배칭
- **버전**: opt5-raf-batching, opt8-raf-paint-batching
- **설명**: RAF 내에서 여러 작업을 배치로 처리
- **효과**: 렌더링 효율성 향상

### 7. Callback Ref 패턴
- **버전**: opt2-callback-ref, opt3-combined
- **설명**: useEffect 대신 callback ref로 DOM 참조
- **구현**:
  ```typescript
  const observerCallback = useCallback((node) => {
    if (node) observer.observe(node);
  }, []);
  ```
- **효과**: 리렌더링 최소화, 참조 안정성

### 8. RAF Windowing (점진적 마운트)
- **버전**: raf-windowing
- **설명**: 컴포넌트를 점진적으로 마운트
- **효과**: 초기 마운트 부하 분산

### 9. Lazy getPage (지연된 PDF 로드)
- **버전**: lazy
- **설명**: PDF 페이지 객체를 필요할 때만 로드
- **효과**: 초기 로딩 시간 단축

## 🔬 점진적 개선 테스트 시나리오

### Step 1: Simple (기준선)
- IntersectionObserver만 사용
- 기본적인 뷰포트 기반 렌더링

### Step 2: Simple + 우선순위
- IntersectionObserver + 우선순위 정렬
- 뷰포트 내/외 구분하여 처리

### Step 3: Simple + 우선순위 + 스케줄링
- Step 2 + RenderScheduler (K=4)
- 배치 단위 렌더링

### Step 4: Simple + 우선순위 + 스케줄링 + RAF
- Step 3 + RAF 배칭
- 브라우저 렌더링 사이클 최적화

### Step 5: Simple + 모든 최적화
- Step 4 + RAF 페인트 안정화
- 완전한 최적화 적용

## 🚫 현재 미적용 기술들

### 1. Web Worker 기반 PDF 렌더링
- **설명**: PDF 파싱/렌더링을 별도 스레드에서 처리
- **예상 효과**: 메인 스레드 부하 감소, UI 반응성 향상
- **구현 복잡도**: 높음
- **적용 필요성**: 높음 (CPU 집약적 작업)

### 2. OffscreenCanvas
- **설명**: 메인 스레드 외부에서 Canvas 렌더링
- **예상 효과**: 렌더링 성능 향상, 논블로킹 렌더링
- **구현 복잡도**: 중간
- **브라우저 지원**: 최신 브라우저만 지원

### 3. 가상 스크롤링 (Virtual Scrolling)
- **설명**: DOM에 보이는 요소만 유지
- **예상 효과**: DOM 크기 감소, 메모리 절약
- **구현 복잡도**: 중간
- **라이브러리**: react-window, react-virtuoso

### 4. 캔버스 풀링 (Canvas Pooling)
- **설명**: 재사용 가능한 캔버스 객체 풀 관리
- **예상 효과**: 메모리 할당/해제 오버헤드 감소
- **구현 복잡도**: 중간

### 5. 점진적 이미지 로딩 (Progressive Image Loading)
- **설명**: 저해상도 → 고해상도 순차 렌더링
- **예상 효과**: 체감 로딩 속도 향상
- **구현 복잡도**: 중간

### 6. Content Visibility CSS
- **설명**: `content-visibility: auto` CSS 속성 활용
- **예상 효과**: 브라우저 레이아웃/페인트 최적화
- **구현 복잡도**: 낮음
- **브라우저 지원**: 최신 브라우저

### 7. React Concurrent Features
- **설명**: React 18 Concurrent Mode, Suspense 활용
- **예상 효과**: 우선순위 기반 렌더링, 인터럽트 가능한 렌더링
- **구현 복잡도**: 중간

### 8. PDF.js Caching Strategy
- **설명**: 렌더링된 페이지를 캐시하여 재사용
- **예상 효과**: 재방문 시 성능 향상
- **구현 복잡도**: 중간

### 9. Adaptive Rendering Quality
- **설명**: 디바이스 성능에 따라 렌더링 품질 조절
- **예상 효과**: 저사양 기기 성능 향상
- **구현 복잡도**: 중간

### 10. Intersection Observer v2
- **설명**: 더 정교한 가시성 추적
- **예상 효과**: 불필요한 렌더링 최소화
- **구현 복잡도**: 낮음

### 11. Paint Timing API 활용
- **설명**: 실제 페인트 타이밍 측정 및 최적화
- **예상 효과**: 더 정확한 렌더링 타이밍 제어
- **구현 복잡도**: 중간

### 12. Debounce/Throttle 스크롤 이벤트
- **설명**: 스크롤 이벤트 최적화
- **예상 효과**: 스크롤 성능 향상
- **구현 복잡도**: 낮음

## 📊 우선순위 제안

### High Priority (즉시 적용 권장)
1. **Web Worker 기반 렌더링** - 메인 스레드 블로킹 해소
2. **가상 스크롤링** - DOM 크기 최적화
3. **Content Visibility CSS** - 간단한 적용, 큰 효과

### Medium Priority (추후 적용 고려)
4. **OffscreenCanvas** - 브라우저 지원 확인 필요
5. **캔버스 풀링** - 메모리 최적화
6. **PDF.js Caching** - 사용자 경험 개선

### Low Priority (실험적 적용)
7. **React Concurrent Features** - React 버전 업그레이드 필요
8. **Adaptive Rendering** - 복잡도 대비 효과 검증 필요
9. **나머지 기술들** - 점진적 적용

## 🎯 다음 단계 제안

1. **점진적 개선 테스트 실행**
   ```bash
   node bench/pdf-firstpage-progressive.js
   ```

2. **결과 분석 및 최적 조합 선정**

3. **미적용 기술 중 High Priority 항목 프로토타이핑**

4. **성능 측정 및 비교 분석**

5. **프로덕션 적용**

