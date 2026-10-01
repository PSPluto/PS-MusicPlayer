const { ipcRenderer, shell } = require('electron');
const path = require('path');
const { ContextMenuManager, DialogManager } = require('./ui-managers');

let playlist = [];
let currentSongIndex = -1;
let isPlaying = false;
let isExpanded = false;
let shuffleMode = false;
let loopMode = 'off'; // 'off', 'one', 'all'
let currentLoadId = 0;
let abLoopState = { start: null, end: null, isOpen: false };
let songAbLoops = JSON.parse(localStorage.getItem('songAbLoops')) || {};

let allSongs = [];
let favorites = JSON.parse(localStorage.getItem('favorites')) || [];
let customPlaylists = JSON.parse(localStorage.getItem('customPlaylists')) || {};
let playlistIcons = JSON.parse(localStorage.getItem('playlistIcons')) || {};
let playlistSearchQueries = JSON.parse(localStorage.getItem('playlistSearchQueries')) || {};
let currentViewedPlaylistId = 'all'; // 'all', 'favorites', or custom playlist name
let currentPlayingSourceId = null;
let currentPlayingFilePath = '';
let metadataCache = JSON.parse(localStorage.getItem('metadataCache')) || {};
let currentSearchQuery = '';

// Sort state for "すべての曲" view
// 'none' = 追加順 (デフォルト), 'title', 'artist', 'filename'
const SORT_MODES = [
    { key: 'none',     label: '追加順' },
    { key: 'title',    label: '曲名順' },
    { key: 'artist',   label: 'アーティスト順' },
    { key: 'filename', label: 'ファイル名順' },
];
let currentSortMode = localStorage.getItem('sortMode') || 'none';

function normalizeSearchFilterQuery(rawQuery) {
    const query = String(rawQuery || '').trim().toLowerCase();
    if (!query) return '';
    if (query === '#ハイレゾ') return 'flac';
    return query.startsWith('.') ? query.slice(1) : query;
}

function doesSearchQueryMatchTag(tagText) {
    if (!currentSearchQuery || !tagText) return false;
    const query = normalizeSearchFilterQuery(currentSearchQuery);
    return query.length > 0 && normalizeSearchFilterQuery(tagText) === query;
}

const dialogManager = new DialogManager();

function showDialog(options) {
    dialogManager.show(options);
}

function hideDialog() {
    dialogManager.hide();
}

const contextMenuManager = new ContextMenuManager({
    ipcRenderer,
    getCurrentPlaylistId: () => currentViewedPlaylistId,
});
const contextMenu = document.getElementById('custom-context-menu');

function showContextMenu(triggerEl, items) {
    return contextMenuManager.show(triggerEl, items);
}

function hideContextMenu() {
    contextMenuManager.hide();
}

document.addEventListener('click', (e) => {
    if (e.target.closest('.context-menu')) return;
    if (e.target.closest('#playlist-ul li')) return;
    hideContextMenu();
});

window.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.context-menu') || e.target.closest('.playlist-tab')) {
        return;
    }
    if (e.target.closest('#playlist-ul li')) {
        return;
    }
    hideContextMenu();
});

