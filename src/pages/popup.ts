import {DEFAULT_SETTINGS,PRESETS,loadSettings,saveSettings,type LinkPeekSettings} from "../shared/settings";
import {loadFavorites,removeFavorite} from "../shared/favorites";
let s:LinkPeekSettings=DEFAULT_SETTINGS;let host="";
const $=<T extends HTMLElement>(id:string)=>document.getElementById(id) as T;
const escapeHtml=(v:string)=>v.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
async function renderFavorites(){
  const favorites=await loadFavorites();$("favoriteCount").textContent=String(favorites.length);
  $("favorites").innerHTML=favorites.length?favorites.map((f,i)=>`<div class="favorite-row"><button class="favorite-open" data-open-favorite="${i}" title="${escapeHtml(f.url)}"><strong>${escapeHtml(f.title)}</strong><small>${escapeHtml(new URL(f.url).hostname)}${f.mediaCount!=null?` · ${f.mediaCount} media`:""}</small></button><button class="favorite-remove" data-remove-favorite="${i}" aria-label="Remove favorite">×</button></div>`).join(""):'<div class="favorite-empty">No saved links yet.</div>';
  document.querySelectorAll<HTMLElement>("[data-open-favorite]").forEach(el=>el.addEventListener("click",()=>{const f=favorites[Number(el.dataset.openFavorite)];if(f)chrome.tabs.create({url:f.url})}));
  document.querySelectorAll<HTMLElement>("[data-remove-favorite]").forEach(el=>el.addEventListener("click",async()=>{const f=favorites[Number(el.dataset.removeFavorite)];if(!f)return;await removeFavorite(f.url);await renderFavorites()}));
}
(async()=>{
  s=await loadSettings();$("enabled").toggleAttribute("checked",s.enabled);($("enabled") as HTMLInputElement).checked=s.enabled;($("preset") as HTMLSelectElement).value=s.preset;
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});if(tab?.url?.startsWith("http")){host=new URL(tab.url).hostname;$("site").textContent=host}else $("site").textContent="Not a web page";
  await renderFavorites();
})();
$("enabled").addEventListener("change",async e=>{s.enabled=(e.target as HTMLInputElement).checked;await saveSettings(s)});
$("preset").addEventListener("change",async e=>{const p=(e.target as HTMLSelectElement).value;s={...s,...(PRESETS[p]??{}),preset:p as LinkPeekSettings["preset"]};await saveSettings(s)});
$("options").addEventListener("click",()=>chrome.runtime.openOptionsPage());
$("help").addEventListener("click",()=>chrome.tabs.create({url:chrome.runtime.getURL("onboarding.html")}));
$("clear").addEventListener("click",async()=>{await chrome.runtime.sendMessage({type:"LINKPEEK_CLEAR_CACHE"});$("clear").textContent="Cleared"});
$("disableSite").addEventListener("click",async()=>{if(!host)return;const cur=s.siteProfiles[host]??{};s.siteProfiles={...s.siteProfiles,[host]:{...cur,enabled:cur.enabled===false?true:false}};await saveSettings(s);$("disableSite").textContent=s.siteProfiles[host].enabled===false?"Enable site":"Disable site"});
chrome.storage.onChanged.addListener(changes=>{if(changes.favorites)void renderFavorites()});
