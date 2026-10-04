export interface GestureCallbacks{next:(n?:number)=>void;previous:(n?:number)=>void;zoom:(scale:number,x:number,y:number)=>void;pan:(dx:number,dy:number)=>void;scrub:(delta:number)=>void}
export class GestureController{
  private accX=0;private accY=0;private lockedUntil=0;private ctrl=false;
  constructor(private el:HTMLElement,private cb:GestureCallbacks,private threshold=62,private cooldown=140){
    el.addEventListener("wheel",this.onWheel,{passive:false});
    el.addEventListener("dblclick",this.onDouble);
  }
  destroy(){this.el.removeEventListener("wheel",this.onWheel);this.el.removeEventListener("dblclick",this.onDouble)}
  private onWheel=(e:WheelEvent)=>{
    e.preventDefault();
    if(e.ctrlKey){
      const factor=Math.exp(-e.deltaY*.004);this.cb.zoom(factor,e.offsetX,e.offsetY);this.ctrl=true;return;
    }
    const now=performance.now();this.accX+=e.deltaX;this.accY+=e.deltaY;
    if(now<this.lockedUntil)return;
    if(Math.abs(this.accX)>Math.abs(this.accY)*1.25&&Math.abs(this.accX)>this.threshold){
      this.cb.scrub(this.accX);this.accX=0;this.accY=0;this.lockedUntil=now+this.cooldown;return;
    }
    if(Math.abs(this.accY)>=this.threshold){
      const n=Math.min(3,Math.max(1,Math.floor(Math.abs(this.accY)/(this.threshold*1.8))));
      this.accY>0?this.cb.next(n):this.cb.previous(n);this.accX=0;this.accY=0;this.lockedUntil=now+this.cooldown;
    }
  };
  private onDouble=(e:MouseEvent)=>{e.preventDefault();this.cb.zoom(2,e.offsetX,e.offsetY)};
}
