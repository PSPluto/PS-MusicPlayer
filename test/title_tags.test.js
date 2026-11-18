const assert = require('assert');

// Test formatPlaylistTitleParts matching the logic in renderer.js
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

// 1. Simple title without tags
{
    const res = formatPlaylistTitleParts('My Favorite Song');
    assert.strictEqual(res.titleText, 'My Favorite Song');
    assert.deepStrictEqual(res.tagParts, []);
}

// 2. Title with parenthesis tags
{
    const res = formatPlaylistTitleParts('Lemon (TV Size)');
    assert.strictEqual(res.titleText, 'Lemon');
    assert.deepStrictEqual(res.tagParts, ['TV Size']);
}

// 3. Title with bracket tags
{
    const res = formatPlaylistTitleParts('Subtitle [Official Audio]');
    assert.strictEqual(res.titleText, 'Subtitle');
    assert.deepStrictEqual(res.tagParts, ['Official Audio']);
}

// 4. Title with trailing hyphen tags
{
    const res = formatPlaylistTitleParts('Pretender - Instrumental');
    assert.strictEqual(res.titleText, 'Pretender');
    assert.deepStrictEqual(res.tagParts, ['Instrumental']);
}

// 5. Title with multiple combined tags
{
    const res = formatPlaylistTitleParts('Kick Back (Live) [Hi-Res] - 2024 Remaster');
    assert.strictEqual(res.titleText, 'Kick Back');
    assert.deepStrictEqual(res.tagParts, ['Live', 'Hi-Res', '2024 Remaster']);
}

// 6. Default placeholder / empty string
{
    const resEmpty = formatPlaylistTitleParts('');
    assert.strictEqual(resEmpty.titleText, '');
    assert.deepStrictEqual(resEmpty.tagParts, []);

    const resDefault = formatPlaylistTitleParts('曲を選択してください');
    assert.strictEqual(resDefault.titleText, '曲を選択してください');
    assert.deepStrictEqual(resDefault.tagParts, []);
}

// 7. Word with hyphen should not be split as tag
{
    const res = formatPlaylistTitleParts('Non-Stop Music');
    assert.strictEqual(res.titleText, 'Non-Stop Music');
    assert.deepStrictEqual(res.tagParts, []);
}

console.log('All title tag extraction tests passed successfully!');
