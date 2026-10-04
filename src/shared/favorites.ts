export interface FavoriteLink{url:string;title:string;addedAt:number;mediaCount?:number}

const KEY="favorites";

export function favoriteKey(raw:string){
  const u=new URL(raw);u.hash="";
  for(const k of [...u.searchParams.keys()])if(/^utm_|^(fbclid|gclid)$/i.test(k))u.searchParams.delete(k);
  return u.href;
}
export async function loadFavorites():Promise<FavoriteLink[]>{
  const stored=await chrome.storage.local.get(KEY),raw=stored[KEY];
  if(!Array.isArray(raw))return [];
  const seen=new Set<string>(),out:FavoriteLink[]=[];
  for(const value of raw){
    if(!value||typeof value.url!=="string")continue;
    let key:string;try{key=favoriteKey(value.url)}catch{continue}
    if(seen.has(key))continue;seen.add(key);
    out.push({url:key,title:typeof value.title==="string"&&value.title.trim()?value.title.trim():key,addedAt:Number(value.addedAt)||0,mediaCount:Number.isFinite(value.mediaCount)?Number(value.mediaCount):undefined});
  }
  return out.sort((a,b)=>b.addedAt-a.addedAt);
}
export async function isFavorite(url:string){const key=favoriteKey(url);return (await loadFavorites()).some(f=>f.url===key)}
export async function toggleFavorite(input:{url:string;title?:string;mediaCount?:number}):Promise<{saved:boolean;favorite?:FavoriteLink}>{
  const key=favoriteKey(input.url),favorites=await loadFavorites(),at=favorites.findIndex(f=>f.url===key);
  if(at>=0){favorites.splice(at,1);await chrome.storage.local.set({[KEY]:favorites});return {saved:false}}
  const favorite:FavoriteLink={url:key,title:input.title?.trim()||key,addedAt:Date.now(),mediaCount:input.mediaCount};
  favorites.unshift(favorite);await chrome.storage.local.set({[KEY]:favorites});return {saved:true,favorite};
}
export async function removeFavorite(url:string){
  const key=favoriteKey(url),favorites=(await loadFavorites()).filter(f=>f.url!==key);await chrome.storage.local.set({[KEY]:favorites});
}
