import {
    isDragging, setIsDragging,
    dragSourceIndex, setDragSourceIndex,
    dropInsertIndex, setDropInsertIndex,
    dropLineNode, setDropLineNode,
    activeEditIndex,
    queueHostNode,
    promptQueue,
    bumpSendCancellationToken,
} from '../core/state.js';
import { moveQueueItem } from '../core/queue.js';
import { dragHandleStyle } from './styles.js';
import { t } from '../i18n/index.js';

export function clearDropLine() {
    if (dropLineNode) dropLineNode.remove();
    setDropLineNode(null);
    setDropInsertIndex(null);
}

function showDropLineAt(host, topWithinHostPixels) {
    if (!host) return;

    if (!dropLineNode) {
        const line = document.createElement('div');
        line.contentEditable = 'false';
        line.style.cssText =
            'position:absolute;pointer-events:none;height:0;left:0;right:0;' +
            'border-top:2px solid rgba(255,255,255,.25);';
        host.appendChild(line);
        setDropLineNode(line);
    }
    dropLineNode.style.top = `${Math.max(0, topWithinHostPixels)}px`;
}

function listRowWrappers(host) {
    return Array.from(host.querySelectorAll('[data-queue-row="true"]'));
}

export function onHostDragLeave(event) {
    if (!isDragging) return;
    // 移到面板内部的子元素上不算离开。
    const related = event.relatedTarget;
    if (related && queueHostNode && queueHostNode.contains(related)) return;
    clearDropLine();
}

// 按指针位置与各行中线比较，算出插入点并画出指示线。
export function onHostDragOver(event, host) {
    if (!isDragging || activeEditIndex !== null) return;
    if (!host) return;

    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';

    const wrappers = listRowWrappers(host);
    if (!wrappers.length) return;

    const hostRect = host.getBoundingClientRect();
    const mouseY = event.clientY;

    let insertIndex = wrappers.length;
    let lineY = null;

    for (let i = 0; i < wrappers.length; i++) {
        const rect = wrappers[i].getBoundingClientRect();
        const middle = rect.top + rect.height / 2;

        if (mouseY < middle) {
            insertIndex = i;
            lineY = rect.top - hostRect.top;
            break;
        }
        lineY = rect.bottom - hostRect.top;
    }

    setDropInsertIndex(insertIndex);
    showDropLineAt(host, lineY ?? 0);
}

export function onHostDrop(event, hooks = {}) {
    if (!isDragging || activeEditIndex !== null) return;

    event.preventDefault();
    event.stopPropagation();

    // 优先用内存里的源索引，丢失时回退到 dataTransfer。
    let sourceIndex = dragSourceIndex;
    if (sourceIndex === null) {
        const transferred = (() => {
            try { return event.dataTransfer.getData('text/plain'); } catch { return ''; }
        })();
        sourceIndex = transferred ? Number(transferred) : null;
    }

    if (sourceIndex === null || Number.isNaN(sourceIndex)) {
        setIsDragging(false);
        setDragSourceIndex(null);
        clearDropLine();
        return;
    }

    const rawInsertIndex = dropInsertIndex === null ? promptQueue.length : dropInsertIndex;
    const boundedInsertIndex = Math.max(0, Math.min(rawInsertIndex, promptQueue.length));

    // 先移除会让其后的目标位左移一位，需相应回退。
    let targetIndex = boundedInsertIndex;
    if (sourceIndex < targetIndex) targetIndex -= 1;

    setIsDragging(false);
    setDragSourceIndex(null);
    clearDropLine();

    moveQueueItem(sourceIndex, targetIndex);
    hooks.onQueueChanged?.();
}

export function makeDragHandle(index, hooks = {}) {
    const handle = document.createElement('div');
    handle.contentEditable = 'false';
    handle.setAttribute('role', 'button');
    handle.setAttribute('aria-label', t('queuedItemLabel', { index: index + 1 }));
    handle.setAttribute('draggable', activeEditIndex === null ? 'true' : 'false');
    handle.style.cssText = dragHandleStyle();
    handle.textContent = '⠿';

    handle.addEventListener('mouseenter', () => { handle.style.background = 'rgba(255,255,255,.10)'; });
    handle.addEventListener('mouseleave', () => { handle.style.background = 'transparent'; });

    handle.addEventListener('dragstart', (event) => {
        if (activeEditIndex !== null) { event.preventDefault(); return; }

        // 拖拽期间队列顺序会变，作废进行中的发送尝试。
        bumpSendCancellationToken();
        setIsDragging(true);
        setDragSourceIndex(index);
        clearDropLine();

        event.dataTransfer.effectAllowed = 'move';
        try { event.dataTransfer.setData('text/plain', String(index)); } catch { }

        handle.style.cursor = 'grabbing';
    }, true);

    handle.addEventListener('dragend', () => {
        handle.style.cursor = 'grab';
        setIsDragging(false);
        setDragSourceIndex(null);
        clearDropLine();
        hooks.onDragEnd?.();
    }, true);

    return handle;
}
