class DialogManager {
    constructor() {
        this.dialog = document.getElementById('playlist-dialog');
        this.title = document.getElementById('dialog-title');
        this.input = document.getElementById('dialog-input');
        this.confirmButton = document.getElementById('dialog-btn-confirm');
        this.callback = null;

        document.getElementById('dialog-btn-cancel').onclick = () => this.hide();
        this.confirmButton.onclick = () => {
            const value = this.input.value.trim();
            if (this.callback) {
                this.callback(value);
            }
            this.hide();
        };
        this.input.onkeydown = (event) => {
            if (event.key === 'Enter') {
                this.confirmButton.click();
            } else if (event.key === 'Escape') {
                this.hide();
            }
        };
    }

    show({ title, placeholder, initialValue, confirmText, hideInput, callback }) {
        this.title.textContent = title;
        this.input.value = initialValue || '';
        this.input.placeholder = placeholder || '';
        this.confirmButton.textContent = confirmText || 'OK';
        this.input.style.display = hideInput ? 'none' : 'block';
        this.dialog.style.display = 'flex';

        if (!hideInput) {
            this.input.focus();
            this.input.select();
        }

        this.callback = callback;
    }

    hide() {
        this.dialog.style.display = 'none';
        this.callback = null;
    }
}

class ContextMenuManager {
    constructor({ ipcRenderer, getCurrentPlaylistId }) {
        this.ipcRenderer = ipcRenderer;
        this.getCurrentPlaylistId = getCurrentPlaylistId;
        this.menu = document.getElementById('custom-context-menu');
        this.list = document.getElementById('context-menu-list');
        this.showToken = 0;
    }

    async show(triggerEl, items) {
        const showToken = ++this.showToken;
        if (triggerEl && triggerEl.closest && triggerEl.closest('#playlist-ul li')) {
            this.menu.dataset.playlist = this.getCurrentPlaylistId() || 'all';
        } else {
            delete this.menu.dataset.playlist;
        }

        if (!items || items.length === 0) {
            this.hide();
            return;
        }

        this.list.innerHTML = '';
        items.forEach((item) => this.renderMenuItem(item, this.list, triggerEl, items));
        if (this.list.childElementCount === 0) return;

        this.menu.classList.remove('open');
        this.menu.style.display = 'block';
        this.menu.style.visibility = 'hidden';
        this.menu.style.maxHeight = '0px';
        this.menu.style.opacity = '0';
        this.menu.style.transform = 'translateY(-8px)';
        this.menu.style.pointerEvents = 'none';

        const menuWidth = this.menu.offsetWidth;
        const menuHeight = this.menu.scrollHeight || this.menu.offsetHeight;
        const playlistEl = document.getElementById('playlist-container');
        const playlistRect = playlistEl && playlistEl.getBoundingClientRect
            ? playlistEl.getBoundingClientRect()
            : { bottom: window.innerHeight - 8 };
        const playlistStyle = window.getComputedStyle(playlistEl);
        const paddingBottom = parseFloat(playlistStyle.paddingBottom) || 0;
        const borderBottom = parseFloat(playlistStyle.borderBottomWidth) || 0;
        const targetBottom = playlistRect.bottom - paddingBottom - borderBottom;

        let y = targetBottom - menuHeight;
        if (y < 8) y = 8;

        const shadowBottom = y + menuHeight + 12;
        const extraHeight = Math.max(0, Math.ceil(shadowBottom - window.innerHeight));
        await this.ipcRenderer.invoke('expand-for-context-menu', menuWidth, extraHeight);
        if (showToken !== this.showToken) return;

        const playlistElAfter = document.getElementById('playlist-container');
        const playlistRectAfter = playlistElAfter && playlistElAfter.getBoundingClientRect
            ? playlistElAfter.getBoundingClientRect()
            : { bottom: window.innerHeight - 8 };
        const playlistStyleAfter = window.getComputedStyle(playlistElAfter);
        const paddingBottomAfter = parseFloat(playlistStyleAfter.paddingBottom) || 0;
        const borderBottomAfter = parseFloat(playlistStyleAfter.borderBottomWidth) || 0;
        const targetBottomAfter = playlistRectAfter.bottom - paddingBottomAfter - borderBottomAfter;

        let bottomOffset = window.innerHeight - targetBottomAfter;
        if (bottomOffset < 8) bottomOffset = 8;

        this.menu.style.left = '372px';
        this.menu.style.top = 'auto';
        this.menu.style.bottom = `${bottomOffset}px`;
        this.menu.style.visibility = '';

        try {
            void this.menu.offsetHeight;
            this.menu.style.maxHeight = 'none';
            this.menu.style.opacity = '1';
            this.menu.style.transform = 'translateY(0)';
            this.menu.style.pointerEvents = 'auto';
            this.menu.classList.add('open');
        } catch (error) {
            // The menu can still be dismissed if its opening animation fails.
        }
    }