// Playlist data management functions
function normalizeRendererPath(filePath) {
    const normalized = path.normalize(filePath);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function dedupeRendererPaths(paths) {
    const seen = new Set();
    const deduped = [];
    paths.forEach((file) => {
        const normalized = normalizeRendererPath(file);
        if (!seen.has(normalized)) {
            seen.add(normalized);
            deduped.push(file);
        }
    });
    return deduped;
}

function getPlaylistSongs(playlistId) {
    if (playlistId === 'all') {
        return dedupeRendererPaths(allSongs);
    }
    if (playlistId === 'favorites') {
        return dedupeRendererPaths(favorites.filter(file => allSongs.includes(file)));
    }
    const list = customPlaylists[playlistId] || [];
    return dedupeRendererPaths(list.filter(file => allSongs.includes(file)));
}

function getPlaylistIcon(playlistId) {
    if (playlistIcons[playlistId]) {
        return playlistIcons[playlistId];
    }
    if (playlistId === 'favorites') {
        return 'assets/Fav_Icon.svg';
    }
    if (playlistId !== 'all') {
        return 'assets/Playlist_albumIcon.svg';
    }
    return null;
}

function setPlaylistIcon(playlistId, iconPath) {
    if (!iconPath) {
        delete playlistIcons[playlistId];
    } else {
        playlistIcons[playlistId] = iconPath;
    }
    localStorage.setItem('playlistIcons', JSON.stringify(playlistIcons));
}

function toggleFavorite(filePath) {
    const index = favorites.indexOf(filePath);
    if (index > -1) {
        favorites.splice(index, 1);
    } else {
        favorites.push(filePath);
    }
    localStorage.setItem('favorites', JSON.stringify(favorites));
    if (currentPlayingSourceId === 'favorites') {
        syncCurrentPlayingPlaylistToSourceList('favorites');
    }
    if (currentViewedPlaylistId === 'favorites') {
        renderPlaylist();
    }
    updatePlaylistHighlight();
    updateMainFavoriteButton();
}

function addToCustomPlaylist(playlistName, filePath) {
    if (!customPlaylists[playlistName]) {
        customPlaylists[playlistName] = [];
    }
    if (!customPlaylists[playlistName].includes(filePath)) {
        customPlaylists[playlistName].push(filePath);
        localStorage.setItem('customPlaylists', JSON.stringify(customPlaylists));
        if (currentPlayingSourceId === playlistName) {
            syncCurrentPlayingPlaylistToSourceList(playlistName);
        }
        if (currentViewedPlaylistId === playlistName) {
            renderPlaylist();
        }
        updatePlaylistHighlight();
    }
}

function removeFromCustomPlaylist(playlistName, filePath) {
    if (customPlaylists[playlistName]) {
        const index = customPlaylists[playlistName].indexOf(filePath);
        if (index > -1) {
            customPlaylists[playlistName].splice(index, 1);
            localStorage.setItem('customPlaylists', JSON.stringify(customPlaylists));
            if (currentPlayingSourceId === playlistName) {
                syncCurrentPlayingPlaylistToSourceList(playlistName);
            }
            if (currentViewedPlaylistId === playlistName) {
                renderPlaylist();
            }
            updatePlaylistHighlight();
        }
    }
}

function renamePlaylist(oldName) {
    showDialog({
        title: t('rename-playlist-title'),
        initialValue: oldName,
        confirmText: t('dialog-save'),
        callback: (newName) => {
            if (!newName || newName === oldName) return;
            if (customPlaylists[newName] || newName === 'all' || newName === 'favorites') {
                alert(t('name-in-use'));
                return;
            }
            customPlaylists[newName] = customPlaylists[oldName];
            delete customPlaylists[oldName];
            localStorage.setItem('customPlaylists', JSON.stringify(customPlaylists));

            // 検索クエリも引き継ぐ
            if (playlistSearchQueries[oldName]) {
                playlistSearchQueries[newName] = playlistSearchQueries[oldName];
                delete playlistSearchQueries[oldName];
                localStorage.setItem('playlistSearchQueries', JSON.stringify(playlistSearchQueries));
            }

            if (currentViewedPlaylistId === oldName) {
                currentViewedPlaylistId = newName;
            }
            if (currentPlayingSourceId === oldName) {
                currentPlayingSourceId = newName;
            }
            renderTabs();
            renderPlaylist();
            updatePlaylistHighlight();
        }
    });
}

function deletePlaylist(name) {
    showDialog({
        title: t('delete-playlist-confirm', { name }),
        confirmText: t('dialog-delete'),
        hideInput: true,
        callback: () => {
            const wasPlayingSource = currentPlayingSourceId === name;
            delete customPlaylists[name];
            delete playlistIcons[name];
            delete playlistSearchQueries[name];
            localStorage.setItem('customPlaylists', JSON.stringify(customPlaylists));
            localStorage.setItem('playlistIcons', JSON.stringify(playlistIcons));
            localStorage.setItem('playlistSearchQueries', JSON.stringify(playlistSearchQueries));
            if (currentViewedPlaylistId === name) {
                currentViewedPlaylistId = 'all';
            }
            if (wasPlayingSource) {
                currentPlayingSourceId = null;
            }
            renderTabs();
            renderPlaylist();
            updatePlaylistHighlight();
        }
    });
}

function showSongContextMenu(e, file) {
    const isFav = favorites.includes(file);
    const items = [];

    items.push({
        label: t(isFav ? 'remove-favorite' : 'add-favorite'),
        icon: isFav ? 'assets/Fav_Icon.svg' : 'assets/Fav_Add.svg',
        action: () => toggleFavorite(file)
    });

    items.push({ type: 'separator' });

    const playlistTargetItems = [];
    const customNames = Object.keys(customPlaylists);
    customNames.forEach(name => {
        const inThisPlaylist = customPlaylists[name].includes(file);
        if (!inThisPlaylist) {
            playlistTargetItems.push({
                label: name,
                indent: true,
                action: () => addToCustomPlaylist(name, file)
            });
        }
    });

    playlistTargetItems.push({
        label: t('create-new-playlist'),
        indent: true,
        icon: 'assets/Playlist_Add.svg',
        action: () => {
            showDialog({
                title: t('new-playlist-title'),
                placeholder: t('dialog-placeholder'),
                confirmText: t('dialog-create-add'),
                callback: (name) => {
                    if (!name) return;
                    if (customPlaylists[name] || name === 'all' || name === 'favorites') {
                        alert(t('name-in-use'));
                        return;
                    }
                    customPlaylists[name] = [file];
                    localStorage.setItem('customPlaylists', JSON.stringify(customPlaylists));
                    currentViewedPlaylistId = name;
                    renderTabs();
                    renderPlaylist();
                    updatePlaylistHighlight();
                }
            });
        }
    });

    items.push({
        type: 'submenu',
        expanded: true,
        label: t('add-to-playlist'),
        icon: 'assets/Playlist_Add.svg',
        children: playlistTargetItems
    });

    if (currentViewedPlaylistId !== 'all') {
        items.push({ type: 'separator' });
        items.push({
            label: t(currentViewedPlaylistId === 'favorites' ? 'remove-favorite' : 'remove-from-playlist'),
            icon: currentViewedPlaylistId === 'favorites' ? 'assets/Fav_Icon.svg' : 'assets/Playlist_albumIcon.svg',
            action: () => {
                if (currentViewedPlaylistId === 'favorites') {
                    toggleFavorite(file);
                } else {
                    removeFromCustomPlaylist(currentViewedPlaylistId, file);
                }
            }
        });
    }

    items.push({ type: 'separator' });
    items.push({
        label: t('open-file-location'),
        icon: 'assets/Open_Folder.svg',
        action: () => shell.showItemInFolder(file)
    });

    // Pass the li element itself as the trigger for positioning
    const triggerEl = e.currentTarget || e.target.closest('li');
    if (contextMenu) {
        contextMenu.dataset.file = file;
    }
    showContextMenu(triggerEl, items);
}

function showPlaylistTabContextMenu(e, name) {
    const items = [
        {
            label: t('change-icon'),
            action: async () => {
                const iconPath = await ipcRenderer.invoke('select-icon-file');
                if (!iconPath) return;
                setPlaylistIcon(name, iconPath);
                renderTabs();
            }
        },
        {
            label: t('rename'),
            action: () => renamePlaylist(name)
        },
        {
            label: t('dialog-delete'),
            action: () => deletePlaylist(name)
        }
    ];

    // 検索クエリの有無に応じて「クエリを管理...」または「クエリを追加...」を表示
    const hasQuery = Boolean(playlistSearchQueries[name]);
    items.splice(2, 0, { type: 'separator' });
    items.splice(3, 0, {
        label: hasQuery ? 'クエリを管理...' : 'クエリを追加...',
        icon: 'assets/refresh_24dp_FFFFFF_FILL1_wght400_GRAD0_opsz24.svg',
        action: () => managePlaylistQuery(name)
    });

    const triggerEl = e.currentTarget || e.target.closest('.playlist-tab');
    showContextMenu(triggerEl, items);
}

function managePlaylistQuery(playlistName) {
    const currentQuery = playlistSearchQueries[playlistName] || '';
    showDialog({
        title: `「${playlistName}」の検索クエリ`,
        placeholder: '検索クエリを入力...',
        initialValue: currentQuery,
        confirmText: '保存',
        callback: (newQuery) => {
            const trimmed = newQuery.trim();
            if (trimmed === currentQuery) return; // 変更なし

            if (!trimmed) {
                // 空にした場合 → クエリを削除して普通のプレイリストに変換
                delete playlistSearchQueries[playlistName];
                localStorage.setItem('playlistSearchQueries', JSON.stringify(playlistSearchQueries));
            } else {
                // 新しいクエリで更新
                playlistSearchQueries[playlistName] = trimmed;
                localStorage.setItem('playlistSearchQueries', JSON.stringify(playlistSearchQueries));
            }
            renderTabs();
        }
    });
}

function renderTabs() {
    const tabsContainer = document.getElementById('playlist-tabs');
    if (!tabsContainer) return;
    tabsContainer.innerHTML = '';

    tabsContainer.appendChild(createTabEl('all', t('all-songs'), getPlaylistIcon('all')));
    tabsContainer.appendChild(createTabEl('favorites', t('favorites'), getPlaylistIcon('favorites')));

    Object.keys(customPlaylists).forEach(name => {
        const tab = createTabEl(name, name, getPlaylistIcon(name));
        tab.oncontextmenu = (e) => {
            e.preventDefault();
            e.stopPropagation();
            showPlaylistTabContextMenu(e, name);
        };
        tabsContainer.appendChild(tab);
    });

    // Auto scroll active tab into view if needed
    const activeTabEl = tabsContainer.querySelector('.playlist-tab.active');
    if (activeTabEl) {
        activeTabEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    }

    // ソートボタンは「すべての曲」のみ表示
    updateSortButtonVisibility();
}

function updateSortButtonVisibility() {
    const btnSort = document.getElementById('btn-sort');
    if (!btnSort) return;
    const isAll = currentViewedPlaylistId === 'all';
    btnSort.style.display = isAll ? 'flex' : 'none';

    // 並べ替えボタンのtooltipに現状のソート条件を追加表示
    const currentModeObj = SORT_MODES.find(m => m.key === currentSortMode);
    const modeLabel = currentModeObj ? currentModeObj.label : '追加順';
    btnSort.title = `並べ替え (${modeLabel})`;
}

function playPlaylistById(id) {
    currentViewedPlaylistId = id;
    renderTabs();
    renderPlaylist();
    updatePlaylistHighlight();

    const songs = getPlaylistSongs(id);
    if (songs.length > 0) {
        playlist = [...songs];
        currentPlayingSourceId = id;
        currentSongIndex = 0;
        loadSong(0, true);
    }
}

function createTabEl(id, label, iconSrc) {
    const span = document.createElement('span');
    span.className = 'playlist-tab';
    if (id === currentViewedPlaylistId) {
        span.classList.add('active');
    }
    if (iconSrc) {
        const img = document.createElement('img');
        let iconSrcValue = iconSrc;
        if (!iconSrcValue.startsWith('assets/') && !iconSrcValue.startsWith('file://') && (iconSrcValue.includes('\\') || iconSrcValue.includes('/'))) {
            const normalized = iconSrcValue.replace(/\\/g, '/');
            if (/^[A-Za-z]:\//.test(normalized)) {
                iconSrcValue = `file:///${normalized}`;
            } else if (normalized.startsWith('/')) {
                iconSrcValue = `file://${normalized}`;
            }
        }
        img.src = iconSrcValue;
        img.className = 'tab-icon';
        span.appendChild(img);
    }
    span.appendChild(document.createTextNode(label));
    span.onclick = (e) => {
        // 更新ボタンがクリックされた場合は tab 切り替えをしない
        if (e.target.closest('.tab-refresh-btn')) return;
        currentViewedPlaylistId = id;
        renderTabs();
        renderPlaylist();
        updatePlaylistHighlight();
    };
    span.ondblclick = (e) => {
        if (e.target.closest('.tab-refresh-btn')) return;
        playPlaylistById(id);
    };

    // 検索クエリ由来のプレイリストには更新ボタンを追加
    if (playlistSearchQueries[id]) {
        const refreshBtn = document.createElement('button');
        refreshBtn.className = 'tab-refresh-btn';
        refreshBtn.title = `「${playlistSearchQueries[id]}」で再検索して新しい曲を追加`;
        refreshBtn.innerHTML = `<img src="assets/refresh_24dp_FFFFFF_FILL1_wght400_GRAD0_opsz24.svg" alt="Refresh">`;
        refreshBtn.onclick = (e) => {
            e.stopPropagation();
            refreshSearchPlaylist(id);
        };
        span.appendChild(refreshBtn);
    }

    return span;
}

// Initialize Add Playlist button
const btnAddPlaylist = document.getElementById('btn-add-playlist');
if (btnAddPlaylist) {
    btnAddPlaylist.onclick = () => {
        showDialog({
            title: t('new-playlist-title'),
            placeholder: t('dialog-placeholder'),
            confirmText: t('dialog-create'),
            callback: (name) => {
                if (!name) return;
                if (customPlaylists[name] || name === 'all' || name === 'favorites') {
                    alert(t('name-in-use'));
                    return;
                }
                customPlaylists[name] = [];
                localStorage.setItem('customPlaylists', JSON.stringify(customPlaylists));
                currentViewedPlaylistId = name;
                renderTabs();
                renderPlaylist();
                updatePlaylistHighlight();
            }
        });
    };
}

// Initialize Sort button — uses an inline dropdown (not showContextMenu)
const btnSort = document.getElementById('btn-sort');

function showSortDropdown() {
    // Remove existing dropdown if any
    const existing = document.getElementById('sort-dropdown');
    if (existing) { existing.remove(); return; }

    const dropdown = document.createElement('div');
    dropdown.id = 'sort-dropdown';
    dropdown.className = 'sort-dropdown';

    SORT_MODES.forEach(({ key, label }) => {
        const item = document.createElement('div');
        const isActive = currentSortMode === key;
        item.className = 'sort-dropdown-item' + (isActive ? ' active' : '');

        const checkSpan = document.createElement('span');
        checkSpan.textContent = isActive ? '✓' : '';
        checkSpan.style.width = '16px';
        checkSpan.style.display = 'inline-block';
        checkSpan.style.textAlign = 'center';
        checkSpan.style.flexShrink = '0';
        checkSpan.style.color = '#ffffff';

        const labelSpan = document.createElement('span');
        labelSpan.textContent = label;
        labelSpan.style.color = '#ffffff';

        item.appendChild(checkSpan);
        item.appendChild(labelSpan);

        item.onclick = (e) => {
            e.stopPropagation();
            currentSortMode = key;
            localStorage.setItem('sortMode', key);
            updateSortButtonVisibility();

            // 「すべての曲」再生中なら、再生キュー順序と現在再生位置を更新
            if (currentPlayingSourceId === 'all' && playlist.length > 0) {
                const currentFile = playlist[currentSongIndex];
                const sorted = applySortToSongs(allSongs);
                playlist = [...sorted];
                if (currentFile) {
                    const newIndex = playlist.indexOf(currentFile);
                    if (newIndex !== -1) currentSongIndex = newIndex;
                }
            }

            renderPlaylist();
            updatePlaylistHighlight();
            dropdown.remove();
        };
        dropdown.appendChild(item);
    });

    // Position: below the sort button
    const rect = btnSort.getBoundingClientRect();
    dropdown.style.top = (rect.bottom + 4) + 'px';
    dropdown.style.left = (rect.left - dropdown.offsetWidth + rect.width) + 'px';
    document.body.appendChild(dropdown);
    // Adjust left after appended so offsetWidth is known
    requestAnimationFrame(() => {
        dropdown.style.left = (rect.right - dropdown.offsetWidth) + 'px';
    });

    // Close on outside click
    const closeOnOutside = (e) => {
        if (!dropdown.contains(e.target) && e.target !== btnSort) {
            dropdown.remove();
        }
        document.removeEventListener('click', closeOnOutside, true);
    };
    setTimeout(() => document.addEventListener('click', closeOnOutside, true), 0);
}

if (btnSort) {
    btnSort.onclick = (e) => {
        e.stopPropagation();
        showSortDropdown();
    };
}

const audio = document.getElementById('audio-player');
const titleEl = document.getElementById('song-title');
const artistEl = document.getElementById('song-artist');
const mainFavoriteBtn = document.getElementById('main-favorite-btn');
const mainFavoriteImg = document.getElementById('main-favorite-img');
const playBtn = document.getElementById('play-btn');
const playImg = document.getElementById('img-play');
const seekBar = document.getElementById('seek-bar');
const coverImg = document.getElementById('cover-img');
const coverPlaceholder = document.getElementById('cover-placeholder');
const playlistUl = document.getElementById('playlist-ul');
const btnExpand = document.getElementById('btn-expand');
const textExpand = document.getElementById('text-expand');
const imgExpand = document.getElementById('img-expand');
const playlistContainer = document.getElementById('playlist-container');
const playlistTabsWrapper = document.querySelector('.playlist-tabs-wrapper');

function updateMainFavoriteButton() {
    if (!mainFavoriteBtn || !mainFavoriteImg) return;
    if (!currentPlayingFilePath) {
        mainFavoriteBtn.style.display = 'none';
        return;
    }
    mainFavoriteBtn.style.display = 'inline-flex';
    const isFav = favorites.includes(currentPlayingFilePath);
    if (isFav) {
        mainFavoriteImg.src = 'assets/Fav_Icon.svg';
        mainFavoriteBtn.title = 'お気に入りから削除';
        mainFavoriteBtn.classList.add('active');
    } else {
        mainFavoriteImg.src = 'assets/Fav_Add.svg';
        mainFavoriteBtn.title = 'お気に入りに追加';
        mainFavoriteBtn.classList.remove('active');
    }
}

const progressContainer = document.getElementById('progress-container');
const abLoopPanel = document.getElementById('ab-loop-panel');
const abLoopStartInput = document.getElementById('ab-loop-start');
const abLoopEndInput = document.getElementById('ab-loop-end');
const abLoopClearBtn = document.getElementById('ab-loop-clear');

function formatSecondsToMSS(sec) {
    if (isNaN(sec) || sec < 0) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
}

function parseMSSToSeconds(str) {
    if (!str || typeof str !== 'string') return null;
    const parts = str.trim().split(':');
    if (parts.length === 1) {
        const val = parseFloat(parts[0]);
        return isNaN(val) ? null : Math.max(0, val);
    } else if (parts.length === 2) {
        const m = parseInt(parts[0], 10);
        const s = parseFloat(parts[1]);
        if (isNaN(m) || isNaN(s)) return null;
        return Math.max(0, m * 60 + s);
    }
    return null;
}

function saveSongAbLoop() {
    if (!currentPlayingFilePath) return;
    if (abLoopState.start !== null && abLoopState.end !== null) {
        songAbLoops[currentPlayingFilePath] = {
            start: abLoopState.start,
            end: abLoopState.end
        };
    } else {
        delete songAbLoops[currentPlayingFilePath];
    }
    localStorage.setItem('songAbLoops', JSON.stringify(songAbLoops));
}

function loadSongAbLoopForCurrentFile() {
    if (currentPlayingFilePath && songAbLoops[currentPlayingFilePath]) {
        const saved = songAbLoops[currentPlayingFilePath];
        abLoopState.start = (typeof saved.start === 'number') ? saved.start : null;
        abLoopState.end = (typeof saved.end === 'number') ? saved.end : null;
    } else {
        abLoopState.start = null;
        abLoopState.end = null;
    }
    updateAbLoopInputsFromState();
}

function toggleAbLoopPanel(force) {
    if (!progressContainer) return;
    const shouldOpen = (typeof force === 'boolean') ? force : !progressContainer.classList.contains('ab-open');
    abLoopState.isOpen = shouldOpen;
    progressContainer.classList.toggle('ab-open', shouldOpen);

    if (shouldOpen) {
        if (abLoopState.start === null && audio && audio.duration) {
            abLoopState.start = 0;
            if (abLoopStartInput) abLoopStartInput.value = '0:00';
        }
        if (abLoopState.end === null && audio && audio.duration) {
            abLoopState.end = audio.duration;
            if (abLoopEndInput) abLoopEndInput.value = formatSecondsToMSS(audio.duration);
        }
        saveSongAbLoop();
    }
}

function updateAbLoopInputsFromState() {
    if (abLoopStartInput) {
        abLoopStartInput.value = abLoopState.start !== null ? formatSecondsToMSS(abLoopState.start) : '';
    }
    if (abLoopEndInput) {
        abLoopEndInput.value = abLoopState.end !== null ? formatSecondsToMSS(abLoopState.end) : '';
    }
}

if (seekBar) {
    seekBar.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleAbLoopPanel();
    });
}

