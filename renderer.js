const { ipcRenderer, shell } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const { ContextMenuManager, DialogManager } = require('./ui-managers');

function getAudioFileUrl(filePath) {
    if (!filePath) return '';
    try {
        return pathToFileURL(filePath).href;
    } catch (e) {
        return filePath;
    }
}

let playlist = [];
let currentSongIndex = -1;
let isPlaying = false;
let isExpanded = false;
let shuffleMode = JSON.parse(localStorage.getItem('player_shuffleMode')) || false;
let loopMode = localStorage.getItem('player_loopMode') || 'off'; // 'off', 'one', 'all'
let currentLoadId = 0;
let abLoopState = { start: null, end: null, isOpen: false };
let songAbLoops = JSON.parse(localStorage.getItem('songAbLoops')) || {};

let allSongs = [];
let favorites = JSON.parse(localStorage.getItem('favorites')) || [];
let customPlaylists = JSON.parse(localStorage.getItem('customPlaylists')) || {};
let playlistIcons = JSON.parse(localStorage.getItem('playlistIcons')) || {};
let playlistSearchQueries = JSON.parse(localStorage.getItem('playlistSearchQueries')) || {};
let currentViewedPlaylistId = localStorage.getItem('player_viewedPlaylistId') || 'all'; // 'all', 'favorites', or custom playlist name
let currentPlayingSourceId = localStorage.getItem('player_playingSourceId') || 'all';
let currentPlayingFilePath = '';
let metadataCache = JSON.parse(localStorage.getItem('metadataCache')) || {};
let songStats = JSON.parse(localStorage.getItem('songStats')) || {};
let currentSearchQuery = '';
let pendingRestorePosition = null;

function savePlaybackState() {
    try {
        if (currentPlayingFilePath) {
            localStorage.setItem('player_lastSong', currentPlayingFilePath);
            if (audio && !isNaN(audio.currentTime)) {
                localStorage.setItem('player_lastPosition', String(audio.currentTime));
            }
        }
        if (currentPlayingSourceId) {
            localStorage.setItem('player_playingSourceId', currentPlayingSourceId);
        }
        localStorage.setItem('player_viewedPlaylistId', currentViewedPlaylistId);
    } catch (e) {}
}

function recordSongPlay(file) {
    if (!file) return;
    if (!songStats[file]) {
        songStats[file] = { playCount: 0, lastPlayed: null, lastPosition: 0 };
    }
    songStats[file].playCount = (songStats[file].playCount || 0) + 1;
    songStats[file].lastPlayed = Date.now();
    try { localStorage.setItem('songStats', JSON.stringify(songStats)); } catch (e) {}
}

function updateSongPosition(file, pos) {
    if (!file || isNaN(pos)) return;
    if (!songStats[file]) {
        songStats[file] = { playCount: 0, lastPlayed: Date.now(), lastPosition: pos };
    }
    songStats[file].lastPosition = pos;
    try { localStorage.setItem('songStats', JSON.stringify(songStats)); } catch (e) {}
}

