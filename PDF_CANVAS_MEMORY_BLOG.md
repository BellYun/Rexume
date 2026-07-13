# 프로젝트 성능 최적화 경험 : PDF canvas windowing 적용기

Next.js로 만든 이력서 피드백 시스템에서, 대용량 PDF를 렌더링할 때 브라우저 탭 메모리가 크게 증가하는 문제가 발생했습니다. 특히 포트폴리오 형태의 PDF는 페이지 수가 많고, 페이지 자체의 렌더링 픽셀 크기가 커질 수 있어 브라우저 부담이 커지는 상황이었습니다.

결론부터 말하면, 주된 메모리 절감은 PDF.js의 `page.cleanup()`에서 발생하지 않았습니다. 실제 효과는 **전체 페이지 canvas를 한 번에 유지하던 구조를 viewport 기반 windowing과 최근 페이지 LRU 캐시 구조로 바꾼 지점**에서 발생했습니다.

즉, 이 작업은 PDF.js 렌더링 엔진 자체를 빠르게 만든 최적화라기보다, 동시에 유지하는 canvas backing store 개수를 제한하고 최근 본 페이지는 일부 유지하는 메모리 관리에 가깝습니다.

이에 따른 원인과 해결 과정을 정리해보았습니다.

## 1. 문제 상황

이력서 피드백 서비스에서는 사용자가 업로드한 PDF를 결과 화면에서 다시 확인할 수 있어야 했습니다. 일반적인 이력서 PDF는 페이지 수가 적고 용량도 크지 않지만, 디자이너 포트폴리오처럼 여러 페이지로 구성된 PDF는 결과 화면에서 더 큰 부담을 만들 수 있었습니다.

문제는 PDF 결과 화면에 진입했을 때, 실제로는 첫 화면에 1~2페이지만 보이는데도 전체 PDF 페이지가 canvas로 렌더링된다는 점이었습니다. 이로 인해 화면 밖 페이지의 canvas 픽셀 버퍼까지 함께 유지되면서, 초기 진입 시 브라우저 메모리 압박이 커졌습니다.

즉, 사용자가 보고 있지 않은 페이지까지 브라우저가 canvas 리소스를 유지하고 있는 구조였습니다.

이 문제에서 중요한 부분은 PDF 파일 용량 자체보다, 렌더링된 각 페이지가 canvas backing store를 가진다는 점이었습니다. 페이지가 많아질수록 보이지 않는 canvas의 픽셀 버퍼가 함께 누적되는 구조였기 때문에, 단순히 PDF.js lifecycle을 정리하는 것만으로는 충분하지 않았습니다.

## 2. 문제 분석

기존 구현은 PDF 문서를 로드한 뒤 전체 페이지 수만큼 컴포넌트를 생성하는 방식이었습니다.

```tsx
{Array.from({ length: numPages }, (_, index) => (
  <PDFPage key={index + 1} pdf={pdf} pageNumber={index + 1} />
))}
```

각 페이지 컴포넌트는 mount되면 바로 `pdf.getPage()`와 `page.render()`를 실행했습니다.

```tsx
const page = await pdf.getPage(pageNumber);
const viewport = page.getViewport({ scale: 1 });

canvas.width = Math.ceil(viewport.width);
canvas.height = Math.ceil(viewport.height);

await page.render({
  canvasContext: context,
  viewport,
}).promise;
```

여기서 중요한 점은 canvas가 단순한 DOM 요소만은 아니라는 점입니다. canvas는 내부적으로 픽셀 버퍼를 가지고 있고, 이 픽셀 버퍼가 실제 메모리 사용량에 영향을 줍니다.

이번 글에서는 canvas 픽셀 버퍼의 상대적인 변화를 비교하기 위해 `width × height × 4`를 추정 지표로 사용했습니다.

```ts
const estimatedCanvasBytes = canvas.width * canvas.height * 4;
```

RGBA 기준으로 픽셀당 4바이트를 사용한다고 보고 계산한 값입니다. 다만 이 값이 Chrome 프로세스의 실제 전체 메모리 사용량과 동일하다고 볼 수는 없습니다. 브라우저 구현에 따라 GPU 텍스처, 정렬 단위, 임시 렌더링 버퍼, 메모리 풀링 등이 추가될 수 있기 때문입니다.

따라서 이 글에서 말하는 canvas memory는 실제 탭 전체 메모리가 아니라, **렌더링된 canvas 픽셀 버퍼 규모를 비교하기 위한 추정 지표**입니다.