if (abLoopStartInput) {
    abLoopStartInput.onchange = () => {
        const val = parseMSSToSeconds(abLoopStartInput.value);
        if (val !== null) {
            const maxDuration = (audio && audio.duration) ? audio.duration : 999999;
            abLoopState.start = Math.min(val, maxDuration);
            if (abLoopState.end !== null && abLoopState.start >= abLoopState.end) {
                abLoopState.start = Math.max(0, abLoopState.end - 1);
            }
            abLoopStartInput.value = formatSecondsToMSS(abLoopState.start);
        } else {
            abLoopState.start = 0;
            abLoopStartInput.value = '0:00';
        }
        saveSongAbLoop();
    };
    abLoopStartInput.onkeydown = (e) => {
        if (e.key === 'Enter') abLoopStartInput.blur();
    };
}

if (abLoopEndInput) {
    abLoopEndInput.onchange = () => {
        const val = parseMSSToSeconds(abLoopEndInput.value);
        const maxDuration = (audio && audio.duration) ? audio.duration : 999999;
        if (val !== null) {
            abLoopState.end = Math.min(val, maxDuration);
            if (abLoopState.start !== null && abLoopState.end <= abLoopState.start) {
                abLoopState.end = Math.min(maxDuration, abLoopState.start + 1);
            }
            abLoopEndInput.value = formatSecondsToMSS(abLoopState.end);
        } else {
            abLoopState.end = maxDuration;
            abLoopEndInput.value = formatSecondsToMSS(maxDuration);
        }
        saveSongAbLoop();
    };
    abLoopEndInput.onkeydown = (e) => {
        if (e.key === 'Enter') abLoopEndInput.blur();
    };
}