// Sort state for "すべての曲" view
// 'none' = 追加順 (デフォルト), 'title', 'artist', 'filename', 'track'
const SORT_MODES = [
    { key: 'none',     label: '追加順' },
    { key: 'title',    label: '曲名順' },
    { key: 'artist',   label: 'アーティスト順' },
    { key: 'filename', label: 'ファイル名順' },
    { key: 'track',    label: 'トラックナンバー順' },
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

// Dropdown backdrop and state management
let activeDropdownCloser = null;

function closeActiveDropdown() {
    if (activeDropdownCloser) {
        const closer = activeDropdownCloser;
        activeDropdownCloser = null;
        closer();
    }
}

function createDropdownBackdrop(onClose) {
    closeActiveDropdown();

    const backdrop = document.createElement('div');
    backdrop.className = 'dropdown-backdrop';

    let isClosed = false;
    const handleClose = (e) => {
        if (e) {
            e.preventDefault();
            e.stopPropagation();
        }
        if (isClosed) return;
        isClosed = true;

        if (backdrop.parentNode) {
            backdrop.remove();
        }
        if (activeDropdownCloser === handleClose) {
            activeDropdownCloser = null;
        }
        if (typeof onClose === 'function') {
            onClose();
        }
    };

    backdrop.onpointerdown = handleClose;
    backdrop.onclick = handleClose;
    backdrop.oncontextmenu = (e) => {
        e.preventDefault();
        e.stopPropagation();
        handleClose(e);
    };

    document.body.appendChild(backdrop);
    activeDropdownCloser = handleClose;

    return handleClose;
}

const dialogManager = new DialogManager();

function showDialog(options) {
    closeActiveDropdown();
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
    closeActiveDropdown();
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
    const playlistContainer = e.target.closest('#playlist-container');
    if (playlistContainer && (customPlaylists[currentViewedPlaylistId] || currentViewedPlaylistId === 'favorites')) {
        e.preventDefault();
        e.stopPropagation();
        showPlaylistTabContextMenu(e, currentViewedPlaylistId);
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

function getTrackNumber(file, meta) {
    if (meta && typeof meta.trackNumber === 'number' && meta.trackNumber > 0) {
        return meta.trackNumber;
    }
    const fileName = file.split(/[\\/]/).pop() || '';
    const match = fileName.match(/^(\d{1,3})[\s._-]/);
    if (match) {
        const num = parseInt(match[1], 10);
        if (!isNaN(num) && num > 0) return num;
    }
    return 0;
}

function getDiskNumber(file, meta) {
    if (meta && typeof meta.diskNumber === 'number' && meta.diskNumber > 0) {
        return meta.diskNumber;
    }
    const match = file.match(/(?:disc|cd)\s*(\d+)/i);
    if (match) {
        const num = parseInt(match[1], 10);
        if (!isNaN(num) && num > 0) return num;
    }
    return 1;
}

function getAlbumName(file, meta) {
    if (meta && meta.album && meta.album !== 'Unknown Album') {
        return meta.album.trim();
    }
    return '';
}

function compareSongsByTrack(a, b) {
    const ma = metadataCache[a];
    const mb = metadataCache[b];

    const albumA = getAlbumName(a, ma);
    const albumB = getAlbumName(b, mb);

    if (albumA && albumB && albumA !== albumB) {
        const cmpAlbum = albumA.localeCompare(albumB, 'ja', { numeric: true, sensitivity: 'base' });
        if (cmpAlbum !== 0) return cmpAlbum;
    } else if (albumA && !albumB) {
        return -1;
    } else if (!albumA && albumB) {
        return 1;
    }

    const diskA = getDiskNumber(a, ma);
    const diskB = getDiskNumber(b, mb);
    if (diskA !== diskB) {
        return diskA - diskB;
    }

    const trackA = getTrackNumber(a, ma);
    const trackB = getTrackNumber(b, mb);
    if (trackA > 0 && trackB > 0) {
        if (trackA !== trackB) return trackA - trackB;
    } else if (trackA > 0 && trackB === 0) {
        return -1;
    } else if (trackA === 0 && trackB > 0) {
        return 1;
    }

    const titleA = (ma && ma.title) ? ma.title : (a.split(/[\\/]/).pop() || '');
    const titleB = (mb && mb.title) ? mb.title : (b.split(/[\\/]/).pop() || '');
    const cmpTitle = titleA.localeCompare(titleB, 'ja', { numeric: true, sensitivity: 'base' });
    if (cmpTitle !== 0) return cmpTitle;

    return a.localeCompare(b, 'ja', { numeric: true });
}

async function sortPlaylistByTrackNumber(playlistName) {
    let list = null;
    let isFavorites = false;
    if (playlistName === 'favorites') {
        list = favorites;
        isFavorites = true;
    } else if (customPlaylists[playlistName]) {
        list = customPlaylists[playlistName];
    }
    if (!list || list.length === 0) return;

    const uncached = list.filter(file => !metadataCache[file] || metadataCache[file].trackNumber === undefined);
    if (uncached.length > 0) {
        await Promise.all(uncached.map(async (file) => {
            try {
                const meta = await ipcRenderer.invoke('get-metadata', file);
                metadataCache[file] = {
                    title: meta.title,
                    artist: meta.artist,
                    album: meta.album,
                    albumArtist: meta.albumArtist,
                    trackNumber: meta.trackNumber,
                    diskNumber: meta.diskNumber || 1,
                    genres: meta.genres,
                    duration: meta.duration
                };
            } catch (e) {
                console.error('Failed to get metadata for sorting:', file, e);
            }
        }));
        try {
            localStorage.setItem('metadataCache', JSON.stringify(metadataCache));
        } catch (e) {}
    }

    list.sort(compareSongsByTrack);

    if (isFavorites) {
        localStorage.setItem('favorites', JSON.stringify(favorites));
    } else {
        localStorage.setItem('customPlaylists', JSON.stringify(customPlaylists));
    }

    if (currentViewedPlaylistId === playlistName) {
        renderPlaylist();
    }

    if (currentPlayingSourceId === playlistName) {
        syncCurrentPlayingPlaylistToSourceList(playlistName);
        updatePlaylistHighlight();
    }
}

function showPlaylistTabContextMenu(e, name) {
    const isFavorites = (name === 'favorites');
    const items = [
        {
            label: t('sort-by-track-number'),
            icon: 'assets/sort_24dp_FFFFFF_FILL1_wght400_GRAD0_opsz24.svg',
            action: () => sortPlaylistByTrackNumber(name)
        },
        { type: 'separator' },
        {
            label: t('change-icon'),
            action: async () => {
                const iconPath = await ipcRenderer.invoke('select-icon-file');
                if (!iconPath) return;
                setPlaylistIcon(name, iconPath);
                renderTabs();
            }
        }
    ];

    if (!isFavorites) {
        items.push({
            label: t('rename'),
            action: () => renamePlaylist(name)
        });

        // 検索クエリの有無に応じて「クエリを管理...」または「クエリを追加...」を表示
        const hasQuery = Boolean(playlistSearchQueries[name]);
        items.push({ type: 'separator' });
        items.push({
            label: hasQuery ? 'クエリを管理...' : 'クエリを追加...',
            icon: 'assets/refresh_24dp_FFFFFF_FILL1_wght400_GRAD0_opsz24.svg',
            action: () => managePlaylistQuery(name)
        });

        items.push({ type: 'separator' });
        items.push({
            label: t('dialog-delete'),
            action: () => deletePlaylist(name)
        });
    }

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
    const favTab = createTabEl('favorites', t('favorites'), getPlaylistIcon('favorites'));
    favTab.oncontextmenu = (e) => {
        e.preventDefault();
        e.stopPropagation();
        showPlaylistTabContextMenu(e, 'favorites');
    };
    tabsContainer.appendChild(favTab);

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
    savePlaybackState();
    renderTabs();
    renderPlaylist();
    updatePlaylistHighlight();

    const songs = getPlaylistSongs(id);
    if (songs.length > 0) {
        playlist = [...songs];
        currentPlayingSourceId = id;
        savePlaybackState();
        currentSongIndex = 0;
        loadSong(0, true);
    }
}

function createTabEl(id, label, iconSrc) {
    const span = document.createElement('span');
    span.className = 'playlist-tab';
    span.dataset.playlistId = id;
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
        savePlaybackState();
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
            refreshSearchPlaylist(id, refreshBtn);
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
    // Remove existing dropdown if any (toggle behavior)
    const existing = document.getElementById('sort-dropdown');
    if (existing) {
        closeActiveDropdown();
        return;
    }
    closeActiveDropdown();

    const dropdown = document.createElement('div');
    dropdown.id = 'sort-dropdown';
    dropdown.className = 'sort-dropdown';

    const closeDropdown = () => {
        if (dropdown.parentNode) dropdown.remove();
    };

    const closeBackdrop = createDropdownBackdrop(closeDropdown);

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
            closeBackdrop();
        };
        dropdown.appendChild(item);
    });

    // Prevent clicks inside dropdown from bubbling to backdrop
    dropdown.onpointerdown = (e) => e.stopPropagation();
    dropdown.onclick = (e) => e.stopPropagation();

    // Position: below the sort button
    const rect = btnSort.getBoundingClientRect();
    dropdown.style.top = (rect.bottom + 4) + 'px';
    dropdown.style.left = (rect.left - dropdown.offsetWidth + rect.width) + 'px';
    document.body.appendChild(dropdown);
    // Adjust left after appended so offsetWidth is known
    requestAnimationFrame(() => {
        dropdown.style.left = (rect.right - dropdown.offsetWidth) + 'px';
    });
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

function syncPlaybackUI(playing) {
    isPlaying = Boolean(playing);
    const iconSrc = isPlaying
        ? 'assets/pause_circle_24dp_E3E3E3_FILL1_wght400_GRAD0_opsz24.svg'
        : 'assets/play_circle_24dp_E3E3E3_FILL1_wght400_GRAD0_opsz24.svg';
    if (playImg) playImg.src = iconSrc;
    if (playBtn) playBtn.title = isPlaying ? 'Pause' : 'Play';

    ipcRenderer.send('playback-change', isPlaying);
    if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
    }
    if (typeof updateWebMediaSessionPosition === 'function') {
        updateWebMediaSessionPosition();
    }
}
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

