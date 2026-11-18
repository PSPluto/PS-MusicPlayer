const assert = require('assert');

// Test the sorting logic extracted from renderer.js
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

function createComparer(metadataCache) {
    return function compareSongsByTrack(a, b) {
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
    };
}

// 1. Basic track number sorting
{
    const cache = {
        'song3.mp3': { title: 'C', album: 'Album 1', trackNumber: 3, diskNumber: 1 },
        'song1.mp3': { title: 'A', album: 'Album 1', trackNumber: 1, diskNumber: 1 },
        'song2.mp3': { title: 'B', album: 'Album 1', trackNumber: 2, diskNumber: 1 }
    };
    const list = ['song3.mp3', 'song1.mp3', 'song2.mp3'];
    list.sort(createComparer(cache));
    assert.deepStrictEqual(list, ['song1.mp3', 'song2.mp3', 'song3.mp3'], 'Track number sorting failed');
}

// 2. Multi-disc sorting
{
    const cache = {
        'd2_s1.mp3': { title: 'D2-1', album: 'Album 1', trackNumber: 1, diskNumber: 2 },
        'd1_s2.mp3': { title: 'D1-2', album: 'Album 1', trackNumber: 2, diskNumber: 1 },
        'd1_s1.mp3': { title: 'D1-1', album: 'Album 1', trackNumber: 1, diskNumber: 1 }
    };
    const list = ['d2_s1.mp3', 'd1_s2.mp3', 'd1_s1.mp3'];
    list.sort(createComparer(cache));
    assert.deepStrictEqual(list, ['d1_s1.mp3', 'd1_s2.mp3', 'd2_s1.mp3'], 'Multi-disc sorting failed');
}

// 3. Filename fallback track number
{
    const cache = {
        'C:/Music/03 - Track Three.mp3': {},
        'C:/Music/01 - Track One.mp3': {},
        'C:/Music/02 - Track Two.mp3': {}
    };
    const list = ['C:/Music/03 - Track Three.mp3', 'C:/Music/01 - Track One.mp3', 'C:/Music/02 - Track Two.mp3'];
    list.sort(createComparer(cache));
    assert.deepStrictEqual(list, [
        'C:/Music/01 - Track One.mp3',
        'C:/Music/02 - Track Two.mp3',
        'C:/Music/03 - Track Three.mp3'
    ], 'Filename fallback failed');
}

// 4. Missing track number goes to end
{
    const cache = {
        'notrack.mp3': { title: 'No Track', album: 'Album 1', trackNumber: 0 },
        'track1.mp3': { title: 'Track 1', album: 'Album 1', trackNumber: 1 }
    };
    const list = ['notrack.mp3', 'track1.mp3'];
    list.sort(createComparer(cache));
    assert.deepStrictEqual(list, ['track1.mp3', 'notrack.mp3'], 'Missing track to end failed');
}

console.log('All track sort tests passed successfully!');

