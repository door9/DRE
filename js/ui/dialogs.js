// 대화 상자 — 설정, PC의 DRE 안내
import { settings, saveSettings, applyTheme } from '../settings.js';
import { engine, checkEngine, launchEngine, onEngine, SERVED_BY_ENGINE } from '../engine.js';
import { h, ico, infoToggle, toast } from '../util.js';
import { chooseFolder, savedFolderName, canPickFolder } from '../save.js';
import { emit } from '../store.js';
import { BUILD } from '../version.js';

function dialog(title, body, foot = []) {
  const d = h('dialog');
  d.append(
    h('div.dlg-head', {}, h('h3', { text: title }), h('div.grow'), h('button.icon-btn', { type: 'button', title: '닫기', html: ico('x'), onclick: () => d.close() })),
    body,
    h('div.dlg-foot', {}, ...foot, h('button.btn', { type: 'button', text: '닫기', onclick: () => d.close() })),
  );
  d.addEventListener('close', () => d.remove());
  document.body.append(d);
  d.showModal();
  return d;
}

const APP_NAMES = { hwp: '한글', word: '워드', excel: '엑셀', powerpoint: '파워포인트' };

function engineStatusText() {
  switch (engine.status) {
    case 'on': return `켜져 있음${engine.version ? ` (판 ${engine.version})` : ''}`;
    case 'starting': return '켜는 중…';
    case 'off': return '꺼져 있음';
    case 'none': return '찾지 못함(설치하지 않았거나 꺼져 있음)';
    default: return '확인 중…';
  }
}

export function openEngineDialog() {
  const kv = h('dl.kv');
  const fill = () => {
    kv.innerHTML = '';
    kv.append(h('dt', { text: '상태' }), h('dd', { text: engineStatusText() }));
    if (engine.status === 'on') {
      const apps = Object.entries(engine.apps || {}).filter(([, v]) => v).map(([k]) => APP_NAMES[k] || k);
      kv.append(h('dt', { text: '쓸 수 있는 프로그램' }), h('dd', { text: apps.length ? apps.join(', ') : '없음' }));
    }
  };
  fill();
  const off = onEngine(fill);
  const body = h('div.dlg-body', { 'data-info-host': '' },
    h('p', { style: 'margin-top:0' }, '한글·워드·엑셀·파워포인트 문서를 PDF로 바꿀 때는 이 PC에 깔린 프로그램을 씁니다. 그 다리 역할을 하는 작은 프로그램이 이 PC에 설치하는 ', h('b', { text: 'DRE' }), '입니다. ', infoToggle(
      `<p>원본과 똑같은 모양의 PDF를 만들려면 문서를 만든 프로그램(한글·워드)이 직접 그려야 합니다. 브라우저만으로는 한글 문서를 정확히 그릴 수 없어서, DRE는 이 PC의 프로그램을 숨긴 채 불러 PDF를 만듭니다.</p>
       <p>이 프로그램은 이 PC 안(127.0.0.1)에서만 듣고, DRE 앱에서 온 요청만 받습니다. 쉴 때는 메모리를 거의 쓰지 않고, 일이 끝나면 한글·워드를 1분 안에 닫습니다. 30분 동안 일이 없으면 스스로 꺼집니다(알림 영역 아이콘 메뉴에서 바꿀 수 있음).</p>
       <p>글 뽑기(TXT)와 PDF 합치기·쪽 뽑기는 이 프로그램 없이도 됩니다. 이 프로그램이 필요한 것은 한글·워드 등을 PDF로 바꿀 때뿐입니다.</p>
       <p>크롬이 '이 기기의 다른 앱과 서비스에 접근'을 물으면 <b>허용</b>을 눌러야 앱이 이 프로그램과 이야기할 수 있습니다(한 번만). 처음 켤 때 크롬이 프로그램을 열지 물으면 '항상 허용'에 표시해 두면 다음부터 묻지 않습니다.</p>`)),
    kv,
    SERVED_BY_ENGINE
      ? h('p', { class: 'small muted', style: 'margin:10px 0 0' }, '이 앱은 PC에 설치한 DRE가 PC 안 주소로 띄운 것이라 인터넷 없이 동작합니다. 지울 때는 Windows 설정 > 앱에서 \'DRE\'를 지웁니다.')
      : h('div', {},
        h('h4', { text: '이 PC에 DRE가 설치돼 있지 않다면' }),
        h('p', { class: 'small', style: 'margin:4px 0' }, '아래에서 DRE.exe를 내려받아 한 번 실행하면 설치됩니다(관리자 권한 필요 없음). 설치하면 시작 메뉴 \'DRE\'로 인터넷 없이도 열 수 있습니다. 지울 때는 Windows 설정 > 앱에서 \'DRE\'를 지웁니다.'),
        h('div.row', {}, h('a.btn', { href: 'engine/DRE.exe', download: 'DRE.exe', html: `${ico('save')}DRE 내려받기` }), h('span.muted.small', { text: 'Windows 전용' })),
      ),
  );
  const d = dialog('DRE', body, [
    h('button.btn', { type: 'button', text: '다시 확인', onclick: () => checkEngine() }),
    h('button.btn.primary', { type: 'button', html: `${ico('plug')}DRE 켜기`, onclick: () => launchEngine() }),
  ]);
  d.addEventListener('close', off);
}

