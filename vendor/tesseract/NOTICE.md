# 문자 인식(OCR) 부품

스캔한 PDF·그림에서 글을 읽을 때 쓴다. 모두 이 폴더에 담겨 있어 인터넷 없이 동작한다.

| 파일 | 출처 | 허가 |
|---|---|---|
| tesseract.esm.min.js, worker.min.js | tesseract.js 7.0.0 (https://github.com/naptha/tesseract.js) | Apache-2.0 (LICENSE.md). 묶여 든 작은 부품의 허가는 worker.min.js.LICENSE.txt |
| tesseract-core-simd-lstm.js, tesseract-core-simd-lstm.wasm | tesseract.js-core 7.0.0 — Tesseract OCR(Apache-2.0)과 Leptonica(BSD-2-Clause)를 WebAssembly 로 옮긴 것 | Apache-2.0 / BSD-2-Clause |
| lang/kor.traineddata.gz, lang/eng.traineddata.gz | tessdata_best(정수판, 4.0.0) — @tesseract.js-data/kor·eng 1.0.0 | Apache-2.0 |