렌더링 과정을 정리하자면 다음과 같습니다.

1. PDF 로드 후 전체 페이지 컴포넌트가 한 번에 생성됩니다.
2. 각 페이지가 mount되면서 `pdf.getPage()`와 `page.render()`를 실행합니다.
3. 각 페이지 canvas의 `width`, `height`가 렌더링 scale 기준으로 설정됩니다.
4. 보이지 않는 페이지의 canvas도 픽셀 버퍼를 유지합니다.
5. 결과적으로 초기 진입 시 canvas 픽셀 버퍼 총량과 offscreen canvas 픽셀 버퍼가 크게 증가합니다.

즉, 핵심 원인은 **화면 밖 페이지까지 canvas 픽셀 버퍼를 유지하는 구조**였습니다.

## 3. 개선

이를 해결하기 위해 먼저 PDF.js 렌더링 lifecycle에서 기본적으로 정리해야 하는 부분을 분리해서 확인했습니다.

`RenderTask.cancel()`과 `PDFPageProxy.cleanup()`만 적용한 비교 페이지를 만들고, eager 렌더링 구조는 그대로 유지했습니다. 이 방식은 렌더링 중인 작업을 취소하거나 PDF.js page 내부 리소스 정리를 유도하는 데 필요하지만, 이미 그려진 canvas의 픽셀 버퍼를 줄이는 해결책은 아니었습니다.

그래서 최종적으로는 렌더링 대상을 viewport 주변 페이지로 제한하고, 최근 본 페이지 일부만 캐시한 뒤 LRU에서 밀린 페이지의 canvas 픽셀 버퍼를 명시적으로 회수하는 구조를 적용했습니다. 이 작업의 핵심은 PDF.js를 더 빠르게 만드는 것이 아니라, **동시에 유지하는 canvas backing store 개수를 제한하는 것**이었습니다.

역할을 분리하면 다음과 같습니다.

- `RenderTask.cancel()` / `page.cleanup()`: PDF.js 렌더링 lifecycle 정리
- `IntersectionObserver`: 초기 진입 시 전체 페이지 canvas가 한 번에 생성되는 문제 방지
- 최근 5페이지 LRU 캐시: 사용자가 방금 본 페이지로 돌아갈 때 재렌더링을 줄임
- `canvas.width = 0`, `canvas.height = 0`: LRU에서 밀린 canvas backing store를 명시적으로 해제

따라서 메모리 절감의 주된 원인은 `page.cleanup()`이 아니라, **viewport 기반 windowing, 제한된 LRU 캐시, canvas size reset**입니다.

개선 방향은 다음과 같습니다.

1. `IntersectionObserver`로 viewport 주변 페이지를 감지합니다.
2. 감지된 페이지에만 canvas를 mount하고 PDF.js 렌더링을 실행합니다.
3. 감지되거나 렌더링이 완료된 페이지를 최근 본 페이지 목록 앞으로 이동합니다.
4. 최근 본 페이지는 최대 5개까지만 유지합니다.
5. LRU에서 밀린 페이지는 진행 중인 렌더링을 취소하고, canvas의 `width`와 `height`를 `0`으로 설정해 픽셀 버퍼를 비웁니다.
6. placeholder는 `aspect-ratio`로 유지해 스크롤 높이와 layout shift를 안정화합니다.

### Step 1. Viewport 기반 페이지 감지

모든 페이지를 즉시 렌더링하지 않고, `IntersectionObserver`가 감지한 페이지에 대해서만 렌더링을 시작하도록 변경했습니다.

```tsx
useEffect(() => {
  const target = wrapperRef.current;
  if (!target || typeof IntersectionObserver === "undefined") {
    setShouldRender(true);
    return;
  }

  const observer = new IntersectionObserver(
    ([entry]) => {
      if (!entry) return;

      if (entry.isIntersecting) {
        onPageActive(pageNumber);
        setShouldRender(true);
      }
    },
    { rootMargin: "900px 0px", threshold: 0.01 }
  );

  observer.observe(target);
  return () => observer.disconnect();
}, [onPageActive, pageNumber]);
```

`rootMargin`은 현재 화면에 완전히 들어온 뒤 렌더링을 시작하면 빈 화면이 보일 수 있기 때문에 여유를 두었습니다. 사용자가 스크롤하기 전에 주변 페이지를 미리 렌더링하고, 실제 해제 여부는 최근 페이지 LRU 캐시에서 결정하도록 분리했습니다.

