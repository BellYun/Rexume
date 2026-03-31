/// <reference lib="webworker" />

/**
 * pdfOpt15 — PDF 렌더 전용 Web Worker
 *
 * 메인 스레드 대신 이 Worker에서 pdfjs를 완전히 실행:
 *   1. 'load'    : PDF URL → getDocument() → numPages 반환
 *   2. 'getSize' : pageNumber → viewport 크기 반환 (placeholder용)
 *   3. 'render'  : pageNumber → OffscreenCanvas 렌더 → ImageBitmap 전송
 *
 * ImageBitmap은 transferable로 전송 → 복사 없이 GPU 메모리 직접 이동
 */

// pdfjs-dist가 window.location, document.createElement 등을 참조하므로
// import 전에 폴리필 필요
const _self = self as unknown as Record<string, unknown>;
_self.window = self;
const noop = () => {};
const fakeEl = () => ({
  getContext: () => null, appendChild: noop, removeChild: noop,
  setAttribute: noop, getAttribute: () => null, style: {},
  classList: { add: noop, remove: noop, contains: () => false },
  children: [], childNodes: [], querySelectorAll: () => [], querySelector: () => null,
});
_self.document = {
  createElement: fakeEl, createElementNS: fakeEl,
  currentScript: { src: '' }, head: fakeEl(), body: fakeEl(),
  documentElement: fakeEl(), querySelectorAll: () => [],
  querySelector: () => null, getElementById: () => null,
  addEventListener: noop, removeEventListener: noop,
};

import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist/build/pdf';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';

// Worker 내부에서 pdfjs의 중첩 Worker 설정
// 최신 브라우저는 nested worker를 지원함
GlobalWorkerOptions.workerSrc = '/pdf.worker.min.js';

let pdfDoc: PDFDocumentProxy | null = null;
const pageCache = new Map<number, PDFPageProxy>();

self.addEventListener('message', async (e: MessageEvent) => {
  const { type, url, pageNumber, scale = 2 } = e.data as {
    type: string;
    url?: string;
    pageNumber?: number;
    scale?: number;
  };

  // ── PDF 문서 로드 ─────────────────────────────────────────────────────
  if (type === 'load') {
    if (!url) return;
    try {
      const origin = self.location.origin;
      pdfDoc = await getDocument({
        url,
        cMapUrl: `${origin}/api/pdfjs/cmaps/`,
        cMapPacked: true,
        standardFontDataUrl: `${origin}/api/pdfjs/fonts/`,
        disableFontFace: true,
      }).promise;
      pageCache.clear();
      self.postMessage({ type: 'loaded', numPages: pdfDoc.numPages });
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? 'PDF load failed';
      self.postMessage({ type: 'error', error: msg });
    }
    return;
  }

  if (!pdfDoc || pageNumber == null) return;

  // ── 페이지 크기 조회 (placeholder용) ──────────────────────────────────
  if (type === 'getSize') {
    try {
      const page = await pdfDoc.getPage(pageNumber);
      pageCache.set(pageNumber, page);
      const viewport = page.getViewport({ scale });
      self.postMessage({ type: 'size', pageNumber, width: viewport.width, height: viewport.height });
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? 'getSize failed';
      self.postMessage({ type: 'sizeError', pageNumber, error: msg });
    }
    return;
  }

  // ── 페이지 렌더링 → ImageBitmap 전송 ─────────────────────────────────
  if (type === 'render') {
    try {
      const page = pageCache.get(pageNumber) ?? await pdfDoc.getPage(pageNumber);
      if (!pageCache.has(pageNumber)) pageCache.set(pageNumber, page);

      const viewport = page.getViewport({ scale });
      const canvas = new OffscreenCanvas(viewport.width, viewport.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('OffscreenCanvas 2d context 없음');

      await page.render({ canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport }).promise;

      // GPU 메모리 직접 이전 (복사 없음)
      const bitmap = canvas.transferToImageBitmap();
      self.postMessage({ type: 'rendered', pageNumber, bitmap }, [bitmap]);
    } catch (err: unknown) {
      const error = err as { name?: string; message?: string };
      if (error?.name !== 'RenderingCancelledException') {
        self.postMessage({ type: 'renderError', pageNumber, error: error?.message });
      }
    }
  }
});