if (abLoopClearBtn) {
    abLoopClearBtn.onclick = (e) => {
        e.stopPropagation();
        abLoopState.start = null;
        abLoopState.end = null;
        saveSongAbLoop();
        updateAbLoopInputsFromState();
        toggleAbLoopPanel(false);
    };
}


function sanitizeTitleForMainIsland(text) {
    if (text == null) return '';

    let sanitized = String(text).trim();
    sanitized = sanitized.replace(/\s*\([^)]*\)/g, '');
    sanitized = sanitized.replace(/\s*\[[^\]]*\]/g, '');
    sanitized = sanitized.replace(/\s*(?:--|—|–)\s*.+$/g, '');
    sanitized = sanitized.replace(/\s*-\s*.+$/g, '');

    return sanitized.trim() || String(text).trim();
}

function formatPlaylistTitleParts(text) {
    const raw = String(text || '').trim();
    if (!raw) {
        return { titleText: '', tagParts: [] };
    }

    let remaining = raw;
    const tagParts = [];

    remaining = remaining.replace(/\s*\(([^)]*)\)/g, (_, inner) => {
        const part = inner.trim();
        if (part) tagParts.push(part);
        return '';
    });

    const dashTagMatch = remaining.match(/.*(?:--|—|–|-)\s*([^-–—][\s\S]*?[^-–—])\s*$/u);
    if (dashTagMatch) {
        const content = dashTagMatch[1].trim();
        if (content) {
            tagParts.push(content);
            remaining = remaining.slice(0, remaining.lastIndexOf(dashTagMatch[1]) - 1).trim();
        }
    }

    const titleText = remaining.trim() || raw;
    return { titleText, tagParts };
}

function populatePlaylistItemTitle(li, rawTitle) {
    const { titleText, tagParts } = formatPlaylistTitleParts(rawTitle);
    li.innerHTML = '';

    const titleSpan = document.createElement('span');
    titleSpan.className = 'playlist-item-title';
    titleSpan.textContent = titleText;
    li.appendChild(titleSpan);

    tagParts.forEach((tagPart) => {
        const tagSpan = document.createElement('span');
        tagSpan.className = 'playlist-item-tag';
        tagSpan.textContent = tagPart;
        if (doesSearchQueryMatchTag(tagPart)) {
            tagSpan.classList.add('matched');
        }
        tagSpan.onclick = (event) => {
            event.stopPropagation();
            searchByTag(tagPart);
        };
        li.appendChild(tagSpan);
    });
}

function setSongTitleText(text) {
    if (!titleEl) return;

    const safeText = sanitizeTitleForMainIsland(text);
    const track = titleEl.querySelector('.title-track');

    if (!track) {
        const newTrack = document.createElement('div');
        newTrack.className = 'title-track';
        titleEl.appendChild(newTrack);
    }

    const currentTrack = titleEl.querySelector('.title-track');
    const currentContent = currentTrack.querySelector('.title-content');

    if (!currentContent) {
        const firstContent = document.createElement('span');
        firstContent.className = 'title-content';
        firstContent.textContent = safeText;
        currentTrack.appendChild(firstContent);
    } else {
        currentContent.textContent = safeText;
    }

    currentTrack.querySelectorAll('.title-content').forEach((content, index) => {
        if (index > 0) {
            content.remove();
        }
    });

    requestAnimationFrame(updateSongTitleScroll);
}

function updateSongTitleScroll() {
    if (!titleEl) return;

    const track = titleEl.querySelector('.title-track');
    const content = track?.querySelector('.title-content');
    if (!track || !content) return;

    const viewportWidth = titleEl.clientWidth;
    const contentWidth = content.scrollWidth;
    const isOverflowing = contentWidth > viewportWidth;

    track.classList.toggle('scrollable', isOverflowing);

    if (isOverflowing) {
        const clone = track.querySelector('.title-content-clone');
        const text = content.textContent || '';

        if (!clone) {
            const cloneContent = document.createElement('span');
            cloneContent.className = 'title-content title-content-clone';
            cloneContent.setAttribute('aria-hidden', 'true');
            cloneContent.textContent = text;
            track.appendChild(cloneContent);
        } else {
            clone.textContent = text;
        }

        const duration = Math.max(6, contentWidth / 25);
        track.style.setProperty('--title-duration', `${duration}s`);
    } else {
        track.querySelectorAll('.title-content-clone').forEach((clone) => clone.remove());
        track.style.removeProperty('--title-duration');
        track.style.transform = 'translateX(0)';
    }
}

window.addEventListener('resize', updateSongTitleScroll);
requestAnimationFrame(updateSongTitleScroll);

const shuffleBtn = document.getElementById('shuffle-btn');
const shuffleImg = document.getElementById('img-shuffle');
const loopBtn = document.getElementById('loop-btn');
const loopImg = document.getElementById('img-loop');

const volumeBar = document.getElementById('volume-bar');

const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
const audioSource = audioCtx.createMediaElementSource(audio);
const analyser = audioCtx.createAnalyser();
const visualizerData = new Uint8Array(analyser.frequencyBinCount);

analyser.fftSize = 256;
audioSource.connect(analyser);
analyser.connect(audioCtx.destination);

audio.onplay = () => {
    isPlaying = true;
    playImg.src = 'assets/pause_circle_24dp_E3E3E3_FILL1_wght400_GRAD0_opsz24.svg';
    ipcRenderer.send('playback-change', true);
    if (audioCtx.state === 'suspended') {
        audioCtx.resume().catch(e => console.error('AudioContext resume failed', e));
    }
};

audio.onpause = () => {
    isPlaying = false;
    playImg.src = 'assets/play_circle_24dp_E3E3E3_FILL1_wght400_GRAD0_opsz24.svg';
    ipcRenderer.send('playback-change', false);
};

function sendVisualizerData() {
    analyser.getByteFrequencyData(visualizerData);
    ipcRenderer.send('visualizer-data', Array.from(visualizerData));
}

function sendVisualizerColor(color) {
    ipcRenderer.send('visualizer-color', color);
}

setInterval(sendVisualizerData, 1000 / 30);