### Step 2. 최근 5페이지 LRU 캐시

처음에는 화면 밖으로 나가는 즉시 canvas를 해제했습니다. 하지만 이 방식은 수치는 가장 좋게 나오더라도 사용자가 방금 지나온 페이지로 살짝 돌아갈 때 다시 렌더링이 발생할 수 있습니다.

그래서 최근 본 페이지를 최대 5개까지 유지하는 LRU 캐시를 추가했습니다.

```tsx
const RETAINED_PAGE_LIMIT = 5;

const markPageActive = useCallback((pageNumber: number) => {
  setRetainedPages((prev) => {
    const next = [pageNumber, ...prev.filter((item) => item !== pageNumber)];
    return next.slice(0, RETAINED_PAGE_LIMIT);
  });
}, []);
```

이렇게 하면 초기 진입 시에는 viewport 주변 1~2페이지만 canvas backing store를 만들고, 스크롤 중에는 최근 본 페이지 최대 5개까지 canvas를 유지합니다. 즉, 메모리 수치만 극단적으로 낮추기보다 사용자가 자연스럽게 앞뒤 페이지를 오갈 수 있는 여지를 남겼습니다.

### Step 3. RenderTask 취소와 canvas backing store 회수

LRU에서 밀린 페이지는 더 이상 canvas를 유지할 필요가 없기 때문에 `releaseCanvas()`에서 렌더링 취소와 픽셀 버퍼 회수를 함께 처리했습니다.

```tsx
const releaseCanvas = useCallback((resetState = true) => {
  if (renderTaskRef.current) {
    try {
      renderTaskRef.current.cancel();
    } catch {
      // ignore cancel error
    }
    renderTaskRef.current = null;
  }

  const canvas = canvasRef.current;
  if (canvas && (canvas.width > 0 || canvas.height > 0)) {
    canvas.width = 0;
    canvas.height = 0;
  }

  if (resetState) {
    renderedRef.current = false;
    setShouldRender(false);
  }
}, []);
```

여기서 핵심은 canvas의 `width`와 `height`를 `0`으로 설정하는 부분입니다.

React에서 canvas를 unmount하면 브라우저가 이후 메모리를 정리할 수는 있지만, 이 개선에서는 LRU에서 밀린 페이지의 픽셀 버퍼를 명시적으로 비우는 것이 목적이었습니다. 따라서 DOM 제거와 별개로 canvas size를 reset하도록 처리했습니다.

canvas는 CSS 크기와 실제 픽셀 버퍼 크기가 분리되어 있습니다. 화면에서 보이는 크기를 줄이거나 DOM에 남겨두는 것만으로는 이미 할당된 픽셀 버퍼가 줄었다고 보기 어렵습니다. 반면 `canvas.width`와 `canvas.height`를 변경하면 canvas backing store가 다시 설정되므로, 캐시에서 제외된 페이지가 유지하던 픽셀 버퍼를 줄일 수 있습니다.

### Step 4. 취소와 cleanup 경로 정리

렌더링 중인 페이지가 LRU에서 밀려 정리 대상이 되면 `RenderTask.cancel()`이 호출됩니다. 이때 PDF.js의 render promise가 reject될 수 있기 때문에, 취소 예외를 구분하고 `finally`에서 `page.cleanup()`이 실행되도록 처리했습니다.

```tsx
useEffect(() => {
  if (!shouldRender || renderedRef.current || !canvasRef.current) return;

  let cancelled = false;
  let page: PDFPageProxy | null = null;
  let task: RenderTask | null = null;

  (async () => {
    try {
      page = await pdf.getPage(pageNumber);
      if (cancelled || !canvasRef.current) return;

      const viewport = page.getViewport({ scale: 1 });
      const canvas = canvasRef.current;
      const context = canvas.getContext("2d");
      if (!context) return;

      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);

      task = page.render({ canvasContext: context, viewport });
      renderTaskRef.current = task;

      await task.promise;
      if (cancelled) return;

      renderedRef.current = true;
      onPageActive(pageNumber);
    } catch (error) {
      const err = error as { name?: string };
      if (cancelled || err?.name === "RenderingCancelledException") {
        return;
      }

      console.error(error);
    } finally {
      if (renderTaskRef.current === task) {
        renderTaskRef.current = null;
      }

      page?.cleanup();
    }
  })();

  return () => {
    cancelled = true;
    releaseCanvas(false);
  };
}, [onPageActive, pageNumber, pdf, releaseCanvas, shouldRender]);
```

