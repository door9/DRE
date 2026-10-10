// HTML 이름 붙은 글자(&nbsp; &hellip; …) — XHTML 1.x 가 정한 252개(HTML 4: lat1·symbol·special)와 전자책에 가끔 보이는 HTML5 이름 몇 개.
// 전자책(EPUB) XHTML 은 XML 이지만 이 이름들을 흔히 쓴다(XML 기본 다섯 개 밖). xml.js 의 HTML 모드가 쓴다.

// 160~255(lat1) — 차례대로
const LAT1 = 'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest ' +
  'Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig ' +
  'agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml';

// 이름:번호 — special·symbol(HTML 4) + HTML5 몇 개(lang·rang 은 HTML5 값 U+27E8·27E9)
const MORE = 'quot:34 amp:38 lt:60 gt:62 apos:39 OElig:338 oelig:339 Scaron:352 scaron:353 Yuml:376 circ:710 tilde:732 ensp:8194 emsp:8195 thinsp:8201 ' +
  'zwnj:8204 zwj:8205 lrm:8206 rlm:8207 ndash:8211 mdash:8212 lsquo:8216 rsquo:8217 sbquo:8218 ldquo:8220 rdquo:8221 bdquo:8222 dagger:8224 Dagger:8225 ' +
  'permil:8240 lsaquo:8249 rsaquo:8250 euro:8364 fnof:402 Alpha:913 Beta:914 Gamma:915 Delta:916 Epsilon:917 Zeta:918 Eta:919 Theta:920 Iota:921 Kappa:922 ' +
  'Lambda:923 Mu:924 Nu:925 Xi:926 Omicron:927 Pi:928 Rho:929 Sigma:931 Tau:932 Upsilon:933 Phi:934 Chi:935 Psi:936 Omega:937 alpha:945 beta:946 gamma:947 ' +
  'delta:948 epsilon:949 zeta:950 eta:951 theta:952 iota:953 kappa:954 lambda:955 mu:956 nu:957 xi:958 omicron:959 pi:960 rho:961 sigmaf:962 sigma:963 ' +
  'tau:964 upsilon:965 phi:966 chi:967 psi:968 omega:969 thetasym:977 upsih:978 piv:982 bull:8226 hellip:8230 prime:8242 Prime:8243 oline:8254 frasl:8260 ' +
  'weierp:8472 image:8465 real:8476 trade:8482 alefsym:8501 larr:8592 uarr:8593 rarr:8594 darr:8595 harr:8596 crarr:8629 lArr:8656 uArr:8657 rArr:8658 ' +
  'dArr:8659 hArr:8660 forall:8704 part:8706 exist:8707 empty:8709 nabla:8711 isin:8712 notin:8713 ni:8715 prod:8719 sum:8721 minus:8722 lowast:8727 ' +
  'radic:8730 prop:8733 infin:8734 ang:8736 and:8743 or:8744 cap:8745 cup:8746 int:8747 there4:8756 sim:8764 cong:8773 asymp:8776 ne:8800 equiv:8801 ' +
  'le:8804 ge:8805 sub:8834 sup:8835 nsub:8836 sube:8838 supe:8839 oplus:8853 otimes:8855 perp:8869 sdot:8901 lceil:8968 rceil:8969 lfloor:8970 ' +
  'rfloor:8971 lang:10216 rang:10217 loz:9674 spades:9824 clubs:9827 hearts:9829 diams:9830 ' +
  'hyphen:8208 dash:8208 horbar:8213 bullet:8226 centerdot:183 star:9734 starf:9733 check:10003 cross:10007 cir:9675 squ:9633 square:9633 squf:9642 ' +
  'lowbar:95 verbar:124 vert:124 colon:58 comma:44 period:46 excl:33 quest:63 num:35 dollar:36 percnt:37 ast:42 plus:43 equals:61 lpar:40 rpar:41 ' +
  'lsqb:91 rsqb:93 lbrack:91 rbrack:93 lcub:123 rcub:125 lbrace:123 rbrace:125 sol:47 bsol:92 Hat:94 grave:96 nbhy:8209 NonBreakingSpace:160';

export const HTML_ENT = (() => {
  const m = Object.create(null);
  LAT1.split(' ').forEach((n, i) => { m[n] = String.fromCodePoint(160 + i); });
  for (const p of MORE.split(' ')) {
    const k = p.indexOf(':');
    m[p.slice(0, k)] = String.fromCodePoint(+p.slice(k + 1));
  }
  return m;
})();
