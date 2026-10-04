import type {LinkPeekSettings} from "../shared/settings";
export interface GestureCallbacks{
  next:(n?:number)=>void;previous:(n?:number)=>void;zoom:(scale:number,x:number,y:number)=>void;
  pan:(dx:number,dy:number)=>void;scrub:(delta:number)=>void;doubleClick:(x:number,y:number)=>void;
  isZoomed:()=>boolean;
}
export class GestureController{
  private accX=0;private accY=0;private lockedUntil=0;
  private lastPrimaryUpAt=0;private lastPrimaryUpX=0;private lastPrimaryUpY=0;
  private dragPointer:number|undefined;private dragX=0;private dragY=0;private dragMoved=false;private suppressDoubleUntil=0;
  constructor(private el:HTMLElement,private cb:GestureCallbacks,private settings:LinkPeekSettings){
    el.addEventListener("wheel",this.onWheel,{passive:false});
    el.addEventListener("dblclick",this.onDouble);
    el.addEventListener("pointerdown",this.onPointerDown);
    el.addEventListener("pointermove",this.onPointerMove);
    el.addEventListener("pointerup",this.onPointerUp);
    el.addEventListener("pointercancel",this.onPointerCancel);
  }
  destroy(){
    this.el.removeEventListener("wheel",this.onWheel);this.el.removeEventListener("dblclick",this.onDouble);
    this.el.removeEventListener("pointerdown",this.onPointerDown);this.el.removeEventListener("pointermove",this.onPointerMove);
    this.el.removeEventListener("pointerup",this.onPointerUp);this.el.removeEventListener("pointercancel",this.onPointerCancel);
  }
  private stepCount(delta:number){
    if(!this.settings.fastSwipeAcceleration)return 1;
    return Math.min(this.settings.maxImagesPerSwipe,Math.max(1,Math.floor(Math.abs(delta)/(this.settings.gestureThreshold*1.8))));
  }
  private onWheel=(e:WheelEvent)=>{
    const unit=e.deltaMode===WheelEvent.DOM_DELTA_LINE?16:e.deltaMode===WheelEvent.DOM_DELTA_PAGE?Math.max(320,this.el.clientHeight):1;
    const dx=e.deltaX*unit,dy=e.deltaY*unit;
    if(e.ctrlKey&&this.settings.pinchZoom){
      e.preventDefault();const factor=Math.exp(-dy*.004*this.settings.pinchSensitivity);this.cb.zoom(factor,e.offsetX,e.offsetY);return;
    }
    if(this.cb.isZoomed()&&this.settings.panWhenZoomed){
      e.preventDefault();this.cb.pan(-dx*this.settings.panFriction,-dy*this.settings.panFriction);return;
    }
    if(this.settings.mouseWheel==="scroll")return;
    if(this.settings.mouseWheel==="zoom"&&Math.abs(dy)>=Math.abs(dx)){
      e.preventDefault();this.cb.zoom(Math.exp(-dy*.002*this.settings.pinchSensitivity),e.offsetX,e.offsetY);return;
    }
    const horizontal=Math.abs(dx)>Math.abs(dy)*1.25;
    if(horizontal&&this.settings.horizontalGesture==="disabled")return;
    if(!horizontal&&(this.settings.verticalGesture==="disabled"||this.settings.verticalGesture==="scroll"))return;
    e.preventDefault();
    const now=performance.now();this.accX+=dx;this.accY+=dy;
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
  private onPointerDown=(e:PointerEvent)=>{
    if(e.button!==0||!this.settings.doubleClickDragPan||!this.settings.panWhenZoomed||!this.cb.isZoomed())return;
    const now=performance.now(),near=Math.hypot(e.clientX-this.lastPrimaryUpX,e.clientY-this.lastPrimaryUpY)<=28;
    if(now-this.lastPrimaryUpAt>360||!near)return;
    this.dragPointer=e.pointerId;this.dragX=e.clientX;this.dragY=e.clientY;this.dragMoved=false;
    this.el.classList.add("lp-dragging");
    try{this.el.setPointerCapture(e.pointerId)}catch{}
    e.preventDefault();
  };
  private onPointerMove=(e:PointerEvent)=>{
    if(this.dragPointer!==e.pointerId)return;
    const dx=e.clientX-this.dragX,dy=e.clientY-this.dragY;this.dragX=e.clientX;this.dragY=e.clientY;
    if(Math.abs(dx)+Math.abs(dy)>=1){this.dragMoved=true;this.cb.pan(dx,dy)}
    e.preventDefault();
  };
  private finishPointer=(e:PointerEvent,cancelled=false)=>{
    if(this.dragPointer===e.pointerId){
      if(this.dragMoved){this.suppressDoubleUntil=performance.now()+120}
      this.dragPointer=undefined;this.dragMoved=false;this.el.classList.remove("lp-dragging");
      try{if(this.el.hasPointerCapture(e.pointerId))this.el.releasePointerCapture(e.pointerId)}catch{}
      e.preventDefault();
    }
    if(!cancelled&&e.button===0){this.lastPrimaryUpAt=performance.now();this.lastPrimaryUpX=e.clientX;this.lastPrimaryUpY=e.clientY}
  };
  private onPointerUp=(e:PointerEvent)=>this.finishPointer(e,false);
  private onPointerCancel=(e:PointerEvent)=>this.finishPointer(e,true);
  private onDouble=(e:MouseEvent)=>{
    if(performance.now()<this.suppressDoubleUntil){e.preventDefault();return}
    if(this.settings.doubleClick==="none")return;e.preventDefault();this.cb.doubleClick(e.offsetX,e.offsetY)
  };
}