if (playlistTabsWrapper) {
    let scrollVelocity = 0;
    let isAnimatingScroll = false;

    const scrollFriction = 0.92;
    const scrollMultiplier = 0.45; // reduced per-tick sensitivity
    const MAX_SCROLL_VELOCITY = 10; // clamp to avoid huge jumps

    function animatePlaylistScroll() {
        if (!isAnimatingScroll) return;
        if (Math.abs(scrollVelocity) < 0.25) {
            scrollVelocity = 0;
            isAnimatingScroll = false;
            return;
        }

        playlistTabsWrapper.scrollLeft += scrollVelocity;
        scrollVelocity *= scrollFriction;
        requestAnimationFrame(animatePlaylistScroll);
    }

    playlistTabsWrapper.addEventListener('wheel', (event) => {
        if (event.deltaY === 0) return;
        event.preventDefault();
        scrollVelocity += event.deltaY * scrollMultiplier;
        // clamp velocity to avoid huge jumps
        if (scrollVelocity > MAX_SCROLL_VELOCITY) scrollVelocity = MAX_SCROLL_VELOCITY;
        if (scrollVelocity < -MAX_SCROLL_VELOCITY) scrollVelocity = -MAX_SCROLL_VELOCITY;
        if (!isAnimatingScroll) {
            isAnimatingScroll = true;
            requestAnimationFrame(animatePlaylistScroll);
        }
    }, { passive: false });
}

// Simplified refresh for Inverted Drag Strategy. Use a minor toggle to app element.
function refreshDragHandle() {
    const el = document.getElementById('app');
    if (el) {
        el.style.webkitAppRegion = 'no-drag';
        el.offsetHeight; // force reflow
        el.style.webkitAppRegion = 'drag';
    }
}

async function cacheAllMetadata() {
    const batchSize = 15;
    let updated = false;
    for (let i = 0; i < allSongs.length; i += batchSize) {
        const batch = allSongs.slice(i, i + batchSize);
        await Promise.all(batch.map(async (file) => {
            if (!metadataCache[file]) {
                try {
                    const meta = await ipcRenderer.invoke('get-metadata', file);
                    metadataCache[file] = {
                        title: meta.title,
                        artist: meta.artist,
                        album: meta.album
                    };
                    updated = true;
                } catch (e) {
                    console.error('Failed to cache metadata for', file, e);
                }
            }
        }));
        if (updated) {
            localStorage.setItem('metadataCache', JSON.stringify(metadataCache));
            updated = false;
            // 検索中またはソート有効時にメタデータ更新があれば再描画
            if (currentSearchQuery || currentSortMode !== 'none') {
                renderPlaylist();
            }
        }
    }
}

async function loadMusic() {
    allSongs = await ipcRenderer.invoke('get-music-files');
    allSongs = dedupeRendererPaths(allSongs);
    const initialSongs = (currentSortMode !== 'none') ? applySortToSongs(allSongs) : [...allSongs];
    playlist = [...initialSongs];
    cacheAllMetadata();
    renderTabs();
    renderPlaylist();
    if (playlist.length > 0) {
        currentSongIndex = 0;
        loadSong(currentSongIndex, false);
    }
}

function applySortToSongs(songs) {
    if (currentViewedPlaylistId !== 'all' || currentSortMode === 'none') {
        return [...songs];
    }
    return [...songs].sort((a, b) => {
        let va = '', vb = '';
        const ma = metadataCache[a], mb = metadataCache[b];
        const fileA = a.split(/[\\/]/).pop() || '';
        const fileB = b.split(/[\\/]/).pop() || '';

        if (currentSortMode === 'title') {
            va = (ma && ma.title) ? ma.title : fileA;
            vb = (mb && mb.title) ? mb.title : fileB;
        } else if (currentSortMode === 'artist') {
            va = (ma && ma.artist) ? ma.artist : '';
            vb = (mb && mb.artist) ? mb.artist : '';
            // アーティスト名が同じ、または未設定の場合は曲名でソート
            if (va === vb) {
                va = (ma && ma.title) ? ma.title : fileA;
                vb = (mb && mb.title) ? mb.title : fileB;
            }
        } else if (currentSortMode === 'filename') {
            va = fileA;
            vb = fileB;
        }

        const cmp = va.localeCompare(vb, 'ja', { numeric: true, sensitivity: 'base' });
        if (cmp !== 0) return cmp;
        return a.localeCompare(b, 'ja', { numeric: true });
    });
}

function renderPlaylist() {
    playlistUl.innerHTML = '';
    const rawSongs = getPlaylistSongs(currentViewedPlaylistId);
    const songsToRender = applySortToSongs(rawSongs);

    const filteredSongs = songsToRender.filter(file => {
        if (!currentSearchQuery) return true;
        const meta = metadataCache[file];
        const title = (meta && meta.title) ? meta.title : file.split(/[\\/]/).pop();
        const artist = (meta && meta.artist) ? meta.artist : '';
        const album = (meta && meta.album) ? meta.album : '';
        const fileName = file.split(/[\\/]/).pop();
        const fileNameLower = fileName.toLowerCase();
        const extension = fileNameLower.includes('.') ? fileNameLower.slice(fileNameLower.lastIndexOf('.') + 1) : '';
        const query = normalizeSearchFilterQuery(currentSearchQuery);
        return title.toLowerCase().includes(query)
            || artist.toLowerCase().includes(query)
            || album.toLowerCase().includes(query)
            || fileNameLower.includes(query)
            || extension.includes(query);
    });

    updateSearchToPlaylistButton(filteredSongs.length > 0);

    if (filteredSongs.length === 0) {
        const li = document.createElement('li');
        li.textContent = t('no-songs');
        li.style.opacity = '0.5';
        li.style.fontStyle = 'italic';
        li.style.pointerEvents = 'none';
        playlistUl.appendChild(li);
        return;
    }

    filteredSongs.forEach((file, index) => {
        const li = document.createElement('li');
        li.dataset.path = file;

        const meta = metadataCache[file];
        const fileName = file.split(/[\\/]/).pop();
        const extension = fileName && fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.') + 1) : '';
        const extensionSuffix = extension ? `.${extension}` : '';
        if (meta) {
            populatePlaylistItemTitle(li, meta.title);
            li.title = `${meta.title}${extensionSuffix} - ${meta.artist}`;
        } else {
            const fallbackTitle = fileName;
            populatePlaylistItemTitle(li, fallbackTitle);
            ipcRenderer.invoke('get-metadata', file).then(metaResult => {
                metadataCache[file] = { title: metaResult.title, artist: metaResult.artist, album: metaResult.album };
                populatePlaylistItemTitle(li, metaResult.title);
                li.title = `${metaResult.title}${extensionSuffix} - ${metaResult.artist}`;
                localStorage.setItem('metadataCache', JSON.stringify(metadataCache));
            });
        }

        if (canReorderCurrentPlaylist()) {
            li.draggable = true;
            li.classList.add('draggable');

            li.addEventListener('dragstart', (e) => {
                dragSourceFile = file;
                dragSourceIndex = index;
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', file);
                li.classList.add('dragging');
            });

            li.addEventListener('dragend', () => {
                dragSourceFile = null;
                dragSourceIndex = null;
                clearPlaylistDragHighlights();
            });

            li.addEventListener('dragover', (e) => {
                if (!dragSourceFile || dragSourceFile === file) return;
                e.preventDefault();
                const rect = li.getBoundingClientRect();
                const insertAfter = (e.clientY - rect.top) >= (rect.height / 2);
                li.classList.toggle('drag-over-top', !insertAfter);
                li.classList.toggle('drag-over-bottom', insertAfter);
            });

            li.addEventListener('dragleave', () => {
                li.classList.remove('drag-over-top', 'drag-over-bottom');
            });

            li.addEventListener('drop', (e) => {
                e.preventDefault();
                if (!dragSourceFile || dragSourceFile === file) return;
                const rect = li.getBoundingClientRect();
                const insertAfter = (e.clientY - rect.top) >= (rect.height / 2);
                if (moveFileInPlaylist(dragSourceFile, file, insertAfter)) {
                    renderPlaylist();
                }
                clearPlaylistDragHighlights();
            });
        }

        li.onclick = () => {
            playlist = [...filteredSongs];
            currentPlayingSourceId = currentSearchQuery ? null : currentViewedPlaylistId;
            currentSongIndex = index;
            loadSong(index, true);
            updatePlaylistHighlight();
        };
        li.oncontextmenu = (e) => {
            e.preventDefault();
            e.stopPropagation();
            const menuVisible = contextMenu && getComputedStyle(contextMenu).display !== 'none';
            if (menuVisible) {
                const currentTarget = e.currentTarget || e.target.closest('li');
                const currentPath = currentTarget?.dataset?.path;
                if (currentPath && currentPath === contextMenu?.dataset?.file) {
                    hideContextMenu();
                    return;
                }
            }
            showSongContextMenu(e, file);
        };
        playlistUl.appendChild(li);
    });
}

let dragSourceFile = null;
let dragSourceIndex = null;

