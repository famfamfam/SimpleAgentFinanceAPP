export async function fakeRecorder(page){
  await page.evaluate(()=>{
    const raw=new ArrayBuffer(32044),v=new DataView(raw),text=(o,t)=>[...t].forEach((c,i)=>v.setUint8(o+i,c.charCodeAt(0)));
    text(0,'RIFF');v.setUint32(4,32036,true);text(8,'WAVEfmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,16000,true);v.setUint32(28,32000,true);v.setUint16(32,2,true);v.setUint16(34,16,true);text(36,'data');v.setUint32(40,32000,true);
    if(!navigator.mediaDevices)Object.defineProperty(navigator,"mediaDevices",{configurable:true,value:{}});
    navigator.mediaDevices.getUserMedia=async()=>({getTracks:()=>[{stop:()=>{window.trackStopped=true;window.trackReleased=true}}]});
    window.MediaRecorder=class{state="inactive";mimeType="audio/wav";constructor(){window.testRecorder=this;}start(){this.state="recording";}stop(){if(this.state!=="recording")throw Error("double stop");this.state="inactive";window.stopCount=(window.stopCount || 0)+1;this.ondataavailable({data:new Blob([raw],{type:this.mimeType})});this.onstop();}};
    window.AudioContext=class{state="running";async decodeAudioData(){return {duration:1};}async close(){this.state="closed";}};
    window.OfflineAudioContext=class{destination={};createBufferSource(){return {connect(){},start(){}};}async startRendering(){return {getChannelData:()=>new Float32Array(16000)};}};
  });
}
