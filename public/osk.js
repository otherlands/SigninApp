'use strict';
// On-screen keyboard for the door kiosk (v4.1). The Pi kiosk runs Chromium inside `cage`, where there is no system
// on-screen keyboard (Chromium has none of its own on Linux), so text fields on the touch screen need this one.
// Switched on PER DEVICE: the kiosk installer opens the page once with ?osk=1 (remembered in that browser);
// ?osk=0 switches it off. Phones and PCs never see it - they have their own keyboards.
// It types into the focused field exactly like a keyboard would for the page's own code: text is inserted at the cursor
// and an `input` event fires (so the kiosk name search filters as you type); Enter sends the same Enter key the page
// already handles and otherwise submits the field's form.
(() => {
    const KEY = 'osk';
    const q = new URLSearchParams(location.search);
    if (q.has('osk')) { if (q.get('osk') === '1') localStorage.setItem(KEY, '1'); else localStorage.removeItem(KEY); }
    if (localStorage.getItem(KEY) !== '1') return;

    const TYPES = new Set(['text', 'search', 'tel', 'email', 'url', '']);
    const eligible = (el) => el && ((el.tagName === 'INPUT' && TYPES.has((el.getAttribute('type') || '').toLowerCase())) || el.tagName === 'TEXTAREA') && !el.readOnly && !el.disabled;
    const ROWS = [
        ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', 'Backspace'],
        ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p', "'"],
        ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', '-', 'Enter'],
        ['Shift', 'z', 'x', 'c', 'v', 'b', 'n', 'm', '.', '@', '&'],
        ['Space', 'Hide']
    ];
    const LABEL = { Backspace: '⌫', Enter: 'Enter ↵', Shift: '⇧ Shift', Space: 'space', Hide: 'Hide ⌨' };

    const css = document.createElement('style');
    css.textContent = `
      .osk { position: fixed; left: 0; right: 0; bottom: 0; z-index: 1000; background: #0b1020; border-top: 1px solid #2a3350;
             padding: 8px 8px 10px; display: none; user-select: none; -webkit-user-select: none; touch-action: manipulation; }
      .osk.show { display: block; }
      .osk-row { display: flex; gap: 6px; margin: 6px 0; justify-content: center; }
      .osk button { flex: 1 1 0; min-width: 0; height: 52px; margin: 0; padding: 0; font-size: 1.35rem; border-radius: 10px;
                    background: #1b2340; color: #fff; border: 1px solid #2f3a62; box-shadow: none; }
      .osk button:active, .osk button.down { background: #3a4a85; }
      .osk button.wide { flex: 2.2 1 0; font-size: 1.05rem; }
      .osk button.space { flex: 7 1 0; }
      .osk button.on { background: #4c5fd5; }`;
    document.head.append(css);

    const kb = document.createElement('div');
    kb.className = 'osk'; kb.setAttribute('aria-hidden', 'true'); kb.dataset.osk = '1';
    let shift = false; let target = null;
    for (const row of ROWS) {
        const r = document.createElement('div'); r.className = 'osk-row';
        for (const k of row) {
            const b = document.createElement('button');
            b.type = 'button'; b.tabIndex = -1; b.dataset.key = k;
            b.textContent = LABEL[k] || k;
            if (['Backspace', 'Enter', 'Shift', 'Hide'].includes(k)) b.classList.add('wide');
            if (k === 'Space') b.classList.add('space');
            r.append(b);
        }
        kb.append(r);
    }
    document.body.append(kb);

    // Keys act on POINTERDOWN, which every finger, mouse and pen press produces. Not on `click`: cancelling touchstart
    // (needed so a tap never takes focus from the field) also cancels the click a touch would have produced, so a
    // click-driven key never fires under a finger (found on the kiosk 2026-10-20). mousedown/touchstart are cancelled
    // only to keep focus in the field and stop the page scrolling or zooming under the keyboard.
    for (const ev of ['mousedown', 'touchstart']) kb.addEventListener(ev, (e) => e.preventDefault(), { passive: false });

    const capsFor = (el) => {
        // Capitalise the first letter of each word in fields that ask for it (names), and the whole vehicle field.
        if (el.id === 'vehicle' || el.style.textTransform === 'uppercase') return 'all';
        if ((el.getAttribute('autocapitalize') || '') === 'words') return 'words';
        return 'none';
    };
    const refreshShift = () => {
        for (const b of kb.querySelectorAll('button')) {
            const k = b.dataset.key;
            if (k.length === 1 && /[a-z]/.test(k)) b.textContent = shift ? k.toUpperCase() : k;
            if (k === 'Shift') b.classList.toggle('on', shift);
        }
    };
    const autoShift = () => {
        if (!target) return;
        const mode = capsFor(target); const before = target.value.slice(0, target.selectionStart ?? target.value.length);
        shift = mode === 'all' || (mode === 'words' && (before === '' || /\s$/.test(before)));
        refreshShift();
    };
    const fireInput = () => target.dispatchEvent(new Event('input', { bubbles: true }));
    const insert = (text) => {
        const el = target; const start = el.selectionStart ?? el.value.length; const end = el.selectionEnd ?? start;
        if (el.maxLength > 0 && el.value.length - (end - start) + text.length > el.maxLength) return;
        el.setRangeText(text, start, end, 'end'); fireInput();
    };
    const backspace = () => {
        const el = target; const start = el.selectionStart ?? el.value.length; const end = el.selectionEnd ?? start;
        if (start !== end) el.setRangeText('', start, end, 'end'); else if (start > 0) el.setRangeText('', start - 1, start, 'end'); else return;
        fireInput();
    };
    // Inside a form, Enter moves to the next text field (the keyboard covers the lower half of the screen, so the next
    // field is often under it and cannot be tapped); on the last field it submits. Outside a form it is a plain Enter.
    const nextField = (el) => {
        if (!el.form) return null;
        const fields = [...el.form.elements].filter(eligible);
        return fields[fields.indexOf(el) + 1] || null;
    };
    const enter = () => {
        const el = target;
        const ok = el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
        if (!ok || !el.form) return;
        const next = nextField(el);
        if (next) { next.focus({ preventScroll: true }); show(next); return; }
        hide(); el.form.requestSubmit();
    };

    kb.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        const b = e.target.closest('button'); if (!b || !target) return;
        b.classList.add('down'); setTimeout(() => b.classList.remove('down'), 120);
        const k = b.dataset.key;
        if (document.activeElement !== target) target.focus({ preventScroll: true });
        if (k === 'Hide') { target.blur(); hide(); return; }
        if (k === 'Shift') { shift = !shift; refreshShift(); return; }
        if (k === 'Backspace') backspace();
        else if (k === 'Enter') { enter(); return; }
        else if (k === 'Space') insert(' ');
        else insert(shift && /[a-z]/.test(k) ? k.toUpperCase() : k);
        autoShift();
    });

    function show(el) {
        target = el; kb.classList.add('show');
        document.body.style.paddingBottom = `${kb.offsetHeight + 12}px`;
        kb.querySelector('button[data-key="Enter"]').textContent = nextField(el) ? 'Next ↵' : 'Enter ↵';
        autoShift();
        // Keep the field in the part of the screen the keyboard does not cover.
        const r = el.getBoundingClientRect(); const room = window.innerHeight - kb.offsetHeight;
        if (r.top < 8 || r.bottom > room - 8) window.scrollBy({ top: r.top - Math.max(8, (room - r.height) / 2), behavior: 'instant' });
    }
    function hide() { kb.classList.remove('show'); document.body.style.paddingBottom = ''; target = null; }

    document.addEventListener('focusin', (e) => { if (eligible(e.target)) show(e.target); });
    document.addEventListener('focusout', () => setTimeout(() => { if (!eligible(document.activeElement)) hide(); }, 150));
    // A field already focused when the page loads (e.g. autofocus) gets the keyboard too.
    if (eligible(document.activeElement)) show(document.activeElement);
    window.SI_OSK = { show, hide, get visible() { return kb.classList.contains('show'); } };
})();