function getReorderListRef() {
    if (currentViewedPlaylistId === 'favorites') return favorites;
    if (customPlaylists[currentViewedPlaylistId]) return customPlaylists[currentViewedPlaylistId];
    return null;
}

function canReorderCurrentPlaylist() {
    return currentViewedPlaylistId === 'favorites' || !!customPlaylists[currentViewedPlaylistId];
}

function updateSearchToPlaylistButton(hasSearchResults) {
    if (!btnSearchToPlaylist) return;
    const hasText = currentSearchQuery && currentSearchQuery.trim().length > 0;
    btnSearchToPlaylist.style.display = (hasText && hasSearchResults) ? 'block' : 'none';
}

function searchByTag(tagText) {
    if (!tagText) return;
    const normalized = String(tagText).trim();
    if (!normalized) return;

    const currentNormalized = normalizeSearchFilterQuery(currentSearchQuery);
    const clickedNormalized = normalizeSearchFilterQuery(normalized);
    const searchInputEl = document.getElementById('playlist-search-input');

    if (clickedNormalized === currentNormalized && currentNormalized.length > 0) {
        currentSearchQuery = '';
        if (searchInputEl) {
            searchInputEl.value = '';
        }
        renderPlaylist();
        updateSearchToPlaylistButton(false);
        if (searchInputEl) {
            searchInputEl.focus();
        }
        return;
    }

    currentSearchQuery = normalized;
    if (searchInputEl) {
        searchInputEl.value = normalized;
    }

    if (!isExpanded) {
        togglePlaylist();
    }
    const searchContainer = document.querySelector('.playlist-search-container');
    if (searchContainer) {
        searchContainer.classList.add('show');
    }

    renderPlaylist();
    updateSearchToPlaylistButton(true);
    if (searchInputEl) {
        searchInputEl.focus();
        searchInputEl.select();
    }
}

function clearPlaylistDragHighlights() {
    const items = playlistUl.querySelectorAll('li');
    items.forEach(item => item.classList.remove('drag-over-top', 'drag-over-bottom', 'dragging'));
}

function moveFileInPlaylist(sourceFile, targetFile, insertAfter = false) {
    const list = getReorderListRef();
    if (!list) return false;

    const sourceIndex = list.indexOf(sourceFile);
    const targetIndex = list.indexOf(targetFile);
    if (sourceIndex === -1 || targetIndex === -1) return false;

    let destinationIndex = targetIndex + (insertAfter ? 1 : 0);
    if (destinationIndex > sourceIndex) {
        destinationIndex -= 1;
    }
    if (destinationIndex === sourceIndex) return false;

    const [moved] = list.splice(sourceIndex, 1);
    list.splice(destinationIndex, 0, moved);

    if (currentViewedPlaylistId === 'favorites') {
        localStorage.setItem('favorites', JSON.stringify(favorites));
    } else {
        localStorage.setItem('customPlaylists', JSON.stringify(customPlaylists));
    }
    if (currentPlayingSourceId === currentViewedPlaylistId) {
        syncCurrentPlayingPlaylistToSourceList(currentPlayingSourceId);
    }
    return true;
}

function syncCurrentPlayingPlaylistToSourceList(sourceId) {
    if (!sourceId || currentPlayingSourceId !== sourceId) return;
    const sourceList = getPlaylistSongs(sourceId);
    if (!sourceList) return;

    const currentFile = currentPlayingFilePath;
    const oldPlaylist = playlist.slice();

    const isFullSource = oldPlaylist.length === sourceList.length && sourceList.every(file => oldPlaylist.includes(file));
    const newPlaylist = isFullSource
        ? [...sourceList]
        : sourceList.filter(file => oldPlaylist.includes(file));

    if (currentFile && !newPlaylist.includes(currentFile) && oldPlaylist.includes(currentFile)) {
        const oldIndex = oldPlaylist.indexOf(currentFile);
        const insertIndex = Math.min(oldIndex, newPlaylist.length);
        newPlaylist.splice(insertIndex, 0, currentFile);
    }

    const oldCurrentIndex = currentSongIndex;
    playlist = newPlaylist;

    if (currentFile) {
        const newIndex = playlist.indexOf(currentFile);
        currentSongIndex = newIndex !== -1 ? newIndex : Math.min(oldCurrentIndex, playlist.length - 1);
    } else if (currentSongIndex >= playlist.length) {
        currentSongIndex = playlist.length - 1;
    }
}

function updatePlaylistHighlight() {
    const items = playlistUl.getElementsByTagName('li');
    for (let i = 0; i < items.length; i++) {
        const path = items[i].dataset.path;
        items[i].classList.toggle('playing', path && path === currentPlayingFilePath);
    }
}

// RESTORED: Reverted to the simpler, proven image loading logic to ensure reliability.
async function loadSong(index, autoPlay = null) {
    if (index < 0 || index >= playlist.length) return;
    const file = playlist[index];

    if (currentPlayingFilePath === file && audio.src) {
        audio.currentTime = 0;
        audio.play().catch(e => console.error(e));
        return;
    }

    currentLoadId++;
    const loadId = currentLoadId;

    currentPlayingFilePath = file;
    audio.src = file;
    seekBar.value = 0;
    seekBar.style.setProperty('--progress', `0%`);
    seekBar.title = '0:00';

    loadSongAbLoopForCurrentFile();

    updatePlaylistHighlight();
    updateMainFavoriteButton();

    const shouldPlay = (autoPlay !== null) ? autoPlay : isPlaying;
    if (shouldPlay) {
        audio.play().catch(e => console.error(e));
        isPlaying = true;
        playImg.src = 'assets/pause_circle_24dp_E3E3E3_FILL1_wght400_GRAD0_opsz24.svg';
    } else {
        audio.pause();
        isPlaying = false;
        playImg.src = 'assets/play_circle_24dp_E3E3E3_FILL1_wght400_GRAD0_opsz24.svg';
    }

    const meta = await ipcRenderer.invoke('get-metadata', file);

    if (loadId !== currentLoadId) return;

    setSongTitleText(meta.title);
    artistEl.textContent = meta.artist;
    updateMainFavoriteButton();
    requestAnimationFrame(updateSongTitleScroll);

    ipcRenderer.send('track-change', {
        title: meta.title,
        artist: meta.artist,
        picture: meta.picture,
        isPlaying: isPlaying
    });

    if (meta.picture) {
        // Direct assignment pattern that was proven to work in earlier versions.
        coverImg.onload = () => {
            const rgb = getAverageColor(coverImg);
            const appEl = document.getElementById('app');
            if (appEl) appEl.style.setProperty('--dominant-color', rgb);
            try { document.documentElement.style.setProperty('--dominant-color', rgb); } catch (e) { }
            sendVisualizerColor(rgb);
        };
        coverImg.src = meta.picture;
        coverImg.style.display = 'block';
        coverPlaceholder.style.display = 'none';

        // Immediate fallback check for cached/instant images
        if (coverImg.complete && coverImg.naturalWidth > 0) {
            const rgb = getAverageColor(coverImg);
            const appEl2 = document.getElementById('app');
            if (appEl2) appEl2.style.setProperty('--dominant-color', rgb);
            try { document.documentElement.style.setProperty('--dominant-color', rgb); } catch (e) { }
            sendVisualizerColor(rgb);
        }
    } else {
        coverImg.onload = null;
        coverImg.src = '';
        coverImg.style.display = 'none';
        coverPlaceholder.style.display = 'flex';
        const appEl3 = document.getElementById('app');
        if (appEl3) appEl3.style.setProperty('--dominant-color', 'rgb(20, 20, 20)');
        try { document.documentElement.style.setProperty('--dominant-color', 'rgb(20, 20, 20)'); } catch (e) { }
        sendVisualizerColor('rgb(20, 20, 20)');
    }
}

function getAverageColor(imgElement) {
    if (!imgElement || !imgElement.complete || imgElement.naturalWidth === 0) return 'rgb(20, 20, 20)';
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = 50;
    canvas.height = 50;
    try {
        ctx.drawImage(imgElement, 0, 0, 50, 50);
        const data = ctx.getImageData(0, 0, 50, 50).data;
        let r = 0, g = 0, b = 0, count = 0;
        for (let i = 0; i < data.length; i += 4) {
            r += data[i]; g += data[i + 1]; b += data[i + 2];
            count++;
        }
        return `rgb(${Math.floor(r / count)}, ${Math.floor(g / count)}, ${Math.floor(b / count)})`;
    } catch (e) {
        return 'rgb(20, 20, 20)';
    }
}