if (mainFavoriteBtn) {
    mainFavoriteBtn.onclick = (e) => {
        e.stopPropagation();
        if (currentPlayingFilePath) {
            toggleFavorite(currentPlayingFilePath);
        }
    };
}

// Equalizer Presets definition (5-band: 60Hz, 250Hz, 1kHz, 4kHz, 12kHz)
const EQUALIZER_PRESETS = {
    flat: {
        key: 'flat',
        labelKey: 'eq-flat',
        gains: [0, 0, 0, 0, 0]
    },
    bass: {
        key: 'bass',
        labelKey: 'eq-bass-boost',
        gains: [6, 3, 0, 0, 0]
    },
    treble: {
        key: 'treble',
        labelKey: 'eq-treble-boost',
        gains: [0, 0, 0, 3, 6]
    },
    vocal: {
        key: 'vocal',
        labelKey: 'eq-vocal',
        gains: [-2, 1, 4, 2, 0]
    },
    rock: {
        key: 'rock',
        labelKey: 'eq-rock',
        gains: [4, 2, -1, 2, 4]
    },
    pop: {
        key: 'pop',
        labelKey: 'eq-pop',
        gains: [2, 1, 2, 2, 1]
    },
    radio: {
        key: 'radio',
        labelKey: 'eq-radio',
        gains: [-6, -1, 5, 1, -5]
    },
    live: {
        key: 'live',
        labelKey: 'eq-live-stage',
        gains: [7, 3, -1, 3, 5],
        fx: true
    }
};

let currentEqualizerPreset = localStorage.getItem('player_equalizerPreset') || 'flat';
if (!EQUALIZER_PRESETS[currentEqualizerPreset]) {
    currentEqualizerPreset = 'flat';
}

const mainEqualizerBtn = document.getElementById('main-equalizer-btn');

function updateEqualizerButtonUI() {
    if (!mainEqualizerBtn) return;
    const preset = EQUALIZER_PRESETS[currentEqualizerPreset] || EQUALIZER_PRESETS.flat;
    const label = t(preset.labelKey);
    const baseTitle = t('equalizer-preset');
    mainEqualizerBtn.title = `${baseTitle} (${label})`;
    mainEqualizerBtn.classList.toggle('active', currentEqualizerPreset !== 'flat');
}

function showEqualizerDropdown() {
    const existing = document.getElementById('equalizer-dropdown');
    if (existing) {
        closeActiveDropdown();
        return;
    }

    if (!mainEqualizerBtn) return;
    closeActiveDropdown();

    const dropdown = document.createElement('div');
    dropdown.id = 'equalizer-dropdown';
    dropdown.className = 'eq-dropdown';

    const closeDropdown = () => {
        if (dropdown.parentNode) dropdown.remove();
    };

    const closeBackdrop = createDropdownBackdrop(closeDropdown);

    Object.values(EQUALIZER_PRESETS).forEach(({ key, labelKey, fx }) => {
        // Add separator before FX presets
        if (fx && dropdown.children.length > 0) {
            const sep = document.createElement('div');
            sep.style.height = '1px';
            sep.style.background = 'rgba(255, 255, 255, 0.1)';
            sep.style.margin = '4px 8px';
            dropdown.appendChild(sep);
        }

        const item = document.createElement('div');
        const isActive = (currentEqualizerPreset === key);
        item.className = 'eq-dropdown-item' + (isActive ? ' active' : '');

        const checkSpan = document.createElement('span');
        checkSpan.textContent = isActive ? '✓' : '';
        checkSpan.style.width = '16px';
        checkSpan.style.display = 'inline-block';
        checkSpan.style.textAlign = 'center';
        checkSpan.style.flexShrink = '0';
        checkSpan.style.color = '#ffffff';

        const labelSpan = document.createElement('span');
        labelSpan.textContent = t(labelKey);
        labelSpan.style.color = '#ffffff';

        item.appendChild(checkSpan);
        item.appendChild(labelSpan);

        item.onclick = (e) => {
            e.stopPropagation();
            if (typeof applyEqualizerPreset === 'function') {
                applyEqualizerPreset(key);
            }
            closeBackdrop();
        };

        dropdown.appendChild(item);
    });

    // Prevent clicks inside dropdown from bubbling to backdrop
    dropdown.onpointerdown = (e) => e.stopPropagation();
    dropdown.onclick = (e) => e.stopPropagation();

    const rect = mainEqualizerBtn.getBoundingClientRect();
    dropdown.style.top = (rect.bottom + 6) + 'px';
    dropdown.style.left = (rect.left - 40) + 'px';
    document.body.appendChild(dropdown);

    requestAnimationFrame(() => {
        let left = rect.right - dropdown.offsetWidth;
        if (left < 8) left = 8;
        dropdown.style.left = left + 'px';
    });
}

