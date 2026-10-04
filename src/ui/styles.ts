import {REX,rexCss} from "../shared/theme";
export const overlayCss=rexCss+`
.lp-root{position:fixed;z-index:2147483647;pointer-events:none;color:${REX.text}}
.lp-panel{pointer-events:auto;position:fixed;width:min(var(--lp-width,480px),calc(100vw - 24px));max-height:var(--lp-maxh,70vh);background:rgba(17,21,18,.97);border:1px solid ${REX.line};border-radius:18px;box-shadow:0 24px 80px rgba(0,0,0,.55);overflow:hidden;backdrop-filter:blur(16px);animation:lp-in .16s ease-out}
.lp-panel.lp-expanded{left:50%!important;top:50%!important;width:min(var(--lp-expandedw,92vw),calc(100vw - 16px));max-height:var(--lp-expandedh,92vh);transform:translate(-50%,-50%);animation:none}
@keyframes lp-in{from{opacity:0;transform:translateY(4px) scale(.985)}to{opacity:1;transform:none}}
.lp-head{height:48px;display:flex;align-items:center;gap:10px;padding:0 12px 0 16px;border-bottom:1px solid ${REX.line}}
.lp-brand{font-size:9px;letter-spacing:1.4px;font-weight:800;color:${REX.signal};text-transform:uppercase}
.lp-title{font-size:13px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.lp-meta{font:700 11px ui-monospace,monospace;color:${REX.muted}}
.lp-btn{min-width:36px;height:36px;border:1px solid transparent;border-radius:9px;background:transparent;color:${REX.muted};display:grid;place-items:center}
.lp-btn:hover,.lp-btn[aria-pressed="true"]{color:${REX.signal};background:${REX.raised};border-color:${REX.line}}
.lp-stage{position:relative;height:min(var(--lp-stageh,54vh),calc(var(--lp-maxh,70vh) - 92px));min-height:260px;background:#050605;display:grid;place-items:center;overflow:hidden;touch-action:none}
.lp-expanded .lp-stage{height:calc(var(--lp-expandedh,92vh) - 94px);max-height:calc(100vh - 110px);min-height:320px}
.lp-image,.lp-image-slot{max-width:100%;max-height:100%;object-fit:contain;transform-origin:0 0;will-change:transform;user-select:none;-webkit-user-drag:none}.lp-image-slot{width:100%;height:100%}
.lp-gif-mount{position:absolute;inset:0;display:grid;place-items:center}
.lp-gif-player{position:absolute;inset:0;display:grid;grid-template-rows:1fr auto;min-height:0}
.lp-gif-surface{min-height:0;display:grid;place-items:center;overflow:hidden;padding:8px 8px 0}
.lp-gif-canvas{display:block;width:auto;height:auto}
.lp-gif-preparing,.lp-gif-fallback{position:absolute;inset:0;display:grid;place-items:center;align-content:center;gap:10px;color:${REX.muted};font-size:12px;text-align:center}
.lp-gif-native-prep{position:absolute;inset:0;display:grid;place-items:center;overflow:hidden}
.lp-gif-native-prep .lp-gif-native{max-width:100%;max-height:100%;object-fit:contain}
.lp-gif-native-prep .lp-gif-preparing{inset:auto 12px 12px auto;display:block;padding:6px 9px;border:1px solid ${REX.line};border-radius:999px;background:rgba(17,21,18,.86);backdrop-filter:blur(8px);color:${REX.muted};font-size:10px;line-height:1}
.lp-gif-fallback img{max-width:100%;max-height:calc(100% - 38px)}
.lp-gif-fallback span{position:absolute;bottom:12px;background:rgba(17,21,18,.9);border:1px solid ${REX.line};border-radius:999px;padding:6px 10px}
.lp-gif-controls{display:grid;grid-template-columns:32px 38px 32px minmax(80px,1fr) auto auto 34px;align-items:center;gap:6px;padding:8px 10px;background:linear-gradient(180deg,rgba(8,10,9,.4),rgba(8,10,9,.97));border-top:1px solid ${REX.line};z-index:4}
.lp-media-btn{height:30px;min-width:30px;border:1px solid ${REX.line};border-radius:8px;background:${REX.raised};color:${REX.text};font-weight:800;line-height:1}
.lp-media-btn:hover,.lp-media-btn:focus-visible,.lp-media-btn[aria-pressed="true"]{border-color:${REX.signal};color:${REX.signal}}
.lp-gif-timeline{width:100%;min-width:70px;accent-color:${REX.signal};cursor:ew-resize}
.lp-gif-time{white-space:nowrap;font:700 10px ui-monospace,monospace;color:${REX.muted};font-variant-numeric:tabular-nums}
.lp-gif-speed{height:30px;border:1px solid ${REX.line};border-radius:8px;background:${REX.raised};color:${REX.text};font:700 11px ui-monospace,monospace;padding:0 6px}
.lp-gif-player[data-controls="hover"] .lp-gif-controls{opacity:.18;transition:opacity .14s ease}.lp-gif-player[data-controls="hover"]:hover .lp-gif-controls,.lp-gif-player[data-controls="hover"]:focus-within .lp-gif-controls{opacity:1}
.lp-gif-player[data-controls="minimal"] .lp-gif-time,.lp-gif-player[data-controls="minimal"] .lp-gif-prev,.lp-gif-player[data-controls="minimal"] .lp-gif-next{display:none}
@media(max-width:560px){.lp-gif-controls{grid-template-columns:30px 36px 30px minmax(60px,1fr) auto 32px}.lp-gif-time{display:none}}
.lp-empty,.lp-loading,.lp-error{display:grid;place-items:center;gap:8px;text-align:center;padding:32px;color:${REX.muted};font-size:13px}
.lp-loading-dot{width:8px;height:8px;border-radius:50%;background:${REX.signal};box-shadow:0 0 24px ${REX.signal};animation:pulse .8s alternate infinite}
@keyframes pulse{to{opacity:.25;transform:scale(.7)}}
.lp-foot{min-height:44px;display:flex;align-items:center;gap:10px;padding:8px 12px;border-top:1px solid ${REX.line};font-size:11px;color:${REX.muted}}
.lp-count{font-family:ui-monospace,monospace;color:${REX.text};font-weight:700}.lp-spacer{flex:1}.lp-signal{color:${REX.signal}}
.lp-grid{position:relative;height:min(65vh,640px);min-height:260px;overflow:auto;background:${REX.ink};contain:strict;overscroll-behavior:contain}
.lp-expanded .lp-grid{height:calc(var(--lp-expandedh,92vh) - 94px);max-height:calc(100vh - 110px)}
.lp-grid-spacer{width:1px;opacity:0;pointer-events:none}
.lp-grid-window{position:absolute;inset:0;pointer-events:none}
.lp-thumb{position:absolute;aspect-ratio:1;border:1px solid ${REX.line};border-radius:9px;overflow:hidden;background:${REX.raised};padding:0;pointer-events:auto;contain:layout paint style}
.lp-thumb img{width:100%;height:100%;object-fit:cover;display:block}.lp-thumb[aria-current="true"]{border-color:${REX.signal}}
.lp-help{position:absolute;inset:12px;background:${REX.panel};border:1px solid ${REX.line};border-radius:14px;padding:18px;z-index:5;overflow:auto}
.lp-help h3{margin:0 0 12px;font-size:15px}.lp-help-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px 16px;font-size:12px}
.lp-help kbd{color:${REX.signal};font-family:ui-monospace,monospace}.lp-tip{position:absolute;bottom:14px;left:50%;translate:-50% 0;background:${REX.raised};border:1px solid ${REX.line};padding:7px 10px;border-radius:999px;font-size:11px;color:${REX.text};pointer-events:none}
.lp-toast{position:absolute;top:56px;right:12px;background:${REX.raised};border:1px solid ${REX.line};padding:6px 9px;border-radius:8px;font:700 11px ui-monospace,monospace;color:${REX.signal}}
@media(max-width:720px){.lp-brand{display:none}.lp-head{gap:6px;padding-left:10px}.lp-btn{min-width:32px;width:32px}.lp-expanded .lp-stage,.lp-expanded .lp-grid{min-height:260px}}
@media(prefers-reduced-motion:reduce){.lp-panel{animation:none}.lp-loading-dot{animation:none}}
`;
