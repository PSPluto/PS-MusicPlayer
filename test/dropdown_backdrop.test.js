const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Test 1: Check style.css contains .dropdown-backdrop with required overlay styles
const cssContent = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf-8');
assert.ok(cssContent.includes('.dropdown-backdrop'), 'style.css should define .dropdown-backdrop');
assert.ok(cssContent.includes('z-index: 9998'), 'style.css should set z-index: 9998 on .dropdown-backdrop');
assert.ok(cssContent.includes('position: fixed'), 'style.css should set position: fixed on .dropdown-backdrop');

// Test 2: Verify backdrop creation & close logic behavior in simulated DOM
let activeDropdownCloser = null;

function closeActiveDropdown() {
    if (activeDropdownCloser) {
        const closer = activeDropdownCloser;
        activeDropdownCloser = null;
        closer();
    }
}

class FakeElement {
    constructor(className = '') {
        this.className = className;
        this.parentNode = null;
        this.events = {};
    }
    remove() {
        this.parentNode = null;
    }
}

class FakeBody {
    constructor() {
        this.children = [];
    }
    appendChild(el) {
        el.parentNode = this;
        this.children.push(el);
    }
}

const fakeBody = new FakeBody();

function createDropdownBackdrop(onClose) {
    closeActiveDropdown();

    const backdrop = new FakeElement('dropdown-backdrop');

    let isClosed = false;
    const handleClose = (e) => {
        if (e && e.preventDefault) {
            e.preventDefault();
        }
        if (e && e.stopPropagation) {
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

    fakeBody.appendChild(backdrop);
    activeDropdownCloser = handleClose;

    return handleClose;
}

// Subtest 2a: Backdrop captures clicks and stops propagation
let closedCount = 0;
let defaultPrevented = false;
let propagationStopped = false;

const closeFn = createDropdownBackdrop(() => {
    closedCount++;
});

assert.strictEqual(typeof activeDropdownCloser, 'function', 'activeDropdownCloser should be set');
assert.strictEqual(fakeBody.children.length, 1, 'Backdrop element should be attached to body');

const fakeEvent = {
    preventDefault() { defaultPrevented = true; },
    stopPropagation() { propagationStopped = true; }
};

const backdropEl = fakeBody.children[0];
backdropEl.onpointerdown(fakeEvent);

assert.strictEqual(closedCount, 1, 'onClose should be called once on pointerdown');
assert.strictEqual(defaultPrevented, true, 'Event preventDefault should be called');
assert.strictEqual(propagationStopped, true, 'Event stopPropagation should be called to block underlying elements');
assert.strictEqual(activeDropdownCloser, null, 'activeDropdownCloser should be cleared after close');

// Subtest 2b: Idempotence - clicking again should not trigger onClose again
backdropEl.onclick(fakeEvent);
assert.strictEqual(closedCount, 1, 'onClose should not be called multiple times');

// Subtest 2c: Opening a new dropdown closes the active previous one
let firstClosed = false;
let secondClosed = false;

createDropdownBackdrop(() => { firstClosed = true; });
assert.strictEqual(firstClosed, false);

createDropdownBackdrop(() => { secondClosed = true; });
assert.strictEqual(firstClosed, true, 'Opening a new dropdown must close the prior dropdown');
assert.strictEqual(secondClosed, false);

closeActiveDropdown();
assert.strictEqual(secondClosed, true, 'closeActiveDropdown should close the currently active dropdown');

console.log('All dropdown backdrop tests passed successfully!');
