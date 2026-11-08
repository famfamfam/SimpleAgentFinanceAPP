import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { extname, resolve } from 'node:path';
import { createServer as createViteServer } from 'vite';
import { clientAsset } from './helpers/client-assets.js';

test('Vite boots with canonical shared modules from the Go server', async ({page})=>{
  const server=await createViteServer({configFile:resolve('frontend/vite.config.js'),server:{host:'127.0.0.1',port:0}});
  try {
    await server.listen();
    const origin=`http://127.0.0.1:${server.httpServer.address().port}`;
    const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    const response=await page.goto(origin);
    expect(response.status()).toBe(200);
    await page.waitForFunction(()=>window.__financeReady);
    expect((await page.request.get(origin+'/db.js')).status()).toBe(200);
    await page.getByRole('button',{name:'Добавить',exact:true}).click();
    await page.getByLabel('Сумма',{exact:true}).fill('42.50');
    expect(errors).toEqual([]);
  } finally { await server.close(); }
});

test('React release A B A switching preserves outbox, drafts and a second open form', async ({page,context})=>{
  let release='a';
  const server=createServer(async(req,res)=>{
    const path=new URL(req.url,'http://localhost').pathname;
    try{
      if(path.includes('..')||path.startsWith('/api/'))throw Error();
      const file=path==='/'?'index.html':path.slice(1);
      const content=await clientAsset(file,release);
      res.setHeader('Cache-Control','no-store');
      res.setHeader('Content-Type',{'.js':'text/javascript','.css':'text/css','.html':'text/html','.png':'image/png','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'}[extname(file)]||'application/octet-stream');
      res.end(content);
    }catch{res.writeHead(404);res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  try{
    await page.goto(origin);await page.waitForFunction(()=>window.__financeReady);
    await page.evaluate(()=>navigator.serviceWorker.ready);await page.reload();
    await page.waitForFunction(()=>navigator.serviceWorker.controller&&window.__financeReady);
    await page.getByRole('button',{name:'Добавить',exact:true}).click();
    await page.getByLabel('Сумма',{exact:true}).fill('42.50');
    await page.getByRole('button',{name:'Продукты',exact:true}).click();
    await page.getByRole('button',{name:'Сохранить',exact:true}).click();
    await expect(page.locator('#modal')).not.toBeVisible();
    await page.getByRole('link',{name:'Помощник',exact:true}).click();
    await page.locator('#ai-text').fill('Черновик для отката');
    await page.getByRole('link',{name:'Обзор',exact:true}).click();
    const before=await page.evaluate(async()=>(await import('/db.js')).load());
    const other=await context.newPage();await other.goto(origin);await other.waitForFunction(()=>window.__financeReady);
    await other.getByRole('button',{name:'Добавить',exact:true}).click();await other.getByLabel('Сумма',{exact:true}).fill('99');
    for(const next of ['b','a']){
      release=next;
      await page.evaluate(async()=>{await(await navigator.serviceWorker.ready).update();});
      await expect.poll(()=>page.evaluate(async()=>!!(await navigator.serviceWorker.ready).waiting)).toBe(true);
      await page.goto(origin+'/#assistant');await page.waitForFunction(()=>window.__financeReady);
      await expect(page.locator('#ai-text')).toHaveValue('Черновик для отката');
      await Promise.all([page.waitForNavigation(),page.locator('#app-update button').click()]);
      await page.waitForFunction(()=>window.__financeReady);
      await expect(page.locator('#ai-text')).toHaveValue('Черновик для отката');
      const after=await page.evaluate(async()=>(await import('/db.js')).load());
      expect(after.state).toEqual(before.state);expect(after.pending).toEqual(before.pending);
      expect(after.settings.bookId).toBe(before.settings.bookId);
      await expect(other.getByLabel('Сумма',{exact:true})).toHaveValue('99');
    }
    await other.close();
  }finally{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});}
});