if (mainEqualizerBtn) {
    mainEqualizerBtn.onclick = (e) => {
        e.stopPropagation();
        showEqualizerDropdown();
    };
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


function formatPlaylistTitleParts(text) {
    const raw = String(text || '').trim();
    if (!raw) {
        return { titleText: '', tagParts: [] };
    }

    let remaining = raw;
    const tagParts = [];

    // 丸括弧 ( ... )
    remaining = remaining.replace(/\s*\(([^)]*)\)/g, (_, inner) => {
        const part = inner.trim();
        if (part) tagParts.push(part);
        return '';
    });

    // 角括弧 [ ... ]
    remaining = remaining.replace(/\s*\[([^\]]*)\]/g, (_, inner) => {
        const part = inner.trim();
        if (part) tagParts.push(part);
        return '';
    });

    // 末尾のダッシュ / ハイフンタグ
    const dashTagMatch = remaining.match(/^(.*)\s+(?:--|—|–|-)\s+([^-–—\s][\s\S]*?)\s*$/u);
    if (dashTagMatch) {
        const titlePart = dashTagMatch[1].trim();
        const tagPart = dashTagMatch[2].trim();
        if (titlePart && tagPart) {
            tagParts.push(tagPart);
            remaining = titlePart;
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

function buildTitleContent(titleText, tagParts, isClone = false) {
    const span = document.createElement('span');
    span.className = isClone ? 'title-content title-content-clone' : 'title-content';
    if (isClone) {
        span.setAttribute('aria-hidden', 'true');
    }

    const titleSpan = document.createElement('span');
    titleSpan.className = 'title-text';
    titleSpan.textContent = titleText;
    span.appendChild(titleSpan);

    tagParts.forEach((tagPart) => {
        const tagSpan = document.createElement('span');
        tagSpan.className = 'playlist-item-tag title-tag';
        tagSpan.textContent = tagPart;
        if (doesSearchQueryMatchTag(tagPart)) {
            tagSpan.classList.add('matched');
        }
        tagSpan.onclick = (event) => {
            event.stopPropagation();
            searchByTag(tagPart);
        };
        span.appendChild(tagSpan);
    });

    return span;
}

let currentSongTitleParts = { titleText: '', tagParts: [] };

function updateMainIslandTagMatches() {
    if (!titleEl) return;
    titleEl.querySelectorAll('.title-tag').forEach((tagSpan) => {
        const tagText = tagSpan.textContent || '';
        tagSpan.classList.toggle('matched', doesSearchQueryMatchTag(tagText));
    });
}

function setSongTitleText(text) {
    if (!titleEl) return;

    const raw = String(text || '').trim();
    const isDefault = (raw === t('song-title-default') || raw === locales['ja']['song-title-default'] || raw === locales['en']['song-title-default']);
    currentSongTitleParts = isDefault ? { titleText: raw, tagParts: [] } : formatPlaylistTitleParts(raw);

    let track = titleEl.querySelector('.title-track');
    if (!track) {
        track = document.createElement('div');
        track.className = 'title-track';
        titleEl.appendChild(track);
    }

    track.innerHTML = '';
    const mainContent = buildTitleContent(currentSongTitleParts.titleText, currentSongTitleParts.tagParts, false);
    track.appendChild(mainContent);

    requestAnimationFrame(updateSongTitleScroll);
}

function updateSongTitleScroll() {
    if (!titleEl) return;

    const track = titleEl.querySelector('.title-track');
    const content = track?.querySelector('.title-content:not(.title-content-clone)');
    if (!track || !content) return;

    const viewportWidth = titleEl.clientWidth;
    const contentWidth = content.scrollWidth;
    const isOverflowing = contentWidth > viewportWidth;

    track.classList.toggle('scrollable', isOverflowing);

    if (isOverflowing) {
        let clone = track.querySelector('.title-content-clone');
        if (!clone) {
            clone = buildTitleContent(currentSongTitleParts.titleText, currentSongTitleParts.tagParts, true);
            track.appendChild(clone);
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

function updateShuffleUI() {
    if (!shuffleImg) return;
    shuffleImg.src = shuffleMode
        ? 'assets/shuffle_on_24dp_E3E3E3_FILL1_wght400_GRAD0_opsz24.svg'
        : 'assets/shuffle_24dp_E3E3E3_FILL1_wght400_GRAD0_opsz24.svg';
}

function updateLoopUI() {
    if (!loopImg) return;
    if (loopMode === 'one') {
        loopImg.src = 'assets/repeat_one_on_24dp_E3E3E3_FILL1_wght400_GRAD0_opsz24.svg';
    } else if (loopMode === 'all') {
        loopImg.src = 'assets/repeat_on_24dp_E3E3E3_FILL1_wght400_GRAD0_opsz24.svg';
    } else {
        loopImg.src = 'assets/repeat_24dp_E3E3E3_FILL1_wght400_GRAD0_opsz24.svg';
    }
}

updateShuffleUI();
updateLoopUI();

const volumeBar = document.getElementById('volume-bar');

const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
const audioSource = audioCtx.createMediaElementSource(audio);
const analyser = audioCtx.createAnalyser();
const visualizerData = new Uint8Array(analyser.frequencyBinCount);
let currentAudioUsesSox = false;
const soxInfoPromise = ipcRenderer.invoke('get-sox-info')
    .then(info => Boolean(info && info.available))
    .catch(() => false);

const EQ_BANDS = [
    { type: 'lowshelf',  frequency: 60,   q: 1 },
    { type: 'peaking',   frequency: 250,  q: 1 },
    { type: 'peaking',   frequency: 1000, q: 1 },
    { type: 'peaking',   frequency: 4000, q: 1 },
    { type: 'highshelf', frequency: 12000, q: 1 }
];

const eqFilters = EQ_BANDS.map(band => {
    const filter = audioCtx.createBiquadFilter();
    filter.type = band.type;
    filter.frequency.value = band.frequency;
    filter.Q.value = band.q;
    filter.gain.value = 0;
    return filter;
});

function applyEqualizerPreset(presetKey) {
    const preset = EQUALIZER_PRESETS[presetKey] || EQUALIZER_PRESETS.flat;
    currentEqualizerPreset = preset.key;
    try {
        localStorage.setItem('player_equalizerPreset', preset.key);
    } catch (e) {}

    const now = audioCtx.currentTime;
    preset.gains.forEach((gainValue, index) => {
        if (eqFilters[index]) {
            eqFilters[index].gain.setTargetAtTime(gainValue, now, 0.05);
        }
    });

    // Toggle Live Stage FX (compressor + saturator + reverb + stereo widener)
    if (typeof setLiveFxEnabled === 'function') {
        setLiveFxEnabled(!!preset.fx);
    }

    updateEqualizerButtonUI();
}

analyser.fftSize = 256;
let lastEqNode = audioSource;
eqFilters.forEach(filter => {
    lastEqNode.connect(filter);
    lastEqNode = filter;
});

// ── Live Stage FX chain (always created, bypassed when inactive) ──

// 1. Compressor — PA-system-style brick-wall compression for massive loudness
// Initialized in bypass state (threshold=0, ratio=1 → transparent)
const liveCompressor = audioCtx.createDynamicsCompressor();
liveCompressor.threshold.value = 0;
liveCompressor.knee.value = 4;
liveCompressor.ratio.value = 1;
liveCompressor.attack.value = 0.002;
liveCompressor.release.value = 0.15;

// 2. Wave Shaper — soft-clip saturation for driven-speaker warmth
const liveSaturator = audioCtx.createWaveShaper();
function buildSaturationCurve(amount) {
    const n = 8192;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const x = (i * 2) / n - 1;
        curve[i] = (Math.PI + amount) * x / (Math.PI + amount * Math.abs(x));
    }
    return curve;
}
liveSaturator.curve = null; // bypass initially
liveSaturator.oversample = '4x';

// 3. Convolver — algorithmic hall-impulse reverb (generated, no external file)
function buildHallImpulse(ctx, duration, decay) {
    const length = Math.floor(ctx.sampleRate * duration);
    const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
        const data = impulse.getChannelData(ch);
        for (let i = 0; i < length; i++) {
            data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
        }
    }
    return impulse;
}
const liveConvolver = audioCtx.createConvolver();
liveConvolver.buffer = buildHallImpulse(audioCtx, 2.2, 2.8);

const liveReverbGain = audioCtx.createGain();  // wet level
liveReverbGain.gain.value = 0;
const liveDryGain = audioCtx.createGain();      // dry level
liveDryGain.gain.value = 1;
const liveReverbMerge = audioCtx.createGain();  // mix point

// 4. Stereo Widener — Haas effect via per-channel micro-delay
const liveSplitter = audioCtx.createChannelSplitter(2);
const liveMerger = audioCtx.createChannelMerger(2);
const liveDelayL = audioCtx.createDelay(0.05);
const liveDelayR = audioCtx.createDelay(0.05);
liveDelayL.delayTime.value = 0;
liveDelayR.delayTime.value = 0;

// 5. Post-FX makeup gain
const liveMakeupGain = audioCtx.createGain();
liveMakeupGain.gain.value = 1.0;

// Wire the FX chain: EQ → compressor → saturator → reverb dry/wet → widener → makeup → analyser
lastEqNode.connect(liveCompressor);
liveCompressor.connect(liveSaturator);

// Reverb send: saturator splits into dry + convolver-wet, mixed together
liveSaturator.connect(liveDryGain);
liveSaturator.connect(liveConvolver);
liveConvolver.connect(liveReverbGain);
liveDryGain.connect(liveReverbMerge);
liveReverbGain.connect(liveReverbMerge);

// Stereo widener: split → per-channel delay → merge
liveReverbMerge.connect(liveSplitter);
liveSplitter.connect(liveDelayL, 0);
liveSplitter.connect(liveDelayR, 1);
liveDelayL.connect(liveMerger, 0, 0);
liveDelayR.connect(liveMerger, 0, 1);

liveMerger.connect(liveMakeupGain);
liveMakeupGain.connect(analyser);
analyser.connect(audioCtx.destination);

// FX state management
let liveFxActive = false;

function setLiveFxEnabled(enabled) {
    const now = audioCtx.currentTime;
    const ramp = 0.08;

    if (enabled && !liveFxActive) {
        // Activate FX chain
        liveCompressor.threshold.setTargetAtTime(-18, now, ramp);
        liveCompressor.ratio.setTargetAtTime(10, now, ramp);

        liveSaturator.curve = buildSaturationCurve(8);

        liveReverbGain.gain.setTargetAtTime(0.28, now, ramp);
        liveDryGain.gain.setTargetAtTime(0.82, now, ramp);

        liveDelayL.delayTime.setTargetAtTime(0.012, now, ramp);  // 12ms left offset
        liveDelayR.delayTime.setTargetAtTime(0.0, now, ramp);    // right stays centered

        liveMakeupGain.gain.setTargetAtTime(1.35, now, ramp);

        liveFxActive = true;
    } else if (!enabled && liveFxActive) {
        // Bypass: make FX chain transparent
        liveCompressor.threshold.setTargetAtTime(0, now, ramp);
        liveCompressor.ratio.setTargetAtTime(1, now, ramp);

        liveSaturator.curve = null; // linear pass-through

        liveReverbGain.gain.setTargetAtTime(0, now, ramp);
        liveDryGain.gain.setTargetAtTime(1, now, ramp);

        liveDelayL.delayTime.setTargetAtTime(0, now, ramp);
        liveDelayR.delayTime.setTargetAtTime(0, now, ramp);

        liveMakeupGain.gain.setTargetAtTime(1.0, now, ramp);

        liveFxActive = false;
    }
}

applyEqualizerPreset(currentEqualizerPreset);

let isSwitchingTrack = false;

audio.onplay = () => {
    isSwitchingTrack = false;
    syncPlaybackUI(true);
    if (audioCtx.state === 'suspended') {
        audioCtx.resume().catch(e => console.error('AudioContext resume failed', e));
    }
};

audio.onpause = () => {
    // 曲の切り替え中やシーク操作中の一時停止によるUIチラつきを防ぐ
    if (isSwitchingTrack || (isSeeking && wasPlayingBeforeSeek)) return;
    syncPlaybackUI(false);
};

audio.onerror = (e) => {
    console.warn('Audio playback error:', currentPlayingFilePath, e);
    isSwitchingTrack = false;
    syncPlaybackUI(false);
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
                        album: meta.album,
                        albumArtist: meta.albumArtist,
                        trackNumber: meta.trackNumber,
                        diskNumber: meta.diskNumber || 1,
                        genres: meta.genres,
                        duration: meta.duration
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

    // Validate restored playlist identifiers
    if (currentViewedPlaylistId !== 'all' && currentViewedPlaylistId !== 'favorites' && !customPlaylists[currentViewedPlaylistId]) {
        currentViewedPlaylistId = 'all';
    }
    if (currentPlayingSourceId !== 'all' && currentPlayingSourceId !== 'favorites' && !customPlaylists[currentPlayingSourceId]) {
        currentPlayingSourceId = 'all';
    }

    const sourceSongs = getPlaylistSongs(currentPlayingSourceId);
    const validSongs = (sourceSongs && sourceSongs.length > 0) ? sourceSongs : allSongs;
    const initialSongs = (currentPlayingSourceId === 'all' && currentSortMode !== 'none') ? applySortToSongs(validSongs) : [...validSongs];
    playlist = [...initialSongs];
    cacheAllMetadata();
    renderTabs();
    renderPlaylist();

    const lastSong = localStorage.getItem('player_lastSong');
    const lastPos = parseFloat(localStorage.getItem('player_lastPosition') || '0');

    let songIndex = -1;
    if (lastSong && playlist.includes(lastSong)) {
        songIndex = playlist.indexOf(lastSong);
    } else if (playlist.length > 0) {
        songIndex = 0;
    }

    if (songIndex >= 0) {
        currentSongIndex = songIndex;
        if (!isNaN(lastPos) && lastPos > 0) {
            pendingRestorePosition = lastPos;
        }
        await loadSong(currentSongIndex, false);
    }

    // 再生元と表示中のプレイリストが異なる場合も、前回の表示を復元する。
    if (currentViewedPlaylistId !== currentPlayingSourceId) {
        playlist = getPlaylistSongs(currentViewedPlaylistId);
        if (currentViewedPlaylistId === 'all' && currentSortMode !== 'none') {
            playlist = applySortToSongs(playlist);
        }
        currentSongIndex = currentPlayingFilePath ? playlist.indexOf(currentPlayingFilePath) : -1;
        renderPlaylist();
        updatePlaylistHighlight();
    }
}

function applySortToSongs(songs) {
    if (currentViewedPlaylistId !== 'all' || currentSortMode === 'none') {
        return [...songs];
    }
    if (currentSortMode === 'track') {
        return [...songs].sort(compareSongsByTrack);
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
                metadataCache[file] = {
                    title: metaResult.title,
                    artist: metaResult.artist,
                    album: metaResult.album,
                    albumArtist: metaResult.albumArtist,
                    trackNumber: metaResult.trackNumber,
                    diskNumber: metaResult.diskNumber || 1,
                    genres: metaResult.genres,
                    duration: metaResult.duration
                };
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
            savePlaybackState();
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
        updateMainIslandTagMatches();
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
    updateMainIslandTagMatches();
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

    const shouldPlay = (autoPlay !== null) ? autoPlay : isPlaying;
    isSwitchingTrack = true;

    if (currentPlayingFilePath === file && audio.src) {
        audio.currentTime = 0;
        if (shouldPlay) {
            audio.play().catch(e => {
                console.error(e);
                syncPlaybackUI(false);
            });
        } else {
            audio.pause();
            syncPlaybackUI(false);
        }
        setTimeout(() => { isSwitchingTrack = false; }, 80);
        return;
    }

    currentLoadId++;
    const loadId = currentLoadId;

    currentPlayingFilePath = file;
    currentAudioUsesSox = false;
    audio.src = getAudioFileUrl(file);
    seekBar.value = 0;
    seekBar.style.setProperty('--progress', `0%`);
    seekBar.title = '0:00';

    loadSongAbLoopForCurrentFile();

    updatePlaylistHighlight();
    updateMainFavoriteButton();

    if (shouldPlay) {
        recordSongPlay(file);
        savePlaybackState();
        audio.play().catch(e => {
            console.error(e);
            syncPlaybackUI(false);
        }).finally(() => {
            setTimeout(() => { isSwitchingTrack = false; }, 100);
        });
    } else {
        audio.pause();
        isSwitchingTrack = false;
        syncPlaybackUI(false);
        savePlaybackState();
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
        album: meta.album,
        albumArtist: meta.albumArtist || meta.artist || '',
        trackNumber: meta.trackNumber || 0,
        albumTrackCount: meta.albumTrackCount || 0,
        genres: meta.genres || '',
        picture: meta.picture,
        duration: audio.duration || meta.duration || 0,
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

    // Windows SMTC (GlobalSystemMediaTransportControlsSessionManager) 用に Web MediaSession を同期
    updateWebMediaSession(meta);
}

function updateWebMediaSession(meta) {
    if (!('mediaSession' in navigator)) return;
    try {
        const artwork = [];
        if (meta && meta.picture) {
            artwork.push({
                src: meta.picture,
                sizes: '512x512',
                type: 'image/png'
            });
        }
        navigator.mediaSession.metadata = new MediaMetadata({
            title: (meta && meta.title) || 'Unknown Title',
            artist: (meta && meta.artist) || 'Unknown Artist',
            album: (meta && meta.album) || '',
            artwork: artwork
        });
        navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
        updateWebMediaSessionPosition();
    } catch (e) {
        console.error('[MediaSession] Metadata update error:', e);
    }
}

function updateWebMediaSessionPosition() {
    if (!('mediaSession' in navigator) || !('setPositionState' in navigator.mediaSession)) return;
    try {
        if (audio.duration && !isNaN(audio.duration) && audio.duration > 0) {
            navigator.mediaSession.setPositionState({
                duration: audio.duration,
                playbackRate: audio.playbackRate || 1.0,
                position: Math.min(Math.max(audio.currentTime || 0, 0), audio.duration)
            });
        }
    } catch (e) {}
}

function initWebMediaSessionHandlers() {
    if (!('mediaSession' in navigator)) return;
    try {
        navigator.mediaSession.setActionHandler('play', () => {
            if (audio.paused) audio.play().catch(console.error);
        });
        navigator.mediaSession.setActionHandler('pause', () => {
            if (!audio.paused) audio.pause();
        });
        navigator.mediaSession.setActionHandler('previoustrack', () => {
            playPrev();
        });
        navigator.mediaSession.setActionHandler('nexttrack', () => {
            playNext();
        });
        navigator.mediaSession.setActionHandler('seekto', (details) => {
            if (details.seekTime !== undefined && details.seekTime !== null) {
                audio.currentTime = details.seekTime;
                updateWebMediaSessionPosition();
            }
        });
        navigator.mediaSession.setActionHandler('stop', () => {
            audio.pause();
            audio.currentTime = 0;
            updateWebMediaSessionPosition();
        });
    } catch (e) {
        console.warn('[MediaSession] Action handlers error:', e);
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
    if (!audio.src) {
        if (playlist.length > 0) {
            loadSong(currentSongIndex >= 0 ? currentSongIndex : 0, true);
        }
        return;
    }
    if (audio.paused) {
        audio.play().catch(e => {
            console.error(e);
            syncPlaybackUI(false);
        });
    } else {
        audio.pause();
        syncPlaybackUI(false);
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

let isSeeking = false;
let wasPlayingBeforeSeek = false;

audio.onloadedmetadata = () => {
    if (pendingRestorePosition !== null && audio.duration && isFinite(audio.duration)) {
        audio.currentTime = Math.min(pendingRestorePosition, Math.max(0, audio.duration - 0.25));
        pendingRestorePosition = null;
        savePlaybackState();
    }
    if (audio.duration && isFinite(audio.duration)) {
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
        audio.play().catch(e => {
            console.error(e);
            syncPlaybackUI(false);
        });
        return;
    }

    if (loopMode === 'one') {
        audio.currentTime = 0;
        audio.play().catch(e => {
            console.error(e);
            syncPlaybackUI(false);
        });
    } else if (loopMode === 'all') {
        playNext();
    } else {
        if (shuffleMode || currentSongIndex < playlist.length - 1) {
            playNext();
        } else {
            syncPlaybackUI(false);
            if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'none';
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

    if (!isSeeking && audio.duration && isFinite(audio.duration) && audio.duration > 0) {
        const progress = (audio.currentTime / audio.duration) * 100;
        seekBar.value = progress || 0;
        seekBar.style.setProperty('--progress', `${progress || 0}%`);
        seekBar.title = `${formatSecondsToMSS(audio.currentTime)} / ${formatSecondsToMSS(audio.duration)}`;
    }

    // Throttle position-change to SMTC (every ~2 seconds during playback)
    const now = Date.now();
    if (!audio._lastPositionSend || (now - audio._lastPositionSend > 2000)) {
        audio._lastPositionSend = now;
        savePlaybackState();
        ipcRenderer.send('position-change', {
            position: audio.currentTime || 0,
            duration: audio.duration || 0
        });
    }
};

window.addEventListener('beforeunload', savePlaybackState);
window.addEventListener('pagehide', savePlaybackState);

const applySeek = () => {
    if (!audio.duration || !isFinite(audio.duration)) return;
    const time = (seekBar.value / 100) * audio.duration;
    audio.currentTime = time;
    savePlaybackState();
    seekBar.title = `${formatSecondsToMSS(time)} / ${formatSecondsToMSS(audio.duration)}`;
    ipcRenderer.send('position-change', {
        position: audio.currentTime || 0,
        duration: audio.duration || 0
    });
};

seekBar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    isSeeking = true;
    wasPlayingBeforeSeek = !audio.paused;
    if (wasPlayingBeforeSeek) {
        audio.pause();
    }
});

seekBar.oninput = () => {
    isSeeking = true;
    seekBar.style.setProperty('--progress', `${seekBar.value}%`);
    if (audio.duration && isFinite(audio.duration)) {
        const time = (seekBar.value / 100) * audio.duration;
        audio.currentTime = time;
        seekBar.title = `${formatSecondsToMSS(time)} / ${formatSecondsToMSS(audio.duration)}`;
    }
};

const finishSeek = () => {
    if (!isSeeking) return;
    isSeeking = false;
    applySeek();
    if (wasPlayingBeforeSeek) {
        wasPlayingBeforeSeek = false;
        audio.play().catch(e => {
            console.error(e);
            syncPlaybackUI(false);
        });
    }
};

seekBar.addEventListener('change', finishSeek);
seekBar.addEventListener('pointerup', finishSeek);
window.addEventListener('pointerup', () => {
    if (isSeeking) finishSeek();
});

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
        // 展開中にスライダー本体をクリックした場合は閉じる処理（トグル）を防ぐ
        if (volWrapper.classList.contains('open') && e.target.id === 'volume-bar') return;
        volWrapper.classList.toggle('open');
    };
}

function updateVolumeBarTooltip(vol) {
    if (!volumeBar) return;
    const v = (typeof vol === 'number') ? vol : parseFloat(volumeBar.value);
    const percent = Math.round((isNaN(v) ? 0.25 : v) * 100);
    volumeBar.title = `${percent}%`;
}

// 展開されていない状態での誤タッチ・誤クリックを完全に遮断
volumeBar.addEventListener('pointerdown', (e) => {
    if (!volWrapper.classList.contains('open')) {
        e.preventDefault();
        e.stopPropagation();
    }
});

volumeBar.addEventListener('pointerenter', () => {
    updateVolumeBarTooltip();
});

volumeBar.addEventListener('wheel', (e) => {
    if (!volWrapper.classList.contains('open')) return;
    e.preventDefault();
    const step = 0.05;
    const current = parseFloat(volumeBar.value) || 0;
    const next = Math.max(0, Math.min(1, current + (e.deltaY < 0 ? step : -step)));
    const rounded = Math.round(next * 100) / 100;
    volumeBar.value = rounded;
    audio.volume = rounded;
    volumeBar.style.setProperty('--progress', `${rounded * 100}%`);
    updateVolumeBarTooltip(rounded);

    if (_saveVolTimer) clearTimeout(_saveVolTimer);
    _saveVolTimer = setTimeout(() => {
        try { localStorage.setItem('player_volume', String(rounded)); } catch (err) {}
        _saveVolTimer = null;
    }, 500);
}, { passive: false });

// Initialize volume from storage (default 25%) and keep UI in sync
(() => {
    const stored = localStorage.getItem('player_volume');
    const initial = (stored !== null) ? parseFloat(stored) : 0.25;
    const clamped = Math.max(0, Math.min(1, isNaN(initial) ? 0.25 : initial));
    volumeBar.value = clamped;
    audio.volume = clamped;
    volumeBar.style.setProperty('--progress', `${clamped * 100}%`);
    updateVolumeBarTooltip(clamped);
})();

// Persist volume with debounce to avoid stressing storage
let _saveVolTimer = null;
volumeBar.oninput = () => {
    if (!volWrapper.classList.contains('open')) {
        // 閉じている最中・閉じた状態の誤操作は復元して無視
        volumeBar.value = audio.volume;
        return;
    }
    const v = parseFloat(volumeBar.value);
    audio.volume = v;
    volumeBar.style.setProperty('--progress', `${v * 100}%`);
    updateVolumeBarTooltip(v);
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
    updateShuffleUI();
    try { localStorage.setItem('player_shuffleMode', JSON.stringify(shuffleMode)); } catch (e) {}
};

loopBtn.onclick = () => {
    if (loopMode === 'off') {
        loopMode = 'one';
    } else if (loopMode === 'one') {
        loopMode = 'all';
    } else {
        loopMode = 'off';
    }
    updateLoopUI();
    try { localStorage.setItem('player_loopMode', loopMode); } catch (e) {}
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
            updateMainIslandTagMatches();
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
                updateMainIslandTagMatches();
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
        if (activeDropdownCloser) {
            closeActiveDropdown();
            e.stopPropagation();
        } else if (contextMenu && contextMenu.style.display === 'block') {
            hideContextMenu();
            e.stopPropagation();
        }
    }
});

if (searchInput) {
    searchInput.oninput = (e) => {
        currentSearchQuery = e.target.value;
        renderPlaylist();
        updateMainIslandTagMatches();
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

function refreshSearchPlaylist(playlistName, triggerBtn = null) {
    const query = playlistSearchQueries[playlistName];
    if (!query) return;

    const getBtn = () => {
        if (triggerBtn && triggerBtn.isConnected) return triggerBtn;
        const escapedId = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(playlistName) : playlistName.replace(/["\\]/g, '\\$&');
        const targetTab = document.querySelector(`.playlist-tabs .playlist-tab[data-playlist-id="${escapedId}"]`);
        return targetTab ? targetTab.querySelector('.tab-refresh-btn') : null;
    };

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
        const btn = getBtn();
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
    const btn = getBtn();
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
        updateVolumeBarTooltip(rounded);
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

// Initialize Web Media Session handlers for Windows SMTC (GSMTCSM) integration
initWebMediaSessionHandlers();
