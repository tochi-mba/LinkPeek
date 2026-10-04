import {REX,rexCss} from "../shared/theme";
export const overlayCss=rexCss+`
.lp-root{position:fixed;z-index:2147483647;pointer-events:none;color:${REX.text}}
.lp-panel{pointer-events:auto;position:fixed;width:min(var(--lp-width,480px),calc(100vw - 24px));max-height:var(--lp-maxh,70vh);background:rgba(17,21,18,.97);border:1px solid ${REX.line};border-radius:18px;box-shadow:0 24px 80px rgba(0,0,0,.55);overflow:hidden;backdrop-filter:blur(16px);animation:lp-in .16s ease-out}
@keyframes lp-in{from{opacity:0;transform:translateY(4px) scale(.985)}to{opacity:1;transform:none}}
.lp-head{height:48px;display:flex;align-items:center;gap:10px;padding:0 12px 0 16px;border-bottom:1px solid ${REX.line}}
.lp-brand{font-size:9px;letter-spacing:1.4px;font-weight:800;color:${REX.signal};text-transform:uppercase}
.lp-title{font-size:13px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.lp-meta{font:700 11px ui-monospace,monospace;color:${REX.muted}}
.lp-btn{min-width:36px;height:36px;border:1px solid transparent;border-radius:9px;background:transparent;color:${REX.muted};display:grid;place-items:center}
.lp-btn:hover,.lp-btn[aria-pressed="true"]{color:${REX.signal};background:${REX.raised};border-color:${REX.line}}
.lp-stage{position:relative;height:min(54vh,560px);min-height:260px;background:#050605;display:grid;place-items:center;overflow:hidden;touch-action:none}
.lp-image{max-width:100%;max-height:100%;object-fit:contain;transform-origin:0 0;will-change:transform;user-select:none;-webkit-user-drag:none}
.lp-empty,.lp-loading,.lp-error{display:grid;place-items:center;gap:8px;text-align:center;padding:32px;color:${REX.muted};font-size:13px}
.lp-loading-dot{width:8px;height:8px;border-radius:50%;background:${REX.signal};box-shadow:0 0 24px ${REX.signal};animation:pulse .8s alternate infinite}
@keyframes pulse{to{opacity:.25;transform:scale(.7)}}
.lp-foot{min-height:44px;display:flex;align-items:center;gap:10px;padding:8px 12px;border-top:1px solid ${REX.line};font-size:11px;color:${REX.muted}}
.lp-count{font-family:ui-monospace,monospace;color:${REX.text};font-weight:700}.lp-spacer{flex:1}.lp-signal{color:${REX.signal}}
.lp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(var(--lp-thumb,96px),1fr));gap:6px;padding:8px;overflow:auto;max-height:min(65vh,640px);background:${REX.ink}}
.lp-thumb{aspect-ratio:1;border:1px solid ${REX.line};border-radius:9px;overflow:hidden;background:${REX.raised};padding:0}
.lp-thumb img{width:100%;height:100%;object-fit:cover;display:block}.lp-thumb[aria-current="true"]{border-color:${REX.signal}}
.lp-help{position:absolute;inset:12px;background:${REX.panel};border:1px solid ${REX.line};border-radius:14px;padding:18px;z-index:5;overflow:auto}
.lp-help h3{margin:0 0 12px;font-size:15px}.lp-help-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px 16px;font-size:12px}
.lp-help kbd{color:${REX.signal};font-family:ui-monospace,monospace}.lp-tip{position:absolute;bottom:14px;left:50%;translate:-50% 0;background:${REX.raised};border:1px solid ${REX.line};padding:7px 10px;border-radius:999px;font-size:11px;color:${REX.text};pointer-events:none}
.lp-toast{position:absolute;top:56px;right:12px;background:${REX.raised};border:1px solid ${REX.line};padding:6px 9px;border-radius:8px;font:700 11px ui-monospace,monospace;color:${REX.signal}}
@media(prefers-reduced-motion:reduce){.lp-panel{animation:none}.lp-loading-dot{animation:none}}
`;
