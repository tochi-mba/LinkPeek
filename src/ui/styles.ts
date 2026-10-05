/** The viewer's CSS, injected into its Shadow DOM. REX ink/signal tokens only. */
import {REX, rexCss} from "../shared/theme";

export const overlayCss = `${rexCss}
.lp-root { position: fixed; z-index: 2147483647; pointer-events: none; color: ${REX.text}; }

/* Panel */
.lp-panel {
  pointer-events: auto; position: fixed; display: flex; flex-direction: column;
  width: min(var(--lp-width, 480px), calc(100vw - 24px));
  max-height: min(var(--lp-maxh, 70vh), calc(100vh - 24px));
  background: rgba(17, 21, 18, .97); border: 1px solid ${REX.line}; border-radius: 18px;
  box-shadow: 0 24px 80px rgba(0, 0, 0, .55); overflow: hidden; backdrop-filter: blur(16px);
  animation: lp-in .16s ease-out;
}
.lp-panel.lp-expanded {
  left: 50% !important; top: 50% !important; transform: translate(-50%, -50%); animation: none;
  width: min(var(--lp-expandedw, 92vw), calc(100vw - 16px)) !important;
  height: min(var(--lp-expandedh, 92vh), calc(100vh - 16px)) !important;
  max-height: var(--lp-expandedh, 92vh);
}
@keyframes lp-in { from { opacity: 0; transform: translateY(4px) scale(.985); } to { opacity: 1; transform: none; } }

/* Header */
.lp-head {
  min-height: 52px; flex-shrink: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 4px;
  padding: 6px 10px; border-bottom: 1px solid ${REX.line}; cursor: grab; touch-action: none;
}
.lp-manipulating .lp-head { cursor: grabbing; }
.lp-title { flex: 1 1 100%; min-width: 0; padding: 2px 4px; font-size: 13px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lp-meta { margin-right: auto; font: 700 11px ui-monospace, monospace; color: ${REX.muted}; }
.lp-btn {
  min-width: 40px; height: 40px; display: grid; place-items: center; font-size: 16px; cursor: pointer;
  border: 1px solid transparent; border-radius: 10px; background: transparent; color: ${REX.muted};
}
.lp-btn:hover, .lp-btn[aria-pressed="true"] { color: ${REX.signal}; background: ${REX.raised}; border-color: ${REX.line}; }

/* Focus stage */
.lp-stage {
  position: relative; height: var(--lp-stageh, 54vh); min-height: 0; flex: 1 1 auto;
  background: #050605; overflow: hidden; touch-action: none; cursor: default;
}
.lp-stage.lp-dragging { cursor: grabbing; }
.lp-expanded .lp-stage { height: calc(var(--lp-expandedh, 92vh) - 94px); max-height: calc(100vh - 110px); min-height: 320px; }
.lp-media { position: absolute; inset: 0; display: grid; place-items: center; }
.lp-image, .lp-image-slot { max-width: 100%; max-height: 100%; object-fit: contain; transform-origin: 0 0; will-change: transform; user-select: none; -webkit-user-drag: none; }
.lp-image-slot { width: 100%; height: 100%; }
.lp-video { width: 100%; height: 100%; background: #000; }
.lp-stage.lp-busy::after {
  content: ""; position: absolute; top: 0; left: 0; height: 2px; width: 40%; background: ${REX.signal};
  animation: lp-busy 0.9s ease-in-out infinite;
}
@keyframes lp-busy { from { transform: translateX(-100%); } to { transform: translateX(250%); } }
.lp-tip {
  position: absolute; bottom: 14px; left: 50%; translate: -50% 0; max-width: calc(100% - 16px);
  padding: 7px 10px; border-radius: 999px; border: 1px solid ${REX.line}; background: ${REX.raised};
  font-size: 11px; color: ${REX.text}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; pointer-events: none;
  animation: lp-tip 3.2s ease forwards;
}
@keyframes lp-tip { 0%, 75% { opacity: 1; } 100% { opacity: 0; } }
.lp-media-error { display: grid; gap: 8px; justify-items: center; padding: 24px; text-align: center; color: ${REX.muted}; font-size: 12px; }
.lp-media-error strong { color: ${REX.text}; font-size: 13px; }
.lp-text-btn { border: 1px solid ${REX.line}; border-radius: 9px; background: ${REX.raised}; color: ${REX.signal}; padding: 8px 12px; font-weight: 700; }

/* GIF player */
.lp-gif-mount { position: absolute; inset: 0; display: grid; place-items: center; }
.lp-gif-player { position: absolute; inset: 0; display: grid; grid-template-rows: 1fr auto; min-height: 0; }
.lp-gif-surface { min-height: 0; display: grid; place-items: center; overflow: hidden; padding: 8px 8px 0; }
.lp-gif-canvas { display: block; width: auto; height: auto; }
.lp-gif-preparing, .lp-gif-fallback { position: absolute; inset: 0; display: grid; place-items: center; align-content: center; gap: 10px; color: ${REX.muted}; font-size: 12px; text-align: center; }
.lp-gif-native-prep { position: absolute; inset: 0; display: grid; place-items: center; overflow: hidden; }
.lp-gif-native-prep .lp-gif-native { max-width: 100%; max-height: 100%; object-fit: contain; }
.lp-gif-native-prep .lp-gif-preparing {
  inset: auto 12px 12px auto; display: block; padding: 6px 9px; border: 1px solid ${REX.line}; border-radius: 999px;
  background: rgba(17, 21, 18, .86); backdrop-filter: blur(8px); font-size: 10px; line-height: 1;
}
.lp-gif-fallback img { max-width: 100%; max-height: calc(100% - 38px); }
.lp-gif-fallback span { position: absolute; bottom: 12px; padding: 6px 10px; border: 1px solid ${REX.line}; border-radius: 999px; background: rgba(17, 21, 18, .9); }
.lp-gif-controls {
  z-index: 4; display: grid; grid-template-columns: 32px 38px 32px minmax(80px, 1fr) auto auto 34px; align-items: center; gap: 6px;
  padding: 8px 10px; border-top: 1px solid ${REX.line}; background: linear-gradient(180deg, rgba(8, 10, 9, .4), rgba(8, 10, 9, .97));
}
.lp-media-btn { height: 30px; min-width: 30px; border: 1px solid ${REX.line}; border-radius: 8px; background: ${REX.raised}; color: ${REX.text}; font-weight: 800; line-height: 1; }
.lp-media-btn:hover, .lp-media-btn:focus-visible, .lp-media-btn[aria-pressed="true"] { border-color: ${REX.signal}; color: ${REX.signal}; }
.lp-gif-timeline { width: 100%; min-width: 70px; accent-color: ${REX.signal}; cursor: ew-resize; }
.lp-gif-time { white-space: nowrap; font: 700 10px ui-monospace, monospace; color: ${REX.muted}; font-variant-numeric: tabular-nums; }
.lp-gif-speed { height: 30px; padding: 0 6px; border: 1px solid ${REX.line}; border-radius: 8px; background: ${REX.raised}; color: ${REX.text}; font: 700 11px ui-monospace, monospace; }
.lp-gif-player[data-controls="hover"] .lp-gif-controls { opacity: .18; transition: opacity .14s ease; }
.lp-gif-player[data-controls="hover"]:hover .lp-gif-controls, .lp-gif-player[data-controls="hover"]:focus-within .lp-gif-controls { opacity: 1; }
.lp-gif-player[data-controls="minimal"] .lp-gif-time, .lp-gif-player[data-controls="minimal"] .lp-gif-prev, .lp-gif-player[data-controls="minimal"] .lp-gif-next { display: none; }

/* States */
.lp-empty, .lp-loading, .lp-error {
  display: grid; place-items: center; align-content: center; gap: 8px; text-align: center;
  padding: 32px; color: ${REX.muted}; font-size: 13px; flex: 1 1 220px; min-height: 160px;
}
.lp-empty strong, .lp-error strong { color: ${REX.text}; }
.lp-loading-dot { width: 8px; height: 8px; border-radius: 50%; background: ${REX.signal}; box-shadow: 0 0 24px ${REX.signal}; animation: lp-pulse .8s alternate infinite; }
@keyframes lp-pulse { to { opacity: .25; transform: scale(.7); } }

/* Footer */
.lp-foot {
  min-height: 48px; flex-shrink: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 9px;
  padding: 6px 10px; border-top: 1px solid ${REX.line}; font-size: 11px; color: ${REX.muted};
}
.lp-navgroup { display: flex; align-items: center; gap: 8px; }
.lp-nav {
  width: 40px; height: 38px; min-width: 40px; border: 1px solid ${REX.line}; border-radius: 9px;
  background: ${REX.raised}; color: ${REX.text}; font-size: 17px;
}
.lp-nav:hover, .lp-nav:focus-visible { border-color: ${REX.signal}; color: ${REX.signal}; }
.lp-count { font-family: ui-monospace, monospace; color: ${REX.text}; font-weight: 700; min-width: 54px; text-align: center; font-variant-numeric: tabular-nums; }
.lp-post { border: 0; background: transparent; color: ${REX.muted}; padding: 4px; font-size: 11px; cursor: pointer; }
.lp-post:hover { color: ${REX.signal}; }
.lp-spacer { flex: 1; }
.lp-action { min-width: 34px; height: 34px; font-size: 15px; }
.lp-signal { color: ${REX.signal}; }

/* Grid */
.lp-grid-progress {
  flex-shrink: 0; display: flex; align-items: center; gap: 8px; padding: 7px 12px;
  border-bottom: 1px solid ${REX.line}; background: ${REX.raised}; color: ${REX.muted}; font: 700 10px ui-monospace, monospace;
}
.lp-grid-progress .lp-loading-dot { width: 6px; height: 6px; flex: none; }
.lp-grid {
  position: relative; height: min(65vh, 640px); min-height: 0; flex: 1 1 auto; overflow: auto;
  background: ${REX.ink}; contain: strict; overscroll-behavior: contain;
}
.lp-expanded .lp-grid { height: calc(var(--lp-expandedh, 92vh) - 94px); max-height: calc(100vh - 110px); }
.lp-grid-spacer { width: 1px; opacity: 0; pointer-events: none; }
.lp-grid-window { position: absolute; inset: 0; pointer-events: none; }
.lp-thumb {
  position: absolute; padding: 0; overflow: hidden; pointer-events: auto; cursor: pointer; contain: layout paint style;
  border: 1px solid ${REX.line}; border-radius: 9px;
  background: linear-gradient(110deg, ${REX.raised} 30%, rgba(255, 255, 255, .07) 45%, ${REX.raised} 60%); background-size: 220% 100%;
}
.lp-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; background: ${REX.raised}; }
.lp-thumb-glyph { display: grid; place-items: center; width: 100%; height: 100%; color: ${REX.signal}; font-size: 22px; }
.lp-thumb-n, .lp-thumb-kind {
  position: absolute; padding: 2px 5px; border-radius: 999px; background: rgba(5, 6, 5, .72);
  color: ${REX.text}; font: 700 9px ui-monospace, monospace; pointer-events: none;
}
.lp-thumb-n { right: 5px; bottom: 5px; }
.lp-thumb-kind { left: 5px; top: 5px; color: ${REX.signal}; letter-spacing: .06em; }
.lp-thumb:hover, .lp-thumb:focus-visible, .lp-thumb[aria-current="true"] { border-color: ${REX.signal}; outline: none; box-shadow: 0 0 0 1px ${REX.signal}; }

/* Help */
.lp-help { position: absolute; inset: 12px; z-index: 5; overflow: auto; padding: 18px; border: 1px solid ${REX.line}; border-radius: 14px; background: ${REX.panel}; }
.lp-help h3 { margin: 0 0 6px; font-size: 15px; }
.lp-help h4 { clear: both; margin: 14px 0 6px; color: ${REX.muted}; font-size: 9px; letter-spacing: .14em; text-transform: uppercase; }
.lp-help-grid { display: grid; grid-template-columns: max-content 1fr; gap: 6px 14px; font-size: 12px; }
.lp-help kbd { color: ${REX.signal}; font-family: ui-monospace, monospace; }
.lp-help-close { float: right; margin: -8px -8px 8px 8px; }
.lp-help-foot { margin: 16px 0 0; color: ${REX.muted}; font-size: 11px; }

/* Resize handles */
.lp-resize { position: absolute; z-index: 7; touch-action: none; }
.lp-resize-n, .lp-resize-s { left: 12px; right: 12px; height: 8px; }
.lp-resize-e, .lp-resize-w { top: 12px; bottom: 12px; width: 8px; }
.lp-resize-n { top: 0; cursor: n-resize; }
.lp-resize-s { bottom: 0; cursor: s-resize; }
.lp-resize-e { right: 0; cursor: e-resize; }
.lp-resize-w { left: 0; cursor: w-resize; }
.lp-resize-ne, .lp-resize-se, .lp-resize-sw, .lp-resize-nw { width: 14px; height: 14px; }
.lp-resize-ne { right: 0; top: 0; cursor: ne-resize; }
.lp-resize-se { right: 0; bottom: 0; cursor: se-resize; }
.lp-resize-sw { left: 0; bottom: 0; cursor: sw-resize; }
.lp-resize-nw { left: 0; top: 0; cursor: nw-resize; }

/* Hover countdown ring: fills over the hover delay; signal-coloured when the link is already prepared */
.lp-ring { position: fixed; width: 18px; height: 18px; pointer-events: none; opacity: 0; transition: opacity .1s ease; }
.lp-ring.lp-on { opacity: 1; }
.lp-ring svg { width: 100%; height: 100%; transform: rotate(-90deg); }
.lp-ring circle { fill: none; stroke-width: 3; }
.lp-ring-track { stroke: rgba(8, 10, 9, .55); }
.lp-ring-arc { stroke: ${REX.text}; stroke-dasharray: 100; stroke-dashoffset: 100; stroke-linecap: round; }
.lp-ring.lp-ready .lp-ring-arc { stroke: ${REX.signal}; }
.lp-ring.lp-on[data-cycle="0"] .lp-ring-arc { animation: lp-ring-a var(--lp-ring-ms, 300ms) linear forwards; }
.lp-ring.lp-on[data-cycle="1"] .lp-ring-arc { animation: lp-ring-b var(--lp-ring-ms, 300ms) linear forwards; }
@keyframes lp-ring-a { to { stroke-dashoffset: 0; } }
@keyframes lp-ring-b { to { stroke-dashoffset: 0; } }

/* A quarter-turned media box is resized and centred by the viewer */
.lp-media.lp-turned { inset: auto; left: 50%; top: 50%; translate: -50% -50%; }

/* Toast and screen-reader announcements */
.lp-toast {
  position: absolute; top: 56px; right: 12px; z-index: 6; padding: 6px 9px; border: 1px solid ${REX.line}; border-radius: 8px;
  background: ${REX.raised}; color: ${REX.signal}; font: 700 11px ui-monospace, monospace;
  opacity: 0; transform: translateY(-4px); transition: opacity .12s ease, transform .12s ease; pointer-events: none;
}
.lp-toast.lp-on { opacity: 1; transform: none; }
.lp-live { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

@media (max-width: 720px) {
  .lp-head { gap: 4px; padding-left: 10px; }
  .lp-btn { min-width: 36px; width: 36px; }
  .lp-expanded .lp-stage, .lp-expanded .lp-grid { min-height: 260px; }
}
@media (max-width: 560px) {
  .lp-gif-controls { grid-template-columns: 30px 36px 30px minmax(60px, 1fr) auto 32px; }
  .lp-gif-time { display: none; }
}
.lp-calm, .lp-calm * { animation: none !important; transition: none !important; }
@media (prefers-reduced-motion: reduce) {
  .lp-panel, .lp-panel * { animation: none !important; transition: none !important; }
}
`;