export function openSettings() {
  const radio = (name, value, label, checked, onchange) => h('label.check', {}, h('input', { type: 'radio', name, value, checked: checked || null, onchange }), label);
  const folderLabel = h('span.muted.small', { text: savedFolderName() ? `고른 폴더: ${savedFolderName()}` : '' });
  const body = h('div.dlg-body', { 'data-info-host': '' },
    h('h4', { text: '저장' }),
    h('div.row', {},
      radio('save', 'download', '다운로드 폴더', settings.save === 'download', () => { settings.save = 'download'; saveSettings(); emit('save-target'); }),
      radio('save', 'folder', '고른 폴더', settings.save === 'folder', async () => { settings.save = 'folder'; saveSettings(); emit('save-target'); }),
      radio('save', 'source', '원본과 같은 폴더', settings.save === 'source', () => { settings.save = 'source'; saveSettings(); emit('save-target'); }),
    ),
    h('div.row', {},
      canPickFolder() ? h('button.btn.tiny', { type: 'button', text: '폴더 고르기…', onclick: async () => { try { await chooseFolder(); folderLabel.textContent = `고른 폴더: ${savedFolderName()}`; settings.save = 'folder'; saveSettings(); emit('save-target'); } catch { /* 취소 */ } } }) : null,
      folderLabel,
      infoToggle('<p>같은 이름의 파일이 이미 있으면 덮어쓰지 않고 \'이름 (1)\'로 저장합니다.</p><p>\'원본과 같은 폴더\'는 <b>폴더 추가</b>나 폴더를 끌어다 넣은 파일에만 됩니다(브라우저는 따로 고른 파일의 폴더를 알 수 없음). 나머지는 다운로드 폴더에 저장합니다.</p>'),
    ),
    h('h4', { text: '텍스트 파일(TXT)' }),
    h('div.row', {},
      h('span.muted.small', { text: '줄 끝' }),
      radio('eol', 'crlf', '윈도우(CRLF)', settings.eol !== 'lf', () => { settings.eol = 'crlf'; saveSettings(); }),
      radio('eol', 'lf', 'LF', settings.eol === 'lf', () => { settings.eol = 'lf'; saveSettings(); }),
    ),
    h('div.row', {},
      h('label.check', {}, h('input', { type: 'checkbox', checked: settings.bom || null, onchange: (e) => { settings.bom = e.target.checked; saveSettings(); } }), 'UTF-8 표시(BOM) 넣기'),
      infoToggle('<p>BOM을 넣으면 한글·메모장·엑셀이 글자 인코딩을 바로 알아봐 한글이 깨지지 않습니다. 프로그래밍 용도라면 끄세요.</p>'),
    ),
    h('h4', { text: '화면' }),
    h('div.row', {},
      radio('theme', 'auto', '시스템 따라', settings.theme === 'auto', () => { settings.theme = 'auto'; saveSettings(); applyTheme(); }),
      radio('theme', 'light', '밝게', settings.theme === 'light', () => { settings.theme = 'light'; saveSettings(); applyTheme(); }),
      radio('theme', 'dark', '어둡게', settings.theme === 'dark', () => { settings.theme = 'dark'; saveSettings(); applyTheme(); }),
    ),
    h('h4', { text: 'DRE' }),
    h('div.row', {}, h('span', { text: engineStatusText() }), h('button.btn.tiny', { type: 'button', text: '자세히', onclick: () => { d.close(); openEngineDialog(); } })),
    h('h4', { text: '정보' }),
    h('div.small.muted', {}, `DRE — Document Reformatting Engine · 판 ${BUILD} `, infoToggle(
      '<p><b>단축키</b>: Ctrl+O 파일 추가 · Ctrl+Enter 실행 · Delete 목록에서 빼기 · ↑↓ 파일 고르기 · Alt+↑↓ 순서 바꾸기(합치기)</p>' +
      '<p>파일·폴더를 창에 끌어다 놓아도 됩니다. 설치한 앱이면 탐색기에서 파일을 오른쪽 단추 > 연결 프로그램 > DRE 로도 열 수 있습니다.</p>')),
    h('div.small.muted', { text: '모든 변환은 이 PC 안에서만 일어납니다. 문서를 인터넷으로 보내지 않습니다.' }),
  );
  const d = dialog('설정', body);
}

export function engineChipSetup() {
  const chip = document.getElementById('engineChip');
  const label = chip.querySelector('.label');
  onEngine((e) => {
    chip.dataset.state = e.busy && e.status === 'on' ? 'busy' : e.status;
    label.textContent = e.status === 'on' ? (e.busy ? 'DRE 작업 중' : 'DRE 켜짐') : e.status === 'starting' ? 'DRE 켜는 중' : e.status === 'checking' ? 'DRE 확인 중' : 'DRE 꺼짐';
    chip.title = e.status === 'on' ? `DRE 켜짐 — ${Object.entries(e.apps || {}).filter(([, v]) => v).map(([k]) => APP_NAMES[k]).join('·')}` : 'DRE 꺼짐 — 눌러서 켜기';
  });
  chip.addEventListener('click', () => {
    if (engine.status === 'off') { launchEngine().then((ok) => { if (!ok) openEngineDialog(); }); return; }
    openEngineDialog();
  });
}
