import type {LinkPeekSettings} from "../shared/settings";
export interface GestureCallbacks{
  next:(n?:number)=>void;previous:(n?:number)=>void;zoom:(scale:number,x:number,y:number)=>void;
  pan:(dx:number,dy:number)=>void;scrub:(delta:number)=>void;doubleClick:(x:number,y:number)=>void;
  isZoomed:()=>boolean;
}
export class GestureController{
  private accX=0;private accY=0;private lockedUntil=0;
  constructor(private el:HTMLElement,private cb:GestureCallbacks,private settings:LinkPeekSettings){
    el.addEventListener("wheel",this.onWheel,{passive:false});el.addEventListener("dblclick",this.onDouble);
  }
  destroy(){this.el.removeEventListener("wheel",this.onWheel);this.el.removeEventListener("dblclick",this.onDouble)}
  private stepCount(delta:number){
    if(!this.settings.fastSwipeAcceleration)return 1;
    return Math.min(this.settings.maxImagesPerSwipe,Math.max(1,Math.floor(Math.abs(delta)/(this.settings.gestureThreshold*1.8))));
  }
  private onWheel=(e:WheelEvent)=>{
    if(e.ctrlKey&&this.settings.pinchZoom){
      e.preventDefault();const factor=Math.exp(-e.deltaY*.004*this.settings.pinchSensitivity);this.cb.zoom(factor,e.offsetX,e.offsetY);return;
    }
    if(this.cb.isZoomed()&&this.settings.panWhenZoomed){
      e.preventDefault();this.cb.pan(-e.deltaX*this.settings.panFriction,-e.deltaY*this.settings.panFriction);return;
    }
    const horizontal=Math.abs(e.deltaX)>Math.abs(e.deltaY)*1.25;
    if(horizontal&&this.settings.horizontalGesture==="disabled")return;
    if(!horizontal&&(this.settings.verticalGesture==="disabled"||this.settings.verticalGesture==="scroll"))return;
    e.preventDefault();
    const now=performance.now();this.accX+=e.deltaX;this.accY+=e.deltaY;
    if(this.settings.momentumFiltering&&now<this.lockedUntil)return;
    const threshold=Math.max(12,this.settings.gestureThreshold*(1.2-this.settings.navSensitivity*.4));
    if(horizontal&&Math.abs(this.accX)>=threshold){
      let d=this.accX*(this.settings.reverseHorizontal?-1:1),n=this.stepCount(d);
      if(this.settings.horizontalGesture==="scrub")this.cb.scrub(d);else d>0?this.cb.next(n):this.cb.previous(n);
      this.accX=this.accY=0;this.lockedUntil=now+(this.settings.momentumFiltering?this.settings.gestureCooldown:0);return;
    }
    if(!horizontal&&Math.abs(this.accY)>=threshold){
      let d=this.accY*(this.settings.reverseVertical?-1:1),n=this.stepCount(d);
      if(this.settings.verticalGesture==="pan")this.cb.pan(0,-d);else d>0?this.cb.next(n):this.cb.previous(n);
      this.accX=this.accY=0;this.lockedUntil=now+(this.settings.momentumFiltering?this.settings.gestureCooldown:0);
    }
  };
  private onDouble=(e:MouseEvent)=>{if(this.settings.doubleClick==="none")return;e.preventDefault();this.cb.doubleClick(e.offsetX,e.offsetY)};
}
