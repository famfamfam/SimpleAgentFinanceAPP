import {expect} from "@playwright/test";
import {initialState,derivedID} from "../../../backend/web/model.js";
const owner="00000000-0000-4000-8000-000000000999";

export async function connectedChat(page,provider=async()=>({text:"Ответ",action:"answer",entries:[]})) {
  let state=initialState(),revision=0,seq=0,epoch=0;
  const archive=[],inputs=[];
  await page.route("**/api/**",async route=>{
    const url=new URL(route.request().url()),path=url.pathname,body=route.request().headers()['content-type']?.includes('application/json')?route.request().postDataJSON():null;
    if(path.endsWith("/assistant")){
      inputs.push(body);
      const user={id:body.id,taskId:body.taskId,role:"user",text:body.text,createdAt:body.sentAt,seq:++seq,audio:!!body.audio,status:"open",deleted:false};archive.push(user);
      const output=await provider(body,inputs.length);
      if(user.deleted)return route.fulfill({status:410,json:{error:"Задача отменена"}});
      if(output.error)return route.fulfill({status:502,json:{error:output.error}});
      const result={...output,messageId:await derivedID(body.id,100),completedAt:new Date().toISOString()};
      user.transcript=result.transcript || "";user.seq=++seq;
      archive.push({id:result.messageId,taskId:body.taskId,role:"assistant",text:result.text,result,replyTo:body.id,createdAt:result.completedAt,seq:++seq,status:"open",deleted:false});
      return route.fulfill({json:result});
    }
    if(path.endsWith("/chat/delete")){
      const clearing=body.clear&&body.epoch===epoch;if(clearing)epoch++;
      const tasks=new Set(archive.filter(m=>clearing||body.ids?.includes(m.id)).map(m=>m.taskId));
      for(const m of archive)if(tasks.has(m.taskId)){if(m.status!=="applied")m.status="cancelled";if(clearing||body.ids?.includes(m.id))m.deleted=true;m.seq=++seq;}
      return route.fulfill({json:{deleted:archive.filter(m=>m.deleted).map(m=>m.id)}});
    }
    if(path.endsWith("/chat/import")){
      for(const m of body.messages)if(!archive.some(x=>x.id===m.id))archive.push({...m,seq:++seq,status:"cancelled",deleted:false});
      return route.fulfill({json:{ok:true}});
    }
    if(path.endsWith("/chat")){
      let rows;
      if(url.searchParams.has("after"))rows=archive.filter(m=>m.seq>Number(url.searchParams.get("after"))).sort((a,b)=>a.seq-b.seq);
      else {
        rows=archive.filter(m=>!m.deleted).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id));
        const before=url.searchParams.get("before");if(before){const [date,id]=before.split("|");rows=rows.filter(m=>m.createdAt<date||(m.createdAt===date&&m.id<id));}
      }
      const more=rows.length>50;rows=rows.slice(0,50);const last=rows.at(-1);
      return route.fulfill({json:{messages:rows,epoch,cursor:more&&url.searchParams.has("after")?last.seq:seq,more,before:last?last.createdAt+"|"+last.id:""}});
    }
    if(path.includes("/chat/media/"))return route.fulfill({json:{ok:true}});
    if(path.endsWith("/sync")||path.endsWith("/apply")){
      const commands=body?.commands || [];
      for(const c of commands){const key={entry:"entries",category:"categories",account:"accounts"}[c.entity];state[key]=[...state[key].filter(x=>x.id!==c.data.id),{...c.data,version:++revision}];}
      if(path.endsWith("/apply")){const task=path.split("/").at(-2);for(const m of archive)if(m.taskId===task){m.status="applied";m.appliedIDs=commands.map(c=>c.data.id);m.seq=++seq;}}
      return route.fulfill({json:{state,revision,results:commands.map(c=>({id:c.id,status:"ok",version:state[{entry:"entries",category:"categories",account:"accounts"}[c.entity]].find(x=>x.id===c.data.id).version}))}});
    }
    return route.fulfill({json:path==="/api/me"?{user:{id:owner,nickname:"Тест"},books:[],aiAvailable:true}:[]});
  });
  await page.goto("/");await page.waitForFunction(()=>window.__financeReady);
  await page.evaluate(async owner=>{const db=await import('/db.js');await db.setMeta("settings",{...await db.meta("settings"),connected:true,userId:owner});},owner);
  await page.reload();await page.waitForFunction(()=>window.__financeReady);await page.getByRole("link",{name:"Помощник",exact:true}).click();
  return {inputs,archive,seed:rows=>{for(const row of rows)archive.push({...row,seq:++seq});}};
}
export async function send(page,inputs,text){
  const count=inputs.length;
  await page.locator("#ai-text").fill(text);await page.getByRole("button",{name:"Отправить",exact:true}).click();
  await expect.poll(()=>inputs.length).toBe(count+1);
  await expect.poll(()=>page.evaluate(async()=>((await(await import('/db.js')).meta('ai-queue')) || []).length)).toBe(0);
}