playBtn.onclick = () => {
    if (audio.paused) {
        audio.play().catch(e => console.error(e));
    } else {
        audio.pause();
    }
};

document.getElementById('next-btn').onclick = playNext;
document.getElementById('prev-btn').onclick = playPrev;

function playNext() {
    if (playlist.length === 0) return;
    if (shuffleMode) {
        currentSongIndex = Math.floor(Math.random() * playlist.length);
    } else {
        currentSongIndex = (currentSongIndex + 1) % playlist.length;
    }
    loadSong(currentSongIndex, true);
}

function playPrev() {
    if (playlist.length === 0) return;
    currentSongIndex = (currentSongIndex - 1 + playlist.length) % playlist.length;
    loadSong(currentSongIndex, true);
}

audio.onloadedmetadata = () => {
    if (audio.duration) {
        seekBar.title = `${formatSecondsToMSS(audio.currentTime)} / ${formatSecondsToMSS(audio.duration)}`;
    }
    if (abLoopState.isOpen) {
        if (abLoopState.start === null) {
            abLoopState.start = 0;
            if (abLoopStartInput) abLoopStartInput.value = '0:00';
        }
        if (abLoopState.end === null || abLoopState.end > audio.duration) {
            abLoopState.end = audio.duration;
            if (abLoopEndInput) abLoopEndInput.value = formatSecondsToMSS(audio.duration);
        }
    }
};

audio.onended = () => {
    // UIが表示されており、A~Bループ範囲が設定されている場合は終了時もループ
    if (abLoopState.isOpen && abLoopState.end !== null) {
        const loopStart = (abLoopState.start !== null) ? abLoopState.start : 0;
        audio.currentTime = loopStart;
        audio.play().catch(e => console.error(e));
        return;
    }

    if (loopMode === 'one') {
        audio.currentTime = 0;
        audio.play().catch(e => console.error(e));
    } else if (loopMode === 'all') {
        playNext();
    } else {
        if (shuffleMode || currentSongIndex < playlist.length - 1) {
            playNext();
        } else {
            isPlaying = false;
            playImg.src = 'assets/play_circle_24dp_E3E3E3_FILL1_wght400_GRAD0_opsz24.svg';
        }
    }
};

audio.ontimeupdate = () => {
    // UIが出ているときのみ A~B ループする (loopの状態確認は不要)
    if (abLoopState.isOpen && abLoopState.end !== null) {
        if (audio.currentTime >= abLoopState.end) {
            const loopStart = (abLoopState.start !== null) ? abLoopState.start : 0;
            audio.currentTime = loopStart;
            return;
        }
    }

    const progress = (audio.currentTime / audio.duration) * 100;
    seekBar.value = progress || 0;
    seekBar.style.setProperty('--progress', `${progress || 0}%`);
    if (audio.duration) {
        seekBar.title = `${formatSecondsToMSS(audio.currentTime)} / ${formatSecondsToMSS(audio.duration)}`;
    }
};

seekBar.oninput = () => {
    const time = (seekBar.value / 100) * audio.duration;
    audio.currentTime = time;
    if (audio.duration) {
        seekBar.title = `${formatSecondsToMSS(time)} / ${formatSecondsToMSS(audio.duration)}`;
    }
};

const volWrapper = document.querySelector('.volume-wrapper');
const btnVolume = document.getElementById('btn-volume');
const miniPlayer = document.querySelector('.mini-player');
const appEl = document.getElementById('app');
let isPlaybackControlsHidden = false;

function togglePlaybackControlsVisibility() {
    if (!miniPlayer || !appEl) return;
    isPlaybackControlsHidden = !isPlaybackControlsHidden;
    miniPlayer.classList.toggle('controls-hidden', isPlaybackControlsHidden);
    appEl.classList.toggle('controls-hidden', isPlaybackControlsHidden);

    if (playlistContainer) {
        playlistContainer.style.display = isPlaybackControlsHidden ? 'none' : (isExpanded ? 'flex' : 'none');
    }
}

if (btnVolume) {
    btnVolume.onclick = (e) => {
        if (e.target.id === 'volume-bar') return;
        volWrapper.classList.toggle('open');
    };
}

// Initialize volume from storage (default 25%) and keep UI in sync
(() => {
    const stored = localStorage.getItem('player_volume');
    const initial = (stored !== null) ? parseFloat(stored) : 0.25;
    const clamped = Math.max(0, Math.min(1, isNaN(initial) ? 0.25 : initial));
    volumeBar.value = clamped;
    audio.volume = clamped;
    volumeBar.style.setProperty('--progress', `${clamped * 100}%`);
})();

// Persist volume with debounce to avoid stressing storage
let _saveVolTimer = null;
volumeBar.oninput = () => {
    const v = parseFloat(volumeBar.value);
    audio.volume = v;
    volumeBar.style.setProperty('--progress', `${v * 100}%`);
    if (_saveVolTimer) clearTimeout(_saveVolTimer);
    _saveVolTimer = setTimeout(() => {
        try {
            localStorage.setItem('player_volume', String(v));
        } catch (e) {
            // ignore quota errors
        }
        _saveVolTimer = null;
    }, 500);
};

shuffleBtn.onclick = () => {
    shuffleMode = !shuffleMode;
    shuffleImg.src = shuffleMode
        ? 'assets/shuffle_on_24dp_E3E3E3_FILL1_wght400_GRAD0_opsz24.svg'
        : 'assets/shuffle_24dp_E3E3E3_FILL1_wght400_GRAD0_opsz24.svg';
};

loopBtn.onclick = () => {
    if (loopMode === 'off') {
        loopMode = 'one';
        loopImg.src = 'assets/repeat_one_on_24dp_E3E3E3_FILL1_wght400_GRAD0_opsz24.svg';
    } else if (loopMode === 'one') {
        loopMode = 'all';
        loopImg.src = 'assets/repeat_on_24dp_E3E3E3_FILL1_wght400_GRAD0_opsz24.svg';
    } else {
        loopMode = 'off';
        loopImg.src = 'assets/repeat_24dp_E3E3E3_FILL1_wght400_GRAD0_opsz24.svg';
    }
};

btnExpand.onclick = togglePlaylist;

function togglePlaylist() {
    isExpanded = !isExpanded;
    const appEl = document.getElementById('app');
    if (isExpanded) {
        if (appEl) {
            appEl.style.setProperty('--gradient-height', '560px');
            appEl.style.setProperty('--gradient-pos-y', '0px');
        }
        ipcRenderer.send('resize-window', 'expanded');
        playlistContainer.style.display = 'flex';
        // Force reflow to ensure the transition is triggered from the initial state
        playlistContainer.offsetHeight;
        playlistContainer.classList.add('expanded');
        textExpand.textContent = t('playlist-hide');
        imgExpand.style.transform = 'rotate(180deg)';
    } else {
        if (appEl) {
            appEl.style.setProperty('--gradient-height', '210px');
            appEl.style.setProperty('--gradient-pos-y', '0px');
        }
        playlistContainer.classList.remove('expanded');
        textExpand.textContent = t('playlist-expand');
        imgExpand.style.transform = 'rotate(0deg)';

        // Hide and reset search when collapsing playlist
        const searchContainer = document.querySelector('.playlist-search-container');
        if (searchContainer) {
            searchContainer.classList.remove('show');
        }
        const searchInput = document.getElementById('playlist-search-input');
        if (searchInput) {
            searchInput.value = '';
        }
        if (currentSearchQuery) {
            currentSearchQuery = '';
            renderPlaylist();
        }

        // Wait for CSS transition (300ms) to complete before hiding the container and shrinking the window
        setTimeout(() => {
            if (!isExpanded) {
                playlistContainer.style.display = 'none';
                ipcRenderer.send('resize-window', 'mini');
            }
        }, 300);
    }

    // Periodically refresh drag handles during animation
    let count = 0;
    const timer = setInterval(() => {
        refreshDragHandle();
        if (count++ > 20) clearInterval(timer); // 20 * 20ms = 400ms to cover the transition
    }, 20);
}

const btnPin = document.getElementById('btn-pin');
const imgPin = document.getElementById('img-pin');
let isAlwaysOnTop = false;

