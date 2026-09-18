import {
    styleElementId,
    enterAnimationMilliseconds,
    exitSendAnimationMilliseconds,
    exitDeleteAnimationMilliseconds,
    queueHostPaddingTopPixels,
    dragHandleWidthPixels,
    queueItemPaddingPixels,
    queueTextFontSizePixels,
    queueLineHeight,
} from '../constants.js';

export function ensureAnimationStyles() {
    if (document.getElementById(styleElementId)) return;

    const style = document.createElement('style');
    style.id = styleElementId;
    style.textContent = `
      @keyframes tmqEnterFromBottom {
        from { opacity: 0; transform: translateY(10px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      @keyframes tmqExitToRight {
        from { opacity: 1; transform: translateX(0); }
        to   { opacity: 0; transform: translateX(14px); }
      }
      @keyframes tmqExitToBottom {
        from { opacity: 1; transform: translateY(0); }
        to   { opacity: 0; transform: translateY(10px); }
      }
      .tmq-enter {
        animation: tmqEnterFromBottom ${enterAnimationMilliseconds}ms ease-out both;
        will-change: transform, opacity;
      }
      .tmq-exit-send {
        animation: tmqExitToRight ${exitSendAnimationMilliseconds}ms ease-in both;
        will-change: transform, opacity;
      }
      .tmq-exit-delete {
        animation: tmqExitToBottom ${exitDeleteAnimationMilliseconds}ms ease-in both;
        will-change: transform, opacity;
      }
      @media (prefers-reduced-motion: reduce) {
        .tmq-enter, .tmq-exit-send, .tmq-exit-delete { animation-duration: 1ms; }
      }
    `;
    document.head.appendChild(style);
}

export function queueHostStyle() {
    return [
        'display:flex',
        'flex-direction:column',
        'gap:8px',
        `padding-top:${queueHostPaddingTopPixels}px`,
        'width:100%',
    ].join(';');
}

export function queueRowWrapperStyle() {
    return [
        'display:flex',
        'align-items:stretch',
        'gap:0',
        'width:100%',
        'position:relative',
    ].join(';');
}

export function dragHandleStyle() {
    return [
        'display:flex',
        'align-items:center',
        'justify-content:center',
        `width:${dragHandleWidthPixels}px`,
        'flex:0 0 auto',
        'cursor:grab',
        'opacity:.5',
        'user-select:none',
    ].join(';');
}

export function queueItemBoxStyle() {
    return [
        'flex:1 1 auto',
        'min-width:0',
        `padding:${queueItemPaddingPixels}px`,
        'border-radius:16px',
        'border:1px solid rgba(255,255,255,.10)',
        'background:rgba(255,255,255,.04)',
        'display:flex',
        'align-items:flex-start',
        'gap:8px',
    ].join(';');
}

export function queueTextStyle() {
    return [
        'flex:1 1 auto',
        'min-width:0',
        `font-size:${queueTextFontSizePixels}px`,
        `line-height:${queueLineHeight}`,
        'white-space:pre-wrap',
        'overflow-wrap:anywhere',
        'outline:none',
    ].join(';');
}

export const pillButtonStyle =
    'padding:8px 12px;border-radius:999px;border:1px solid rgba(255,255,255,.12);' +
    'background:rgba(255,255,255,.06);color:inherit;font-size:13px;cursor:pointer;user-select:none;';
