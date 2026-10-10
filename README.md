# DRE — Document Reformatting Engine

한글·워드 문서를 PDF로, PDF·문서의 글을 TXT로, 여러 문서를 PDF 하나로 바꾸는 설치형 웹 앱(PWA).

## 할 수 있는 일
- **PDF로 변환**: 한글(HWP·HWPX)·워드(DOC·DOCX)·엑셀·파워포인트·전자책(EPUB)·그림 → PDF. 여러 개를 한꺼번에. 이름은 원본 그대로(확장자만 .pdf).
  전자책은 장마다 새 쪽(A4)으로, 책에 든 글꼴·그림 그대로 인쇄한다(고정 쪽 그림책은 쪽마다 원래 크기). 제목은 책갈피로.
  문서마다 쪽 범위를 고를 수 있다(쪽 그림을 보며). 이미 PDF인 것은 쪽을 고르면 그 쪽만 뽑는다.
- **텍스트 추출**: PDF·한글·워드·엑셀(XLSX·XLS·ODS)·파워포인트(PPTX·PPT·ODP)·RTF·ODT·전자책(EPUB)·그림 → TXT. PC 프로그램 없이 앱이 직접 읽는다.
  줄이 끊긴 PDF 글을 문장으로 다시 잇고('되었' + '습니다' → '되었습니다'), 표·글머리표·들여쓰기·문단 간격을 살린다.
  엑셀 셀은 엑셀이 화면에 그리는 글(날짜·쉼표·백분율 등 서식대로)로 뽑는다. 스캔한 PDF 쪽과 그림은 문자 인식(OCR, 한국어·영어)으로 읽는다.
  전자책은 숨긴 글을 빼고, 루비(한자 읽기)는 괄호로, 방점은 빼고, 각주는 끝에 모은다.
  머리말·꼬리말·쪽 번호는 뺄 수 있다. 쪽 범위 지정 가능(엑셀은 시트 단위, 발표 문서는 슬라이드 단위).
- **PDF 합치기**: 형식이 섞여 있어도(한글·워드·PDF·그림…) 끌어서 순서를 정해 PDF 하나로. 문서마다 쪽 범위,
  문서별 책갈피(원래 책갈피는 그 아래로). 편집이 막힌(암호 걸린) PDF도 합칠 수 있다.

## 구조
- 앱(이 폴더): 브라우저 안에서 PDF·한글·워드·엑셀·파워포인트·RTF·오픈문서·전자책을 직접 읽고 그림 속 글자를 인식한다(`js/core`).
  무거운 일은 작업 스레드(`js/worker/task.js`)에서.
- **PC 프로그램 DRE.exe**(`engine/`): 한글·워드 문서를 원본과 똑같은 모양의 PDF로 만들 때만 쓰는, 이 PC의 한글·워드·엑셀·파워포인트를
  숨긴 채 부르는 작은 Windows 프로그램(C#, .NET Framework 4 기본 컴파일러로 빌드: `engine/build.ps1`).
  127.0.0.1 에서만 듣고 DRE 앱에서 온 요청만 받는다. 쉬면 메모리를 거의 안 쓰고, 오피스 프로그램은 1분 쉬면 닫는다.
  전자책(EPUB)은 앱이 장들을 웹 문서 한 장으로 묶어(그림·글꼴은 안에, 스크립트·인터넷 연결은 빼고 보안 정책으로 한 번 더 막음) 보내면,
  DRE.exe 가 이 PC의 엣지(없으면 크롬)를 새 빈 프로필로 화면 없이 띄워 PDF로 인쇄한다. 앱이 그 PDF의 글자 대응표(빈칸·한자)를 바로잡는다.
- 모든 변환은 PC 안에서만 한다. 문서를 인터넷으로 보내지 않는다.

## 쓴 부품
- [pdf.js](https://github.com/mozilla/pdf.js) (Apache-2.0) — PDF 읽기·쪽 그림·합치기
- [pdf-lib](https://github.com/Hopding/pdf-lib) (MIT) — 책갈피·그림 PDF
- [fflate](https://github.com/101arrowz/fflate) (MIT) — 압축 풀기(HWPX·DOCX·XLSX·PPTX·오픈문서·EPUB)
- [tesseract.js](https://github.com/naptha/tesseract.js) 7.0.0·tesseract.js-core(Tesseract OCR·Leptonica)·tessdata_best 한국어·영어 (Apache-2.0, BSD-2-Clause)
  — 문자 인식(`vendor/tesseract/NOTICE.md`)
- [mecab-ko-dic](https://bitbucket.org/eunjeon/mecab-ko-dic) 2.1.1 (Apache-2.0) — 줄 잇기 판단에 쓰는 국어사전 낱말 목록(`js/core/dictdata.js`, `vendor/mecab-ko-dic/`)