    renderMenuItem(item, parent, triggerEl, items) {
        if (item.type === 'separator') {
            const li = document.createElement('li');
            li.className = 'context-menu-separator';
            parent.appendChild(li);
            return;
        }

        if (item.type === 'header') {
            const li = document.createElement('li');
            li.className = 'context-menu-header';
            li.textContent = item.label;
            parent.appendChild(li);
            return;
        }

        if (item.type === 'submenu') {
            const li = document.createElement('li');
            li.className = 'context-menu-submenu-header';
            const inner = document.createElement('span');
            inner.className = 'context-menu-item-inner';
            if (item.icon) {
                const iconImg = document.createElement('img');
                iconImg.src = item.icon;
                iconImg.className = 'context-menu-icon';
                inner.appendChild(iconImg);
            }

            const label = document.createElement('span');
            label.textContent = item.label;
            inner.appendChild(label);
            const chevron = document.createElement('span');
            chevron.className = 'context-menu-submenu-chevron';
            chevron.textContent = item.expanded ? '▾' : '▸';
            inner.appendChild(chevron);
            li.appendChild(inner);
            li.onclick = (event) => {
                event.preventDefault();
                event.stopPropagation();
                item.expanded = !item.expanded;
                this.show(triggerEl, items);
            };
            parent.appendChild(li);

            const childrenWrap = document.createElement('div');
            childrenWrap.className = 'context-menu-submenu-children';
            childrenWrap.classList.toggle('expanded', !!item.expanded);
            parent.appendChild(childrenWrap);
            (item.children || []).forEach((child) => {
                this.renderMenuItem(child, childrenWrap, triggerEl, items);
            });
            requestAnimationFrame(() => {
                childrenWrap.style.maxHeight = item.expanded ? `${childrenWrap.scrollHeight}px` : '0px';
                childrenWrap.style.opacity = item.expanded ? '1' : '0';
            });
            return;
        }

        const li = document.createElement('li');
        const inner = document.createElement('span');
        inner.className = 'context-menu-item-inner';
        if (item.indent) {
            const indentImg = document.createElement('img');
            indentImg.src = 'assets/indent.svg';
            indentImg.className = 'context-menu-icon-indent';
            inner.appendChild(indentImg);
        }
        if (item.icon) {
            const iconImg = document.createElement('img');
            iconImg.src = item.icon;
            iconImg.className = 'context-menu-icon';
            inner.appendChild(iconImg);
        }
        const label = document.createElement('span');
        label.textContent = item.label;
        inner.appendChild(label);
        li.appendChild(inner);
        li.onclick = (event) => {
            event.stopPropagation();
            item.action();
            this.hide();
        };
        parent.appendChild(li);
    }

    hide() {
        if (this.menu.style.display === 'none') return;
        this.showToken++;
        const hideToken = this.showToken;
        this.menu.classList.remove('open');
        this.menu.style.maxHeight = '0px';
        this.menu.style.opacity = '0';
        this.menu.style.transform = 'translateY(-8px)';
        this.menu.style.pointerEvents = 'none';
        try {
            const appEl = document.getElementById('app');
            const appStyles = appEl ? getComputedStyle(appEl) : null;
            const gradientHeight = appStyles
                ? appStyles.getPropertyValue('--gradient-height') || '210px'
                : '210px';
            this.menu.style.backgroundSize = `100% ${gradientHeight.trim()}`;
        } catch (error) { }

        setTimeout(() => {
            if (hideToken === this.showToken) {
                this.menu.style.display = 'none';
                this.ipcRenderer.invoke('collapse-after-context-menu');
            }
        }, 320);
    }
}

module.exports = { ContextMenuManager, DialogManager };