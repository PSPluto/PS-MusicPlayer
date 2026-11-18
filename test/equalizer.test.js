const assert = require('assert');

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

const EQ_BANDS = [
    { type: 'lowshelf',  frequency: 60,   q: 1 },
    { type: 'peaking',   frequency: 250,  q: 1 },
    { type: 'peaking',   frequency: 1000, q: 1 },
    { type: 'peaking',   frequency: 4000, q: 1 },
    { type: 'highshelf', frequency: 12000, q: 1 }
];

// Test 1: Preset structure and band count
assert.strictEqual(EQ_BANDS.length, 5, 'EQ should have 5 frequency bands');
Object.entries(EQUALIZER_PRESETS).forEach(([key, preset]) => {
    assert.strictEqual(preset.key, key, `Preset key should match object key for ${key}`);
    assert.strictEqual(preset.gains.length, EQ_BANDS.length, `Preset ${key} gains count must equal 5`);
    preset.gains.forEach((g) => {
        assert.ok(typeof g === 'number' && g >= -12 && g <= 12, `Gain ${g} in preset ${key} is out of safe range`);
    });
});

// Test 2: Fallback handling
function getPreset(key) {
    return EQUALIZER_PRESETS[key] || EQUALIZER_PRESETS.flat;
}
assert.strictEqual(getPreset('unknown').key, 'flat');
assert.strictEqual(getPreset('bass').key, 'bass');

// Test 3: Removed presets should fall back to flat
assert.strictEqual(getPreset('jazz').key, 'flat', 'Removed jazz preset should fall back to flat');
assert.strictEqual(getPreset('classical').key, 'flat', 'Removed classical preset should fall back to flat');
assert.strictEqual(getPreset('electronic').key, 'flat', 'Removed electronic preset should fall back to flat');

// Test 4: Radio preset exists and has mid-boost / low-high cut character
assert.ok(EQUALIZER_PRESETS.radio, 'Radio preset should exist');
const radioGains = EQUALIZER_PRESETS.radio.gains;
assert.ok(radioGains[0] < 0, 'Radio should cut low frequencies');
assert.ok(radioGains[2] > 0, 'Radio should boost mid frequencies');
assert.ok(radioGains[4] < 0, 'Radio should cut high frequencies');

// Test 5: Each preset is sufficiently distinct from every other preset
// Euclidean distance between any two presets should be >= 3
const presetKeys = Object.keys(EQUALIZER_PRESETS).filter(k => k !== 'flat');
for (let i = 0; i < presetKeys.length; i++) {
    for (let j = i + 1; j < presetKeys.length; j++) {
        const a = EQUALIZER_PRESETS[presetKeys[i]].gains;
        const b = EQUALIZER_PRESETS[presetKeys[j]].gains;
        const dist = Math.sqrt(a.reduce((sum, v, idx) => sum + (v - b[idx]) ** 2, 0));
        assert.ok(dist >= 3, `Presets ${presetKeys[i]} and ${presetKeys[j]} are too similar (distance=${dist.toFixed(2)})`);
    }
}

// Test 6: Expected preset count (flat + 6 EQ-only + 1 FX = 8)
assert.strictEqual(Object.keys(EQUALIZER_PRESETS).length, 8, 'Should have exactly 8 presets');

// Test 7: Live Stage preset properties
assert.ok(EQUALIZER_PRESETS.live, 'Live Stage preset should exist');
assert.strictEqual(EQUALIZER_PRESETS.live.fx, true, 'Live Stage should have fx flag enabled');
assert.strictEqual(EQUALIZER_PRESETS.live.gains.length, 5, 'Live Stage should have 5 EQ bands');

// Test 8: Only live preset has fx flag
Object.entries(EQUALIZER_PRESETS).forEach(([key, preset]) => {
    if (key === 'live') {
        assert.strictEqual(preset.fx, true, 'Live preset must have fx=true');
    } else {
        assert.ok(!preset.fx, `Non-live preset ${key} should not have fx flag`);
    }
});

// Test 9: Live preset EQ has boosted bass and presence (live PA character)
const liveGains = EQUALIZER_PRESETS.live.gains;
assert.ok(liveGains[0] >= 5, 'Live Stage should have strong sub-bass boost');
assert.ok(liveGains[4] >= 3, 'Live Stage should have boosted highs for air/sparkle');

console.log('All equalizer preset tests passed successfully!');