이렇게 처리하면 정상 렌더링 완료뿐 아니라 렌더링 취소, 중간 return, 예외 상황에서도 PDF.js page 리소스 정리를 유도할 수 있습니다.

다만 이 cleanup은 기본적인 lifecycle 정리에 가깝습니다. 이번 문제의 핵심이었던 canvas 픽셀 버퍼 누적은 `page.cleanup()`만으로 해결되지 않았고, canvas size reset까지 함께 적용했을 때 줄어드는 것을 확인했습니다.

## 4. 성능 측정

이번 개선은 PDF.js의 렌더링 속도 자체를 빠르게 만드는 것이 아니라, 보이지 않는 페이지의 canvas 픽셀 버퍼 점유를 줄이는 것이 목적이었습니다. 따라서 측정 지표도 canvas 픽셀 버퍼 추정값을 중심으로 잡았습니다.

측정은 Puppeteer를 활용해 자동화했습니다.

특히 이번 측정에서는 기본 cleanup만으로도 메모리가 줄어드는지 확인하기 위해 비교군을 하나 더 두었습니다.

측정 조건은 다음과 같습니다.

- production build
- `next start -p 3124`
- 3회 반복 후 median 사용
- 비교 대상: eager render 방식, cleanup-only 방식, viewport memory + LRU 방식
- PDF: 50페이지 포트폴리오형 PDF, page size 1125×1500pt
- PDF.js render scale 2
- 각 테스트마다 새 Chrome을 실행하고 Chrome 프로세스 트리 RSS를 함께 측정

메모리 추정값은 canvas의 `width`, `height`를 기반으로 계산하기 때문에 CPU throttling의 영향을 받지 않습니다. CPU 4x throttling은 scroll 중 frame gap을 함께 보기 위한 조건으로 사용했습니다.

최종 비교는 세 버전 모두 render scale 2로 통일했습니다. PDF page size 자체를 비정상적으로 키운 것이 아니라, 일반 포트폴리오형 페이지를 Retina 환경에서 선명하게 보여주기 위해 더 큰 canvas backing store로 렌더링하는 상황을 재현하기 위해서입니다.

측정에 사용한 canvas 픽셀 버퍼 추정값은 다음과 같이 계산했습니다.

```ts
const canvases = Array.from(document.querySelectorAll("canvas"));

const totalCanvasBytes = canvases.reduce((sum, canvas) => {
  return sum + canvas.width * canvas.height * 4;
}, 0);
```

또한 viewport 밖에 있는 canvas를 따로 구분해 offscreen canvas pixel buffer도 함께 측정했습니다.

```ts
const rect = canvas.getBoundingClientRect();
const isVisible =
  rect.width > 0 &&
  rect.height > 0 &&
  rect.bottom >= 0 &&
  rect.top <= window.innerHeight;
```

스크롤 시나리오는 문서 최상단에서 최하단까지 32단계로 이동한 뒤, 다시 최상단으로 돌아오는 방식으로 구성했습니다. 각 단계 사이에는 45ms 대기 시간을 두었고, 스크롤 이후 1초를 추가로 대기했습니다.

32ms 초과 frame은 30fps 이하로 떨어질 수 있는 구간을 보기 위한 보조 지표로 사용했습니다. 핵심 지표는 frame 수가 아니라 canvas 픽셀 버퍼 추정값입니다.

측정 지표는 다음과 같습니다.

- 초기 canvas 개수
- 초기 offscreen canvas 개수
- 초기 canvas pixel buffer 추정값
- offscreen canvas pixel buffer 추정값
- scroll 중 peak canvas pixel buffer 추정값
- 대표 canvas 크기

### 50페이지 포트폴리오형 PDF

| 버전 | 초기 canvas | 초기 offscreen canvas | 초기 canvas 추정값 | offscreen canvas 추정값 | peak canvas 추정값 | 대표 canvas |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Basic eager PDF.js | 50 | 49 | 1287.5MB | 1261.7MB | 1287.5MB | 2250×3000 |
| Cleanup Only PDF.js | 50 | 49 | 1287.5MB | 1261.7MB | 1287.5MB | 2250×3000 |
| Viewport Memory + LRU PDF.js | 2 | 1 | 51.5MB | 25.7MB | 128.7MB | 2250×3000 |

측정 결과, Basic eager 방식과 Cleanup Only 방식은 거의 같은 결과가 나왔습니다.

