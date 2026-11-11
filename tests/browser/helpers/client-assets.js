import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

// Fixtures use the same compiled React output as the packaged Go server.
export async function clientAsset(file, release='dev') {
  if (file==='sw.js') {
    let source=await readFile(resolve('backend/web/sw.js'),'utf8');
    const assets=await readdir(resolve('backend/react-web/dist/assets'));
    const paths=['/','/index.html','/db.js','/chat-db.js','/sync.js','/model.js','/icons.js','/release.js','/i18n.js','/en.js','/en-screens.js','/en-forms.js','/manifest.webmanifest','/icon.svg','/icon-180.png','/icon-192.png','/icon-512.png',...assets.map(name=>'/assets/'+name)];
    source=source.replace(/const ASSETS = \[[\s\S]*?\];/,'const ASSETS = '+JSON.stringify(paths)+';');
    return Buffer.from(source.replace('finance-dev','finance-'+release));
  }
  if(file==='index.html'||file.startsWith('assets/'))return readFile(resolve('backend/react-web/dist',file));
  return readFile(resolve('backend/web',file));
}
