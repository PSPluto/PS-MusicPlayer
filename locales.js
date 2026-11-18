const locales = {
    ja: {
        "song-title-default": "曲を選択してください",
        "pin-title": "常に手前に表示",
        "volume-title": "音量",
        "playlist-expand": "プレイリストを展開",
        "playlist-hide": "プレイリストを隠す",
        "new-playlist-title": "新しい再生リスト",
        "new-playlist-btn-title": "新しい再生リストを作成",
        "dialog-placeholder": "名前を入力...",
        "dialog-cancel": "キャンセル",
        "dialog-create": "作成",
        "dialog-save": "保存",
        "dialog-delete": "削除",
        "dialog-create-add": "作成して追加",
        "name-in-use": "その名前は既に使用されています。",
        "delete-playlist-confirm": "プレイリスト「{name}」を削除しますか？",
        "remove-favorite": "お気に入りから削除",
        "add-favorite": "お気に入りに追加",
        "add-to-playlist": "プレイリストに追加",
        "create-new-playlist": "新しいプレイリストを作成...",
        "remove-from-playlist": "このプレイリストから削除",
        "open-file-location": "ファイルの場所を開く",
        "rename": "名前を変更...",
        "all-songs": "すべての曲",
        "favorites": "お気に入り",
        "no-songs": "曲がありません",
        "rename-playlist-title": "再生リストの名前を変更",
        "change-icon": "アイコンを変更",
        "change-icon-title": "リストのアイコンを変更",
        "change-icon-placeholder": "アイコンのパスを入力...",
        "search-placeholder": "検索 (曲名・アーティスト・アルバム)...",
        "btn-search-to-playlist-title": "検索結果からプレイリストを作成",
        "sort-by-track-number": "曲をトラックナンバー順に並べ替える",
        "equalizer-preset": "イコライザープリセット",
        "eq-flat": "フラット",
        "eq-bass-boost": "低音強調",
        "eq-treble-boost": "高音強調",
        "eq-vocal": "ボーカル",
        "eq-rock": "ロック",
        "eq-pop": "ポップ",
        "eq-radio": "ラジオ風",
        "eq-live-stage": "🎸 ライブステージ"
    },
    en: {
        "song-title-default": "Please select a song",
        "pin-title": "Always on top",
        "volume-title": "Volume",
        "playlist-expand": "Expand playlist",
        "playlist-hide": "Hide playlist",
        "new-playlist-title": "New Playlist",
        "new-playlist-btn-title": "Create new playlist",
        "dialog-placeholder": "Enter name...",
        "dialog-cancel": "Cancel",
        "dialog-create": "Create",
        "dialog-save": "Save",
        "dialog-delete": "Delete",
        "dialog-create-add": "Create and add",
        "name-in-use": "That name is already in use.",
        "delete-playlist-confirm": "Delete playlist \"{name}\"?",
        "remove-favorite": "Remove from favorites",
        "add-favorite": "Add to favorites",
        "add-to-playlist": "Add to playlist",
        "create-new-playlist": "Create new playlist...",
        "remove-from-playlist": "Remove from this playlist",
        "open-file-location": "Open file location",
        "rename": "Rename...",
        "all-songs": "All songs",
        "favorites": "Favorites",
        "no-songs": "No songs",
        "rename-playlist-title": "Rename Playlist",
        "change-icon": "Change icon",
        "change-icon-title": "Change playlist icon",
        "change-icon-placeholder": "Enter icon path...",
        "search-placeholder": "Search (title/artist/album)...",
        "btn-search-to-playlist-title": "Create playlist from search results",
        "sort-by-track-number": "Sort songs by track number",
        "equalizer-preset": "Equalizer Presets",
        "eq-flat": "Flat",
        "eq-bass-boost": "Bass Boost",
        "eq-treble-boost": "Treble Boost",
        "eq-vocal": "Vocal",
        "eq-rock": "Rock",
        "eq-pop": "Pop",
        "eq-radio": "Radio",
        "eq-live-stage": "🎸 Live Stage"
    }
};

let currentLang = localStorage.getItem('language') || (navigator.language.startsWith('ja') ? 'ja' : 'en');

function toggleLanguage() {
    setLanguage(currentLang === 'ja' ? 'en' : 'ja');
}

function setLanguage(lang) {
    if (locales[lang]) {
        currentLang = lang;
        localStorage.setItem('language', lang);
        applyTranslations();
    }
}

function t(key, replacements = {}) {
    let str = locales[currentLang][key] || key;
    for (const [k, v] of Object.entries(replacements)) {
        str = str.replace(`{${k}}`, v);
    }
    return str;
}

function applyTranslations() {
    const setElText = (id, key) => {
        const el = document.getElementById(id);
        if (el) el.textContent = t(key);
    };
    const setElTitle = (id, key) => {
        const el = document.getElementById(id);
        if (el) el.title = t(key);
    };
    const setElPlaceholder = (id, key) => {
        const el = document.getElementById(id);
        if (el) el.placeholder = t(key);
    };

    const songTitleEl = document.getElementById('song-title');
    const songTitleText = songTitleEl ? (songTitleEl.querySelector('.title-content')?.textContent || songTitleEl.textContent) : '';
    if (songTitleEl && (songTitleText === locales['ja']['song-title-default'] || songTitleText === locales['en']['song-title-default'])) {
        if (typeof setSongTitleText === 'function') {
            setSongTitleText(t('song-title-default'));
        } else {
            songTitleEl.textContent = t('song-title-default');
        }
    }
    
    setElTitle('btn-pin', 'pin-title');
    setElTitle('btn-volume', 'volume-title');
    
    const isExpanded = document.getElementById('playlist-container') && document.getElementById('playlist-container').classList.contains('expanded');
    setElText('text-expand', isExpanded ? 'playlist-hide' : 'playlist-expand');

    setElTitle('btn-add-playlist', 'new-playlist-btn-title');
    setElText('dialog-title', 'new-playlist-title');
    setElPlaceholder('dialog-input', 'dialog-placeholder');
    setElText('dialog-btn-cancel', 'dialog-cancel');
    setElPlaceholder('playlist-search-input', 'search-placeholder');
    setElTitle('btn-search-to-playlist', 'btn-search-to-playlist-title');
    
    const confirmBtn = document.getElementById('dialog-btn-confirm');
    if (confirmBtn) {
        if (confirmBtn.dataset.i18nKey) {
            confirmBtn.textContent = t(confirmBtn.dataset.i18nKey);
        } else if (confirmBtn.textContent === locales['ja']['dialog-create'] || confirmBtn.textContent === locales['en']['dialog-create']) {
            setElText('dialog-btn-confirm', 'dialog-create');
        }
    }

    const langText = document.getElementById('lang-text');
    if (langText) {
        langText.textContent = currentLang === 'ja' ? 'あ' : 'A';
    }
    
    if (typeof renderTabs === 'function') renderTabs();
    if (typeof renderPlaylist === 'function') renderPlaylist();
    if (typeof updateEqualizerButtonUI === 'function') updateEqualizerButtonUI();
}

document.addEventListener('DOMContentLoaded', () => {
    applyTranslations();
    const btnLang = document.getElementById('btn-lang');
    if (btnLang) {
        btnLang.onclick = toggleLanguage;
    }
});