btnPin.onclick = () => {
    isAlwaysOnTop = !isAlwaysOnTop;
    ipcRenderer.send('set-always-on-top', isAlwaysOnTop);
    imgPin.src = isAlwaysOnTop ? 'assets/keep_off_24dp_E3E3E3_FILL1_wght400_GRAD0_opsz24.svg' : 'assets/keep_24dp_E3E3E3_FILL1_wght400_GRAD0_opsz24.svg';
};

// Search logic
const searchInput = document.getElementById('playlist-search-input');
const btnSearchToPlaylist = document.getElementById('btn-search-to-playlist');

function toggleSearchArea() {
    const searchContainer = document.querySelector('.playlist-search-container');
    if (!searchContainer) return;

    const isCurrentlyShown = searchContainer.classList.contains('show');

    if (!isCurrentlyShown) {
        // First ensure playlist is expanded
        if (!isExpanded) {
            togglePlaylist();
        }

        searchContainer.classList.add('show');

        // Focus the input after height animation starts
        setTimeout(() => {
            if (searchInput) {
                searchInput.focus();
                searchInput.select();
            }
        }, 100);
    } else {
        searchContainer.classList.remove('show');
        if (searchInput) {
            searchInput.blur();
            if (currentSearchQuery) {
                currentSearchQuery = '';
                searchInput.value = '';
                renderPlaylist();
            }
        }
    }
}

// Global shortcuts (Ctrl + F to search, Escape to close context menu)
window.addEventListener('keydown', (e) => {
    const activeTag = document.activeElement?.tagName;
    const isTyping = activeTag === 'INPUT' || activeTag === 'TEXTAREA';

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        toggleSearchArea();
    } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'v') {
        e.preventDefault();
        ipcRenderer.invoke('toggle-visualizer').catch(console.error);
    } else if (e.shiftKey && e.key.toLowerCase() === 's' && !isTyping) {
        e.preventDefault();
        togglePlaybackControlsVisibility();
    } else if (e.key === 'Escape') {
        if (contextMenu && contextMenu.style.display === 'block') {
            hideContextMenu();
            e.stopPropagation();
        }
    }
});

if (searchInput) {
    searchInput.oninput = (e) => {
        currentSearchQuery = e.target.value;
        renderPlaylist();
        const hasText = currentSearchQuery && currentSearchQuery.trim().length > 0;
        if (!hasText) {
            updateSearchToPlaylistButton(false);
        }
    };
    searchInput.onkeydown = (e) => {
        if (e.key === 'Enter') {
            if (currentSearchQuery.trim() && btnSearchToPlaylist && btnSearchToPlaylist.style.display !== 'none') {
                btnSearchToPlaylist.click();
            }
        } else if (e.key === 'Escape') {
            toggleSearchArea();
            e.stopPropagation();
        }
    };
}

if (btnSearchToPlaylist) {
    btnSearchToPlaylist.onclick = () => {
        const playlistName = currentSearchQuery.trim();
        if (!playlistName) return;

        if (customPlaylists[playlistName] || playlistName === 'all' || playlistName === 'favorites') {
            alert(t('name-in-use'));
            return;
        }

        // Find the songs matching the query in the CURRENT tab's songs list
        const songsToRender = getPlaylistSongs(currentViewedPlaylistId);
        const filteredSongs = songsToRender.filter(file => {
            const meta = metadataCache[file];
            const title = (meta && meta.title) ? meta.title : file.split(/[\\/]/).pop();
            const artist = (meta && meta.artist) ? meta.artist : '';
            const album = (meta && meta.album) ? meta.album : '';
            const fileName = file.split(/[\\/]/).pop();
            const fileNameLower = fileName.toLowerCase();
            const extension = fileNameLower.includes('.') ? fileNameLower.slice(fileNameLower.lastIndexOf('.') + 1) : '';
            const query = playlistName.toLowerCase();
            const extensionQuery = query.startsWith('.') ? query.slice(1) : query;
            return title.toLowerCase().includes(query)
                || artist.toLowerCase().includes(query)
                || album.toLowerCase().includes(query)
                || fileNameLower.includes(query)
                || extension.includes(extensionQuery);
        });
        customPlaylists[playlistName] = filteredSongs;
        localStorage.setItem('customPlaylists', JSON.stringify(customPlaylists));

        // 検索クエリを記録（更新ボタン用）
        playlistSearchQueries[playlistName] = playlistName;
        localStorage.setItem('playlistSearchQueries', JSON.stringify(playlistSearchQueries));

        // Hide and reset search when transition completes
        const searchContainer = document.querySelector('.playlist-search-container');
        if (searchContainer) {
            searchContainer.classList.remove('show');
        }
        currentSearchQuery = '';
        if (searchInput) {
            searchInput.value = '';
            searchInput.blur();
        }

        // Switch to the newly created playlist tab
        currentViewedPlaylistId = playlistName;
        renderTabs();
        renderPlaylist();
        updatePlaylistHighlight();
    };
}

function refreshSearchPlaylist(playlistName) {
    const query = playlistSearchQueries[playlistName];
    if (!query) return;

    const existing = new Set(customPlaylists[playlistName] || []);
    const queryLower = query.toLowerCase();
    const extensionQuery = queryLower.startsWith('.') ? queryLower.slice(1) : queryLower;

    // allSongs 全体から検索して既存リストにない新曲を探す
    const newSongs = allSongs.filter(file => {
        if (existing.has(file)) return false;
        const meta = metadataCache[file];
        const title = (meta && meta.title) ? meta.title : file.split(/[\\/]/).pop();
        const artist = (meta && meta.artist) ? meta.artist : '';
        const album = (meta && meta.album) ? meta.album : '';
        const fileName = file.split(/[\\/]/).pop();
        const fileNameLower = fileName.toLowerCase();
        const extension = fileNameLower.includes('.') ? fileNameLower.slice(fileNameLower.lastIndexOf('.') + 1) : '';
        return title.toLowerCase().includes(queryLower)
            || artist.toLowerCase().includes(queryLower)
            || album.toLowerCase().includes(queryLower)
            || fileNameLower.includes(queryLower)
            || extension.includes(extensionQuery);
    });

    if (newSongs.length === 0) {
        // 視覚的フィードバック: ボタンをアニメーション後に元に戻す
        const activeTab = document.querySelector(`.playlist-tabs .playlist-tab.active`);
        const btn = activeTab ? activeTab.querySelector('.tab-refresh-btn') : null;
        if (btn) {
            btn.classList.add('refresh-none');
            setTimeout(() => btn.classList.remove('refresh-none'), 800);
        }
        return;
    }

    // 新曲を末尾に追加
    customPlaylists[playlistName] = [...(customPlaylists[playlistName] || []), ...newSongs];
    localStorage.setItem('customPlaylists', JSON.stringify(customPlaylists));

    if (currentPlayingSourceId === playlistName) {
        syncCurrentPlayingPlaylistToSourceList(playlistName);
    }

    // 現在表示中なら再描画
    if (currentViewedPlaylistId === playlistName) {
        renderPlaylist();
        updatePlaylistHighlight();
    }

    // 更新ボタンのアニメーション
    const activeTab = document.querySelector(`.playlist-tabs .playlist-tab.active`);
    const btn = activeTab ? activeTab.querySelector('.tab-refresh-btn') : null;
    if (btn) {
        btn.classList.add('refresh-spin');
        setTimeout(() => btn.classList.remove('refresh-spin'), 600);
    }
}

ipcRenderer.on('taskbar-control', (event, action) => {
    if (action === 'play-pause') {
        if (playBtn) playBtn.click();
    } else if (action === 'prev') {
        playPrev();
    } else if (action === 'next') {
        playNext();
    } else if (action === 'volume-up' || action === 'volume-down') {
        // ウィジェットのスクロールホイールによる音量変更 (1ノッチ = 5%)
        const step = 0.05;
        const current = parseFloat(volumeBar.value) || 0;
        const next = Math.max(0, Math.min(1, current + (action === 'volume-up' ? step : -step)));
        const rounded = Math.round(next * 100) / 100;
        volumeBar.value = rounded;
        audio.volume = rounded;
        volumeBar.style.setProperty('--progress', `${rounded * 100}%`);
        // localStorageに保存 (既存のデバウンス変数を再利用)
        if (_saveVolTimer) clearTimeout(_saveVolTimer);
        _saveVolTimer = setTimeout(() => {
            try { localStorage.setItem('player_volume', String(rounded)); } catch (e) {}
            _saveVolTimer = null;
        }, 500);
    }
});

loadMusic();
window.addEventListener('load', refreshDragHandle);
