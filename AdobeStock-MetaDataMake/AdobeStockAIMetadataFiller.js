// ==UserScript==
// @name         Adobe Stock AI Metadata Filler (Groq)
// @namespace    https://contributor.stock.adobe.com/
// @version      1.15.0
// @description  選択中の画像をGroq Vision APIに送信し、英語タイトル・キーワードを自動生成してフォームに入力する
// @author       you
// @match        https://contributor.stock.adobe.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @connect      api.groq.com
// @connect      ftcdn.net
// @connect      *.ftcdn.net
// ==/UserScript==

(function () {
  'use strict';

  // ============================================================
  // 設定エリア：Adobeのページ構造が変わったらここだけ直せばOK
  // ============================================================
  const CONFIG = {
    // Groqで使うモデル（画像対応・JSONモード対応のもの）
    GROQ_MODEL: 'qwen/qwen3.8-27b',

    // 画像をGroqに送る前に、長辺がこのpx数になるようCanvasでリサイズする。
    // トークン消費（≒コスト・レート制限への当たりやすさ）と、認識精度のトレードオフ。
    // - 元々の実装は、Adobeの一覧表示用サムネイル（だいたい320x180）をそのまま送っていた。
    //   元に戻したい場合は 0 を指定するとリサイズをスキップし、元画像をそのまま使う。
    //   (以前値の参考: 320 = Adobeのサムネイルそのまま相当の粗さ)
    // - 768 は「トークンを抑えつつ、細部もある程度残す」バランスを狙った値。
    //   画質・認識精度を優先するなら 1024 などに上げてもよい。
    IMAGE_MAX_DIMENSION: 768,

    // ---- 以下、Adobe側のDOM要素を指すセレクタ（devtoolsで確認済み・2026/07時点） ----
    // 1) 現在パネルが開いている（選択中の）サムネイル
    SELECTED_THUMBNAIL_SELECTOR: '.upload-tile__wrapper.active img.upload-tile__thumbnail, [aria-selected="true"] img.upload-tile__thumbnail',

    // 2) 右側パネルのタイトル入力欄（classがビルドごとに変わる可能性があるため、
    //    name/aria-label/data-t属性で複数フォールバックを用意）
    TITLE_INPUT_SELECTOR:
      'textarea[name="title"], textarea[aria-label="コンテンツタイトル"], textarea[data-t="asset-title-content-tagger"], textarea.input--full-title-input',

    // 3) キーワード入力欄（カンマ区切りのテキストをまるごと貼り付けるタイプのtextarea）
    KEYWORD_INPUT_SELECTOR: 'textarea#content-keywords-ui-textarea',
  };

  // ============================================================
  // ユーティリティ
  // ============================================================

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Groqのエラーメッセージ内 "try again in 21m32.54s" のような表記を秒数に変換する
  // (TPM=1分あたりの上限では "18.1s" のように秒だけのことが多いが、
  //  TPD=1日あたりの上限では "21m32.54s" のように分が付くことがあるため、両方に対応する)
  function parseWaitSeconds(message) {
    const m = /try again in\s*((?:[\d.]+h)?(?:[\d.]+m)?(?:[\d.]+s)?)/i.exec(message);
    if (!m || !m[1]) return null;
    const dur = m[1];
    const h = /([\d.]+)h/.exec(dur);
    const min = /([\d.]+)m/.exec(dur);
    const s = /([\d.]+)s/.exec(dur);
    if (!h && !min && !s) return null;
    let total = 0;
    if (h) total += parseFloat(h[1]) * 3600;
    if (min) total += parseFloat(min[1]) * 60;
    if (s) total += parseFloat(s[1]);
    return total;
  }

  function formatDuration(totalSec) {
    const sec = Math.ceil(totalSec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const parts = [];
    if (h) parts.push(`${h}時間`);
    if (m) parts.push(`${m}分`);
    if (s || parts.length === 0) parts.push(`${s}秒`);
    return parts.join('');
  }

  function getGroqKey() {
    return GM_getValue('GROQ_API_KEY', 'gsk_XXXXXXXXXXXXXXXXXXXXX');
  }

  GM_registerMenuCommand('Groq APIキーを設定', () => {
    const current = getGroqKey();
    const key = prompt('Groq API Keyを入力してください', current || '');
    if (key !== null) {
      GM_setValue('GROQ_API_KEY', key.trim());
      alert('保存しました');
    }
  });

  // React/Vue管理下のinput/textareaでも値変更を検知させるためのセッター
  function setNativeValue(element, value) {
    const proto = element.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function simulateEnterKey(element) {
    ['keydown', 'keypress', 'keyup'].forEach((type) => {
      element.dispatchEvent(
        new KeyboardEvent(type, { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 })
      );
    });
  }

  function querySelectorVisible(selector) {
    const all = document.querySelectorAll(selector);
    for (const el of all) {
      if (el.offsetParent !== null) return el;
    }
    return all[0] || null;
  }

  function getSelectedThumbnailUrl() {
    const img = document.querySelector(CONFIG.SELECTED_THUMBNAIL_SELECTOR);
    if (!img) return null;
    // あえてsrcsetの高解像度版は使わず、表示中の小さいサムネイル(src)をそのまま使う。
    // 画像が大きいほどGroq側のトークン消費が増え、レート制限に当たりやすくなるため。
    return img.src;
  }

  // Canvasで画像の長辺をmaxDim以下にリサイズし、JPEGのdata URLとして返す。
  // 何らかの理由で失敗した場合は、リサイズを諦めて元のdata URLをそのまま返す(処理を止めないため)。
  function resizeImageDataUrl(dataUrl, maxDim) {
    return new Promise((resolve) => {
      if (!maxDim || maxDim <= 0) {
        resolve(dataUrl); // 0以下ならリサイズなし（元の実装と同じ挙動）
        return;
      }
      const img = new Image();
      img.onload = () => {
        try {
          const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
          const targetW = Math.max(1, Math.round(img.width * scale));
          const targetH = Math.max(1, Math.round(img.height * scale));
          console.log(
            `[AIメタデータ生成] 画像サイズ: 元 ${img.width}x${img.height} → 送信 ${targetW}x${targetH}` +
              (scale < 1 ? '（縮小しました）' : '（元のサイズのまま・拡大はしていません）')
          );
          const canvas = document.createElement('canvas');
          canvas.width = targetW;
          canvas.height = targetH;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, targetW, targetH);
          resolve(canvas.toDataURL('image/jpeg', 0.85));
        } catch (e) {
          resolve(dataUrl); // 描画やtoDataURLで失敗したら元画像にフォールバック
        }
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  function fetchImageAsBase64(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        responseType: 'blob',
        onload: (res) => {
          const reader = new FileReader();
          reader.onloadend = () => {
            // data:image/jpeg;base64,xxxx の形で返る
            resolve(reader.result);
          };
          reader.onerror = () => reject(new Error('画像データの読み込みに失敗しました'));
          reader.readAsDataURL(res.response);
        },
        onerror: (err) => {
          reject(new Error('画像の取得に失敗しました（@connectの許可ドメインを確認してください）: ' + JSON.stringify(err)));
        },
      });
    });
  }

  function callGroq(base64ImageDataUrl) {
    const apiKey = getGroqKey();
    if (!apiKey) {
      alert('先にGroq APIキーを設定してください（Tampermonkeyメニューから）');
      return Promise.reject(new Error('no api key'));
    }

    const CATEGORY_LIST = [
      '動物', '建物・建築', 'ビジネス', '飲み物', '環境', '感情と情緒', '食べ物', 'グラフィック素材',
      '趣味とレジャー', '産業', '風景', 'ライフスタイル', '人物', '植物・花', '宗教・文化', '科学',
      '社会問題', 'スポーツ', 'テクノロジー', '交通', '旅行',
    ];

    const systemPrompt = `あなたはAdobe Stockに投稿するAI生成画像のメタデータ作成を手伝うアシスタントです。
与えられた画像を見て、以下のJSONだけを出力してください（説明文やコードブロックの記号は不要）。

{
  "japanese_description": "画像の内容を日本語で1〜2文で説明（ユーザー確認用、投稿はしない）",
  "english_title": "Adobe Stock向けの英語タイトル。実在の人物やブランドを特定しない一般的な表現。1文（コンマやandでの軽い接続は可）。必ず120〜195文字の範囲に収めること（120文字未満は不可、200文字を超えるのは絶対不可）。被写体・服装・表情・構図・背景・雰囲気・光の質感・想定される用途（例: business, lifestyle, technology concept など）を具体的に描写し、詳しく書くことで文字数を満たすこと",
  "category_suggestions": ["カテゴリ名1", "カテゴリ名2"],
  "keywords": [
    {"en": "英語キーワード（単語または短いフレーズ）", "ja": "対応する日本語訳（確認用、投稿はしない）"}
  ]
}

category_suggestionsについての注意:
- 必ず次の一覧の中からこの通りの表記で1〜2個だけ選ぶこと（一覧にない名前を作らないこと）: ${CATEGORY_LIST.join('、')}
- 最も当てはまる順に並べること

keywordsについての注意:
- 関連度が高い順に並べること
- 必ず40個以上、できれば45〜49個出すこと（Adobe Stockの上限は49個）。同義語・関連シーン・雰囲気・被写体属性・構図・色・場所なども含めて数を稼ぐこと。40個未満は不可
- 49個を超えないこと

JSONの形式についての注意（重要）:
- 必ず有効なJSONのみを出力すること。前後に説明文やコードブロック(\`\`\`)を付けないこと
- 文字列の中でダブルクォート(")を使わないこと（英語タイトル・キーワード・日本語訳のいずれにも、"で囲んだ強調表現などは使わない）
- 配列やオブジェクトの末尾に余計なカンマ（トレイリングカンマ）を付けないこと`;

    const payload = {
      model: CONFIG.GROQ_MODEL,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'この画像のメタデータをJSONで生成してください。' },
            { type: 'image_url', image_url: { url: base64ImageDataUrl } },
          ],
        },
      ],
      temperature: 0.2,
      max_tokens: 4000,
    };

    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: 'https://api.groq.com/openai/v1/chat/completions',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        data: JSON.stringify(payload),
        onload: (res) => {
          try {
            const json = JSON.parse(res.responseText);
            if (json.error) {
              const err = new Error(json.error.message || 'Groq API error');
              err.code = json.error.code || json.error.type;
              reject(err);
              return;
            }
            const content = json.choices[0].message.content;
            const parsed = JSON.parse(content);
            resolve(parsed);
          } catch (e) {
            reject(new Error('Groqの応答解析に失敗しました: ' + e.message + ' / raw: ' + res.responseText.slice(0, 300)));
          }
        },
        onerror: (err) => {
          reject(new Error('Groq APIへの接続に失敗しました: ' + JSON.stringify(err)));
        },
      });
    });
  }

  // ============================================================
  // フォームへの反映
  // ============================================================

  // 200文字を超える場合、単語の途中で切らないよう「最後の単語の区切り」まで戻ってから切る
  function trimTitleSafely(title, maxLen) {
    if (title.length <= maxLen) return title;
    let cut = title.slice(0, maxLen);
    const lastSpace = cut.lastIndexOf(' ');
    if (lastSpace > maxLen * 0.6) {
      // 単語が短く切れすぎない位置に空白があれば、そこで切る
      cut = cut.slice(0, lastSpace);
    }
    // 末尾に中途半端な記号（カンマ・接続詞の残骸など）が残っていたら削る
    cut = cut.replace(/[,;:\-\s]+$/, '');
    return cut;
  }

  function fillTitle(title) {
    const el = querySelectorVisible(CONFIG.TITLE_INPUT_SELECTOR);
    if (!el) {
      alert('タイトル欄が見つかりませんでした。CONFIG.TITLE_INPUT_SELECTORを調整してください');
      return;
    }
    setNativeValue(el, title);
  }

  function fillKeywords(keywords) {
    const el = querySelectorVisible(CONFIG.KEYWORD_INPUT_SELECTOR);
    if (!el) {
      alert('キーワード欄が見つかりませんでした。CONFIG.KEYWORD_INPUT_SELECTORを調整してください');
      return;
    }
    // このtextareaは「カンマ区切りのテキストをペースト」する仕様なので、
    // 1語ずつEnterではなく、カンマ区切り文字列をまとめて流し込む
    const text = keywords.join(', ');
    setNativeValue(el, text);
    // Adobe側がpasteイベントを見ている可能性があるため、pasteイベントも念のため発火
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
    } catch (e) {
      // DataTransfer/ClipboardEventが使えない環境では無視（input/changeイベントで反映されるはず）
    }
  }

  // ============================================================
  // UIパネル
  // ============================================================

  function injectPanel() {
    const panel = document.createElement('div');
    panel.id = 'ai-meta-panel';
    panel.innerHTML = `
      <style>
        #ai-meta-panel {
          position: fixed; right: 16px; top: 16px; z-index: 999999;
          width: 440px; max-width: 92vw; max-height: 88vh;
          min-width: 280px; min-height: 220px;
          background: #fff; border: 1px solid #ccc; border-radius: 8px;
          box-shadow: 0 4px 16px rgba(0,0,0,.25); font-size: 14px; font-family: sans-serif;
          display: flex; flex-direction: column;
          resize: both; overflow: hidden;
        }
        #ai-meta-panel .hdr { background:#1473e6; color:#fff; padding:10px 14px; border-radius:8px 8px 0 0; display:flex; justify-content:space-between; align-items:center; gap:10px; cursor:grab; flex-shrink:0; touch-action:none; user-select:none; white-space:nowrap;}
        #ai-meta-panel .hdr:active { cursor:grabbing; }
        #ai-meta-panel .body { flex: 1 1 auto; min-height: 0; padding:14px; overflow-y:auto; }
        #ai-meta-panel button.main {
          width: 100%; padding: 12px; background:#1473e6; color:#fff; font-weight:bold; font-size:14px;
          border:none; border-radius:6px; cursor:pointer; margin: 8px 0; box-shadow: 0 2px 4px rgba(20,115,230,.35);
        }
        #ai-meta-panel button.main:hover { background:#0d5bb8; }
        #ai-meta-panel button.main:disabled { background:#aaa; box-shadow:none; }
        #ai-meta-panel button.action {
          width: 100%; padding: 7px; background:#1473e6; color:#fff; font-weight:normal; font-size:12.5px;
          border:none; border-radius:5px; cursor:pointer; margin: 6px 0; opacity:0.9;
        }
        #ai-meta-panel button.action:hover { opacity:1; }
        #ai-meta-panel .kw-list { max-height: 46vh; overflow-y: auto; border: 1px solid #eee; border-radius: 6px; padding: 6px; }
        #ai-meta-panel .kw { background:#eef3ff; padding:3px 8px; border-radius:10px; display:inline-block; margin:2px; cursor:pointer; user-select:none; border:1px solid #cddcf7; }
        #ai-meta-panel .kw .ja { color:#7a8bab; font-size:11px; }
        #ai-meta-panel .kw.inactive { background:#f2f2f2; color:#aaa; text-decoration:line-through; border-color:#ddd; }
        #ai-meta-panel .kw.inactive .ja { color:#bbb; }
        #ai-meta-panel .kw-hint { color:#888; font-size:11px; margin-top:4px; margin-bottom:6px; }
        #ai-meta-panel textarea { width:100%; box-sizing:border-box; font-size:14px; }
        #ai-meta-panel #ai-meta-title-count.over-limit { color:#c62828; font-weight:bold; }
        @media (max-width: 480px) {
          #ai-meta-panel { width: 92vw; font-size: 13px; top: 8px; right: 4vw; }
          #ai-meta-panel button.main { padding: 10px; font-size: 13px; }
        }
      </style>
      <div class="hdr">
        <span id="ai-meta-title-label">AIメタデータ生成 AdobeStock</span>
        <span id="ai-meta-toggle">—</span>
      </div>
      <div class="body">
        <button class="main" id="ai-meta-generate">選択中の画像から生成</button>
        <div id="ai-meta-result" style="display:none;">
          <div id="ai-meta-category" style="margin-bottom:8px; color:#333;"></div>
          <div><b>日本語（確認用）</b></div>
          <div id="ai-meta-ja" style="margin-bottom:8px; color:#444;"></div>
          <div><b>English Title</b> <span id="ai-meta-title-count" style="color:#888; font-weight:normal;"></span></div>
          <textarea id="ai-meta-title" rows="4" style="resize:vertical;"></textarea>
          <button class="action" id="ai-meta-fill-title">タイトルに反映</button>
          <div style="margin-top:6px;"><b>Keywords</b> <span id="ai-meta-kw-count" style="color:#888;"></span></div>
          <div class="kw-hint">クリックでON/OFF切り替え（グレー＝反映しない）</div>
          <div class="kw-list" id="ai-meta-keywords"></div>
          <button class="action" id="ai-meta-fill-keywords">キーワードに反映</button>
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    // 前回保存したサイズ・位置を復元（画面からはみ出さないようクランプ）
    try {
      const savedSize = JSON.parse(GM_getValue('AI_PANEL_SIZE', 'null'));
      if (savedSize && savedSize.width && savedSize.height) {
        panel.style.width = Math.min(savedSize.width, window.innerWidth * 0.95) + 'px';
        panel.style.height = Math.min(savedSize.height, window.innerHeight * 0.95) + 'px';
      }
      const savedPos = JSON.parse(GM_getValue('AI_PANEL_POS', 'null'));
      if (savedPos && typeof savedPos.left === 'number' && typeof savedPos.top === 'number') {
        const maxLeft = window.innerWidth - 60;
        const maxTop = window.innerHeight - 40;
        panel.style.left = Math.max(-panel.offsetWidth + 60, Math.min(savedPos.left, maxLeft)) + 'px';
        panel.style.top = Math.max(0, Math.min(savedPos.top, maxTop)) + 'px';
        panel.style.right = 'auto';
      }
    } catch (e) {
      // 保存データが壊れている場合は初期位置・サイズのまま
    }

    // サイズ変更（ドラッグ角リサイズ）を検知して保存
    let saveSizeTimer = null;
    const ro = new ResizeObserver(() => {
      if (collapsed) return; // 折りたたみ中のサイズ変化は保存しない
      clearTimeout(saveSizeTimer);
      saveSizeTimer = setTimeout(() => {
        const rect = panel.getBoundingClientRect();
        GM_setValue('AI_PANEL_SIZE', JSON.stringify({ width: rect.width, height: rect.height }));
      }, 300);
    });
    ro.observe(panel);

    let collapsed = false;
    const hdr = panel.querySelector('.hdr');

    // 長押しでドラッグ移動、短いタップで折りたたみ切り替え
    let dragTimer = null;
    let isDragging = false;
    let didDrag = false;
    let dragStart = { x: 0, y: 0, left: 0, top: 0 };

    hdr.addEventListener('pointerdown', (e) => {
      const rect = panel.getBoundingClientRect();
      dragStart = { x: e.clientX, y: e.clientY, left: rect.left, top: rect.top };
      didDrag = false;
      dragTimer = setTimeout(() => {
        isDragging = true;
        panel.style.left = rect.left + 'px';
        panel.style.top = rect.top + 'px';
        panel.style.right = 'auto';
      }, 350);
      hdr.setPointerCapture(e.pointerId);
    });

    hdr.addEventListener('pointermove', (e) => {
      if (!isDragging) return;
      didDrag = true;
      const dx = e.clientX - dragStart.x;
      const dy = e.clientY - dragStart.y;
      let newLeft = dragStart.left + dx;
      let newTop = dragStart.top + dy;
      // 画面外に出過ぎないよう軽く制限
      newLeft = Math.max(-panel.offsetWidth + 60, Math.min(newLeft, window.innerWidth - 60));
      newTop = Math.max(0, Math.min(newTop, window.innerHeight - 40));
      panel.style.left = newLeft + 'px';
      panel.style.top = newTop + 'px';
    });

    function endDrag(e) {
      clearTimeout(dragTimer);
      if (isDragging) {
        const rect = panel.getBoundingClientRect();
        GM_setValue('AI_PANEL_POS', JSON.stringify({ left: rect.left, top: rect.top }));
      }
      isDragging = false;
      try {
        hdr.releasePointerCapture(e.pointerId);
      } catch (err) {
        /* noop */
      }
    }
    hdr.addEventListener('pointerup', endDrag);
    hdr.addEventListener('pointercancel', endDrag);

    const FULL_LABEL = 'AIメタデータ生成 AdobeStock';
    const SHORT_LABEL = 'AIメタ';

    hdr.addEventListener('click', () => {
      if (didDrag) {
        didDrag = false;
        return;
      }
      collapsed = !collapsed;
      const body = panel.querySelector('.body');
      const label = panel.querySelector('#ai-meta-title-label');
      if (collapsed) {
        // 折りたたむ前のサイズを覚えておいて、パネル自体をアイコンサイズまで縮める
        const rect = panel.getBoundingClientRect();
        panel.dataset.expandedHeight = panel.style.height || `${Math.round(rect.height)}px`;
        panel.dataset.expandedWidth = panel.style.width || `${Math.round(rect.width)}px`;
        body.style.display = 'none';
        panel.style.minWidth = '0';
        panel.style.minHeight = '0';
        panel.style.width = 'auto';
        panel.style.height = 'auto';
        panel.style.resize = 'none'; // 最小化中はリサイズ無効
        label.textContent = SHORT_LABEL;
      } else {
        body.style.display = 'block';
        panel.style.minWidth = '';
        panel.style.minHeight = '';
        panel.style.width = panel.dataset.expandedWidth || '';
        panel.style.height = panel.dataset.expandedHeight || '';
        panel.style.resize = 'both';
        label.textContent = FULL_LABEL;
      }
      panel.querySelector('#ai-meta-toggle').textContent = collapsed ? '+' : '—';
    });

    let lastResult = null;

    panel.querySelector('#ai-meta-generate').addEventListener('click', async () => {
      const btn = panel.querySelector('#ai-meta-generate');
      btn.disabled = true;
      const idleLabel = '選択中の画像から生成';
      btn.textContent = '生成中...';
      try {
        const url = getSelectedThumbnailUrl();
        if (!url) throw new Error('選択中の画像が見つかりませんでした。CONFIG.SELECTED_THUMBNAIL_SELECTORを調整してください');
        const rawBase64 = await fetchImageAsBase64(url);
        const base64 = await resizeImageDataUrl(rawBase64, CONFIG.IMAGE_MAX_DIMENSION);

        let result = null;
        let rateLimitAttempt = 0;
        let jsonFailAttempt = 0;
        const MAX_RATE_LIMIT_RETRIES = 4;
        const MAX_JSON_FAIL_RETRIES = 6; // JSON生成失敗はほぼ即リトライできるので、レート制限とは別枠で多めに用意する
        const MAX_AUTO_WAIT_SEC = 90; // これを超える待機は自動リトライせず、ユーザーに知らせる
        while (result === null) {
          try {
            const r = await callGroq(base64);
            if (r.english_title && r.english_title.length > 200) {
              // APIを呼び直すとトークンを余計に消費してレート制限を悪化させるため、
              // 呼び直さずにその場で（単語の途中では切らず）自動的に短くする
              console.log(
                `[AIメタデータ生成] タイトルが200文字を超えていたため自動的に短くしました（${r.english_title.length}文字→200文字以内）`
              );
              r.english_title = trimTitleSafely(r.english_title, 200);
            }
            result = r;
          } catch (e) {
            const waitSec = parseWaitSeconds(e.message);
            const isRateLimit = /rate limit/i.test(e.message) || waitSec !== null;
            const isJsonFail = /Failed to (generate|validate) JSON|failed_generation|adjust your prompt/i.test(e.message);
            if (!(isRateLimit || isJsonFail)) {
              throw e;
            }
            if (isRateLimit && waitSec !== null && waitSec > MAX_AUTO_WAIT_SEC) {
              // 1日あたりの上限(TPD)など、長時間待つ必要がある場合は自動リトライせずすぐ知らせる
              throw e;
            }
            if (isRateLimit) {
              rateLimitAttempt++;
              if (rateLimitAttempt > MAX_RATE_LIMIT_RETRIES) throw e;
            } else {
              jsonFailAttempt++;
              if (jsonFailAttempt > MAX_JSON_FAIL_RETRIES) throw e;
            }
            const waitWhole = waitSec !== null ? Math.ceil(waitSec) + 1 : 2;
            for (let s = waitWhole; s > 0; s--) {
              btn.textContent = isRateLimit
                ? `トークン解放待ち / waiting for Groq quota… (${s}s)`
                : `再試行待機中 / retrying… (${s}s)`;
              await sleep(1000);
            }
          }
        }


        panel.querySelector('#ai-meta-result').style.display = 'block';
        const cats = (result.category_suggestions || []).filter(Boolean);
        panel.querySelector('#ai-meta-category').innerHTML = cats.length
          ? `<b>カテゴリ候補:</b> ${cats.join(' / ')}（プルダウンから手動で選択してください）`
          : '';
        panel.querySelector('#ai-meta-ja').textContent = result.japanese_description || '';
        panel.querySelector('#ai-meta-title').value = result.english_title || '';
        updateTitleCount();

        // keywordsを最大49件にトリムし、全てactive=trueで保持
        const kws = (result.keywords || []).slice(0, 49).map((k) => ({ en: k.en, ja: k.ja, active: true }));
        lastResult = { english_title: result.english_title, keywords: kws };
        renderKeywords();
      } catch (e) {
        const waitSec = parseWaitSeconds(e.message);
        if (waitSec !== null) {
          const waitLabel = formatDuration(waitSec);
          const isDaily = /tokens per day|\(TPD\)/i.test(e.message);
          const limitLabel = isDaily ? '1日あたりの' : '1分あたりの';
          alert(
            `Rate limit reached. Please wait about ${waitLabel} and try again.\n` +
              `Groq APIの${limitLabel}トークン上限に達しました。約${waitLabel}待ってから、もう一度お試しください。\n\n` +
              (isDaily
                ? `1日の上限に達しているため、今日中の自動リトライは行っていません。時間をおくか、Groqのプランをご確認ください（https://console.groq.com/settings/billing）。`
                : `連続生成する場合は、画像1枚ごとに少し間隔（15〜20秒程度）をあけると安定します。`)
          );
        } else {
          alert(`Error: ${e.message}\nエラー: ${e.message}`);
        }
      } finally {
        btn.disabled = false;
        btn.textContent = idleLabel;
      }
    });

    function renderKeywords() {
      const container = panel.querySelector('#ai-meta-keywords');
      container.innerHTML = lastResult.keywords
        .map(
          (k, i) =>
            `<span class="kw${k.active ? '' : ' inactive'}" data-idx="${i}">${k.en}${
              k.ja ? ` <span class="ja">(${k.ja})</span>` : ''
            }</span>`
        )
        .join(' ');
      const activeCount = lastResult.keywords.filter((k) => k.active).length;
      panel.querySelector('#ai-meta-kw-count').textContent = `(${activeCount}/${lastResult.keywords.length} 有効)`;

      container.querySelectorAll('.kw').forEach((chip) => {
        chip.addEventListener('click', () => {
          const idx = Number(chip.dataset.idx);
          lastResult.keywords[idx].active = !lastResult.keywords[idx].active;
          renderKeywords();
        });
      });
    }

    function updateTitleCount() {
      const len = panel.querySelector('#ai-meta-title').value.length;
      const countEl = panel.querySelector('#ai-meta-title-count');
      countEl.textContent = `(${len}/200文字)`;
      countEl.classList.toggle('over-limit', len > 200);
    }
    panel.querySelector('#ai-meta-title').addEventListener('input', updateTitleCount);

    panel.querySelector('#ai-meta-fill-title').addEventListener('click', () => {
      const titleEl = panel.querySelector('#ai-meta-title');
      let title = titleEl.value;
      if (!title) return;
      if (title.length > 200) {
        // 生成時点でほぼ200文字以内に収まっているはずだが、
        // ユーザーが手で編集して超えた場合などに備えた最終安全策（単語の途中では切らない）
        title = trimTitleSafely(title, 200);
        titleEl.value = title;
        updateTitleCount();
      }
      fillTitle(title);
    });

    panel.querySelector('#ai-meta-fill-keywords').addEventListener('click', () => {
      if (!lastResult || !lastResult.keywords) return;
      const activeEn = lastResult.keywords.filter((k) => k.active).map((k) => k.en);
      if (activeEn.length < 5) {
        alert(`有効なキーワードが${activeEn.length}個しかありません（Adobe側の最小は5個です）。ONにするキーワードを増やしてください。`);
        return;
      }
      fillKeywords(activeEn);
    });
  }

  window.addEventListener('load', () => {
    setTimeout(injectPanel, 1000);
  });
})();
