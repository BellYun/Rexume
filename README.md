# ReXume Frontend_Optimization

PDF 뷰어 렌더링 성능 최적화를 위한 Next.js 프로젝트입니다.

## 프로젝트 소개

이 프로젝트는 대용량 PDF 문서의 렌더링 성능을 최적화하기 위한 다양한 기법을 연구하고 비교합니다.
IntersectionObserver와 requestAnimationFrame을 활용하여 사용자 경험을 개선한 PDF 뷰어를 제공합니다.

## 시작하기

### 개발 서버 실행

```bash
npm install
npm run dev
```

브라우저에서 [http://localhost:3000](http://localhost:3000)을 열면 PDF 렌더링 버전 비교 페이지를 확인할 수 있습니다.

### 빌드

```bash
npm run build
npm start
```

## PDF 뷰어 버전

프로젝트는 세 가지 버전의 PDF 뷰어를 제공합니다:

### 1. 기본 버전
- **경로**: `/feedback-basic/[id]`
- **특징**: 성능 최적화가 적용되지 않은 기본 PDF 뷰어
- **용도**: 성능 비교를 위한 베이스라인

### 2. Simple 버전
- **경로**: `/feedback/[id]?version=simple`
- **특징**: 스케줄러 없이 단순한 IntersectionObserver만 사용
- **장점**: 구현이 간단하며 기본적인 뷰포트 기반 렌더링 제공

### 3. rAF 버전
- **경로**: `/feedback/[id]?version=raf`
- **특징**: requestAnimationFrame을 사용한 렌더링 최적화
- **장점**: 프레임 기반 렌더링으로 부드러운 사용자 경험 제공

## 성능 벤치마크

프로젝트는 다양한 성능 측정 도구를 포함하고 있습니다:

```bash
# Web Vitals 측정
npm run bench:webvitals

# 첫 페이지 렌더링 성능 측정
npm run bench:firstpage

# Long Task 분석
npm run bench:longtask

# 시나리오 기반 벤치마크
npm run bench:scenario
```

벤치마크 결과는 `bench/results/` 디렉토리에 저장됩니다.

## 성능 측정 결과

이 프로젝트의 주목적은 PDF를 확인하는 것인데, 페이지에서 PDF 렌더링 시점은 Lighthouse에서 제공하지 않기 때문에 따로 측정을 시도하였습니다.

### PDF 첫 페이지 렌더링 시간 (ms) (쓰로틀링 4x)

| 버전 | 평균 |
| --- | --- |
| **Basic (개선 전)** | 3593ms |
| **Simple (IntersectionObserver)** | 3330ms |
| **RAF (requestAnimationFrame)** | 31838ms |

전체적으로 IntersectionObserver를 적용한 버전이 기존 버전보다도 PDF 첫 페이지 렌더링 시간이 늦었습니다. IntersectionObserver를 적용했기 때문에 IntersectionObserver가 **상태 업데이트를 자주 발생**시킴이 추가적인 병목으로 발생한 것으로 판단됩니다.

### Total Blocking Time (TBT, ms) (쓰로틀링 4x)

| 버전 | 평균 |
| --- | --- |
| **Basic (개선 전)** | 1551ms |
| **Simple (IntersectionObserver)** | 1141ms |
| **RAF (requestAnimationFrame)** | 1056ms |


### 결론

- `IntersectionObserver`만으로는 통신 폭주와 setState 병목을 해결할 수 없었습니다.
- **rAF Batch**를 적용하면서 초기 렌더링 부하와 커밋 병목이 모두 해결되었습니다.
- **PDF 첫 페이지 렌더링 시간 11.3% 개선, TBT 31.9% 개선**

## 기술 스택

- **Framework**: Next.js 15.5
- **UI**: React 19, Tailwind CSS
- **PDF 렌더링**: pdfjs-dist 3.11
- **상태 관리**: Zustand
- **데이터 페칭**: TanStack Query (React Query)
- **성능 측정**: Puppeteer, Lighthouse, Web Vitals

## 프로젝트 구조

```
frontend/
├── src/
│   ├── app/                    # Next.js App Router 페이지
│   │   ├── feedback/          # Simple & rAF 버전
│   │   ├── feedback-basic/    # 기본 버전
│   │   └── api/               # API 라우트
│   ├── components/            # React 컴포넌트
│   ├── libs/                  # 렌더링 스케줄러
│   ├── store/                 # Zustand 스토어
│   └── api/                   # API 클라이언트
├── bench/                     # 성능 벤치마크 스크립트
└── public/                    # 정적 파일
```

## 주요 기능

- 대용량 PDF 문서의 효율적인 렌더링
- 뷰포트 기반 지연 렌더링
- 다양한 렌더링 전략 비교
- 실시간 성능 메트릭 측정
- 사용자 피드백 시스템

## 개발 참고사항

- PDF Worker는 빌드 후 자동으로 public 디렉토리에 복사됩니다 (`postbuild` 스크립트)
- 성능 테스트는 headless Chrome을 사용하여 자동화되어 있습니다
- 각 버전의 성능 차이를 확인하려면 메인 페이지에서 버전별로 테스트해보세요