Basic eager와 Cleanup Only의 초기 canvas 픽셀 버퍼 추정값은 모두 **1287.5MB**였습니다. 즉, `RenderTask.cancel()`과 `page.cleanup()`을 추가해도 전체 페이지를 한 번에 canvas로 유지하는 구조라면 초기 canvas 픽셀 버퍼는 줄어들지 않았습니다.

반면 Viewport Memory + LRU 방식에서는 초기 유지 canvas 수가 **50개에서 2개**로 줄었습니다. 초기 canvas 픽셀 버퍼 추정값은 **1287.5MB에서 51.5MB로 감소**했습니다.

이 감소폭은 어떤 압축이나 렌더링 알고리즘 개선에서 나온 것이 아닙니다. 유지하는 canvas backing store 개수가 `50개 -> 2개`로 줄어든 결과입니다. 수식으로 보면 `2 / 50 = 4.0%`이고, 그래서 감소율이 `96.0%`가 됩니다.

이 PDF는 페이지당 대표 canvas가 **2250×3000**, 평균 픽셀 버퍼가 약 **25.7MB/page**로 측정되었습니다. 따라서 모든 페이지를 한 번에 canvas로 유지하면 전체 추정값이 1GB를 넘는 구조였습니다.

또한 offscreen canvas 추정값은 **1261.7MB에서 25.7MB로 감소**했습니다. scroll 중 peak canvas 추정값은 최근 5페이지를 유지하도록 조정하면서 **1287.5MB에서 128.7MB로 감소**했습니다.

이 결과를 통해 이번 최적화의 핵심을 더 명확하게 볼 수 있었습니다.

단순히 PDF.js page cleanup을 호출한 것이 아니라, **렌더링 대상 자체를 viewport 주변으로 제한하고 LRU에서 밀린 canvas backing store를 비운 것**이 실제 메모리 회수 효과를 만들었습니다. 그래서 이 개선의 어필 지점도 `page.cleanup()` 호출 여부가 아니라, 전체 페이지를 동시에 유지하지 않도록 canvas 리소스 생명주기를 관리했다는 점에 있습니다.

초기 진입 지표도 함께 확인했습니다. 메모리 지표만큼 직접적인 원인 지표는 아니지만, 사용자가 결과 화면에 들어왔을 때의 체감 성능을 설명하는 보조 지표로 볼 수 있습니다.

초기 진입 구간의 TBT 추정값은 Basic eager가 **463ms**, Cleanup Only가 **441ms**, Viewport Memory + LRU가 **249ms**였습니다. First canvas paint도 Basic eager **3456ms**, Viewport Memory + LRU **923ms**로 차이가 났습니다.

프레임 안정성도 초기 진입 구간에서는 차이가 있었습니다. 초기 p95 frame gap은 Basic eager **108ms**, Viewport Memory + LRU **9ms**였고, 32ms 초과 frame은 **26개에서 6개**로 줄었습니다. 다만 이 수치 역시 canvas memory와 함께 해석해야 하는 보조 지표입니다.

따라서 이 작업의 대표 성과는 **동시에 유지하는 canvas backing store 수를 제한해 초기 진입 메모리와 초기 프레임 지연을 줄인 것**으로 정리했습니다.

추정값만으로는 실제 브라우저 메모리 사용량을 설명하기 어렵기 때문에, 각 테스트마다 새 Chrome 인스턴스를 띄우고 Chrome 프로세스 트리의 RSS도 함께 측정했습니다. 이 값은 정확한 탭 단위 메모리는 아니지만, renderer/GPU/utility 프로세스를 포함한 실제 프로세스 메모리의 근사값으로 볼 수 있습니다.

| 버전 | 초기 Chrome RSS | 초기 RSS 증가량 | 스크롤 후 Chrome RSS | 스크롤 후 RSS 증가량 | JS heap |
| --- | ---: | ---: | ---: | ---: | ---: |
| Basic eager PDF.js | 2224.9MB | +1516.2MB | 2223.4MB | +1514.7MB | 7.3MB |
| Cleanup Only PDF.js | 2431.0MB | +1722.0MB | 2780.1MB | +2071.2MB | 6.6MB |
| Viewport Memory + LRU PDF.js | 953.5MB | +244.0MB | 989.9MB | +281.9MB | 5.1MB |

