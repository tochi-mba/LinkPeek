import {PRESETS,loadSettings,saveSettings,type LinkPeekSettings} from "../shared/settings";
let step=0;let settings:LinkPeekSettings;
const screens=[...document.querySelectorAll<HTMLElement>(".screen")];
const progress=document.getElementById("progress")!;
progress.innerHTML=screens.map((_,i)=>`<i class="${i===0?"on":""}"></i>`).join("");
function show(n:number){step=Math.max(0,Math.min(screens.length-1,n));screens.forEach((s,i)=>s.classList.toggle("active",i===step));[...progress.children].forEach((x,i)=>x.classList.toggle("on",i<=step))}
document.querySelectorAll(".next").forEach(b=>b.addEventListener("click",()=>show(step+1)));
const link=document.getElementById("demoLink")!,peek=document.getElementById("peek")!;link.addEventListener("mouseenter",()=>peek.classList.add("on"));link.addEventListener("mouseleave",()=>setTimeout(()=>peek.classList.remove("on"),500));
document.querySelectorAll<HTMLElement>("[data-direction]").forEach(b=>b.onclick=()=>{document.querySelectorAll("[data-direction]").forEach(x=>x.classList.remove("selected"));b.classList.add("selected");settings.reverseVertical=b.dataset.direction==="reverse"});
(async()=>{settings=await loadSettings();const choices=document.getElementById("presetChoices")!;const labels:Record<string,string>= {balanced:"Balanced",minimal:"Minimal",fast:"Fast",touchpad:"Touchpad Pro",manual:"Manual"};
choices.innerHTML=Object.keys(labels).map((p,i)=>`<button class="choice ${i===0?"selected":""}" data-preset="${p}"><strong>${labels[p]}</strong><span>${p==="touchpad"?"Gesture-heavy, fast and tuned for one hand.":p==="fast"?"Short delays and more prefetching.":p==="minimal"?"Quiet UI and conservative loading.":p==="manual"?"Only open when you explicitly ask.":"The recommended defaults."}</span></button>`).join("");
document.querySelectorAll<HTMLElement>("[data-preset]").forEach(b=>b.onclick=()=>{document.querySelectorAll("[data-preset]").forEach(x=>x.classList.remove("selected"));b.classList.add("selected");const p=b.dataset.preset!;settings={...settings,...PRESETS[p],preset:p as LinkPeekSettings["preset"]}});
})();
document.getElementById("finish")!.onclick=async()=>{settings.onboardingComplete=true;await saveSettings(settings);window.close()};
document.getElementById("settings")!.onclick=async()=>{settings.onboardingComplete=true;await saveSettings(settings);chrome.runtime.openOptionsPage()};
