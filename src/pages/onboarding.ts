import {PRESETS,loadSettings,saveSettings,type LinkPeekSettings} from "../shared/settings";
let step=0;let settings:LinkPeekSettings;
const screens=[...document.querySelectorAll<HTMLElement>(".screen")];
const progress=document.getElementById("progress")!;
progress.innerHTML=screens.map((_,i)=>`<i class="${i===0?"on":""}"></i>`).join("");
function show(n:number){step=Math.max(0,Math.min(screens.length-1,n));screens.forEach((s,i)=>s.classList.toggle("active",i===step));[...progress.children].forEach((x,i)=>x.classList.toggle("on",i<=step))}
document.querySelectorAll(".next").forEach(b=>b.addEventListener("click",()=>show(step+1)));
const link=document.getElementById("demoLink")!,peek=document.getElementById("peek")!;let demoClose:number|undefined;
const openDemo=()=>{clearTimeout(demoClose);peek.classList.add("on")},closeDemo=()=>{demoClose=window.setTimeout(()=>peek.classList.remove("on"),500)};
link.addEventListener("mouseenter",openDemo);link.addEventListener("mouseleave",closeDemo);peek.addEventListener("mouseenter",openDemo);peek.addEventListener("mouseleave",closeDemo);
document.querySelectorAll<HTMLElement>("[data-direction]").forEach(b=>b.onclick=()=>{document.querySelectorAll("[data-direction]").forEach(x=>x.classList.remove("selected"));b.classList.add("selected");settings.reverseVertical=b.dataset.direction==="reverse"});
(async()=>{settings=await loadSettings();const choices=document.getElementById("presetChoices")!;const labels:Record<string,string>= {balanced:"Balanced",minimal:"Data saver",fast:"Fast",touchpad:"Touchpad",manual:"Manual"};
choices.innerHTML=Object.keys(labels).map(p=>`<button class="choice ${settings.preset===p?"selected":""}" data-preset="${p}"><strong>${labels[p]}</strong><span>${p==="touchpad"?"Responsive gestures tuned for one hand.":p==="fast"?"Warms more nearby links within firm limits.":p==="minimal"?"No speculative loading and a 32 MB media budget.":p==="manual"?"Only open when you explicitly ask.":"Warms likely links without loading the whole page."}</span></button>`).join("");
document.querySelectorAll<HTMLElement>("[data-preset]").forEach(b=>b.onclick=()=>{document.querySelectorAll("[data-preset]").forEach(x=>x.classList.remove("selected"));b.classList.add("selected");const p=b.dataset.preset!;settings={...settings,...PRESETS[p],preset:p as LinkPeekSettings["preset"]}});
})();
document.getElementById("finish")!.onclick=async()=>{settings.onboardingComplete=true;await saveSettings(settings);window.close()};
document.getElementById("settings")!.onclick=async()=>{settings.onboardingComplete=true;await saveSettings(settings);chrome.runtime.openOptionsPage()};