이 결과에서도 Basic eager 방식은 초기 진입 후 Chrome 프로세스 RSS가 baseline 대비 **1516.2MB** 증가했고, Viewport Memory + LRU 방식은 **244.0MB** 증가에 그쳤습니다. JS heap은 세 버전 모두 5~7MB 수준이었기 때문에, 이번 병목은 JS 객체 누적보다는 canvas/GPU 계층의 리소스 점유에 더 가깝다고 볼 수 있었습니다.

## 5. 한계

이번 방식은 viewport 밖 canvas 픽셀 버퍼를 줄이는 데 효과가 있었지만, 모든 비용을 제거하는 방식은 아닙니다.

사용자가 오래전에 지나간 페이지 근처로 스크롤하면 해당 페이지는 다시 PDF.js로 렌더링해야 합니다. 최근 5페이지 LRU 캐시로 바로 앞뒤 페이지 이동은 완화했지만, 전체 페이지를 모두 즉시 재방문 가능한 상태로 유지하는 방식은 아닙니다. 또한 빠르게 스크롤하는 경우에는 페이지가 rootMargin에 들어왔다가 바로 나가면서 렌더링 시작과 취소가 반복될 수 있습니다.

향후에는 다음과 같은 개선을 추가로 고려할 수 있습니다.

- 동시 렌더링 개수 제한
- visible page 우선순위 큐
- 빠른 스크롤 중 prewarm 지연
- 렌더링 취소 빈도 측정

이번 개선은 PDF.js 렌더링 전체 비용을 없애는 작업이 아니라, **화면 밖 canvas 픽셀 버퍼 점유를 제한하면서 최근 페이지 재방문 UX를 일부 보존하는 windowing 작업**입니다.

## 6. 결론

대용량 PDF 결과 화면에서 발생한 메모리 병목의 핵심은 PDF.js 자체가 느리다는 점이 아니라, **보이지 않는 페이지의 canvas 픽셀 버퍼까지 유지하고 있다는 점**이었습니다.

이를 해결하기 위해 `RenderTask.cancel()`과 `page.cleanup()`만 적용한 cleanup-only 비교군을 먼저 만들었습니다. 그 결과 기본 cleanup만으로는 이미 렌더링된 canvas 픽셀 버퍼가 줄어들지 않는다는 것을 확인했습니다.

이후 `IntersectionObserver`를 활용해 viewport 주변 페이지에 대해서만 PDF.js 렌더링을 수행하도록 변경했습니다. 또한 최근 본 페이지를 최대 5개까지 유지하는 LRU 캐시를 두고, 캐시에서 밀린 페이지는 `RenderTask.cancel()`로 진행 중인 렌더링을 취소하고 canvas `width`와 `height`를 `0`으로 reset하여 픽셀 버퍼를 명시적으로 회수했습니다.

그 결과, 50페이지 포트폴리오형 PDF 기준 초기 유지 canvas 수를 **50개에서 2개**로 줄였고, 초기 canvas 픽셀 버퍼 추정값은 **1287.5MB에서 51.5MB**로 감소했습니다. 스크롤 중 peak canvas 추정값은 최근 5페이지 캐시를 유지한 상태에서 **128.7MB**로 측정되었습니다. 실제 프로세스 메모리 근사값인 Chrome RSS 증가량도 초기 기준 **1516.2MB에서 244.0MB**로 감소했습니다.

이 개선은 PDF.js의 페이지 rasterizing 비용 자체를 줄인 작업이 아닙니다. 정확히는 **보이지 않는 페이지의 canvas backing store 점유를 제한하고, 최근 페이지는 캐시하는 windowing 개선**입니다.

PDF 원본과 페이지 좌표계를 유지해야 하는 이력서 피드백 서비스 특성상, PDF.js를 제거하기보다 화면 주변 페이지만 렌더링하고 최근 페이지를 제한적으로 캐시하면서 화면 밖 canvas 픽셀 버퍼를 회수하는 방향이 더 적합하다고 판단했습니다.

정리하면, 이번 작업의 핵심은 다음 한 문장으로 설명할 수 있습니다.

> PDF.js 기반 결과 화면에서 전체 50페이지 canvas를 eager하게 유지하던 구조를 viewport windowing과 최근 5페이지 LRU 캐시 방식으로 변경했습니다. 기본 `page.cleanup()`만으로는 이미 렌더링된 canvas 픽셀 버퍼가 줄지 않는 것을 비교군으로 확인했고, LRU에서 밀린 canvas의 size reset을 적용해 초기 canvas 픽셀 버퍼 추정값을 1287.5MB에서 51.5MB로 줄였습니다.
