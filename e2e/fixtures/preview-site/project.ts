import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * The page's own `<title>`, which discovery reads and the preview picker puts
 * in its row label. Spec 48 and the demo capture click that label, so the
 * three of them name the page from here rather than in triplicate.
 */
export const PREVIEW_SITE_TITLE = "Northstar Studio";

/** A sample website with one real filter bug for an agent to fix on camera. */
export function writePreviewProject(directory: string) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({ name: "northstar-website", type: "module", scripts: { test: "bun test", dev: "bun server.ts" } }),
  );
  writeFileSync(
    path.join(directory, "AGENTS.md"),
    "Work only in this sample project. Fix the requested website behavior and run bun test. Do not start a server or use MCP tools or other agents. Keep the final response brief.\n",
  );
  writeFileSync(
    path.join(directory, "filter.js"),
    `export function filterProjects(projects, category) {
  // TODO: return only the selected category, or every project for all.
  return projects;
}\n`,
  );
  writeFileSync(
    path.join(directory, "index.html"),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${PREVIEW_SITE_TITLE}</title><style>
*{box-sizing:border-box}body{margin:0;background:#f5f3ec;color:#20362f;font:16px/1.45 system-ui,sans-serif}main{max-width:1000px;margin:auto;padding:24px}header{display:flex;align-items:center;justify-content:space-between;padding-bottom:24px;border-bottom:1px solid #c9cec2}header strong{font-size:18px;letter-spacing:-.04em}header span{font-size:12px}.eyebrow{margin:26px 0 10px;font-size:11px;letter-spacing:.15em;text-transform:uppercase}h1{font-size:clamp(29px,5vw,48px);line-height:1.05;letter-spacing:-.045em;margin:0 0 14px;max-width:560px}.intro{font-size:14px;max-width:480px;color:#59695c}.work{display:flex;align-items:center;justify-content:space-between;margin:25px 0 12px}.work h2{font-size:17px;margin:0}.count{font-size:12px;color:#59695c}nav{display:flex;gap:6px;margin-bottom:16px}button{border:1px solid #c9cec2;border-radius:20px;padding:7px 14px;background:transparent;color:inherit;cursor:pointer;font:inherit;font-size:12px}button[aria-pressed=true]{background:#20362f;color:#fff;border-color:#20362f}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}article{border:1px solid #c9cec2;border-radius:10px;overflow:hidden}.art{height:82px;padding:14px;font-size:28px;letter-spacing:-.06em;font-weight:700}.moss{background:#dae7bb}.peach{background:#f1c9ae}.sky{background:#c6dae5}.detail{padding:10px 12px}.detail h3{margin:0;font-size:14px}.detail p{margin:2px 0 0;color:#59695c;font-size:11px}footer{margin-top:24px;font-size:11px;color:#59695c}@media(max-width:420px){main{padding:18px}.grid{grid-template-columns:1fr}.art{height:66px}header span{font-size:10px}}
</style></head><body><main><header><strong>northstar.</strong><span>Independent design studio</span></header><p class="eyebrow">Design &amp; development</p><h1>Small teams.<br>Considered websites.</h1><p class="intro">Thoughtful digital spaces for people making something worth sharing.</p><div class="work"><h2>Selected work</h2><span class="count" aria-live="polite">3 projects</span></div><nav aria-label="Project categories"><button aria-pressed="true" data-category="all">All</button><button aria-pressed="false" data-category="website">Websites</button><button aria-pressed="false" data-category="brand">Brand</button></nav><section class="grid" aria-label="Projects"></section><footer>Built with care. Ready to explore.</footer></main><script type="module">
import { filterProjects } from './filter.js';
const projects=[{name:'Moss & Field',type:'Website',category:'website',art:'moss',mark:'M/F'},{name:'Sunday Goods',type:'Brand identity',category:'brand',art:'peach',mark:'sunday'},{name:'Open Water',type:'Website',category:'website',art:'sky',mark:'ow.'}];
function render(category){const shown=filterProjects(projects,category);document.querySelector('.count').textContent=shown.length+' '+(shown.length===1?'project':'projects');document.querySelector('.grid').innerHTML=shown.map(p=>'<article><div class="art '+p.art+'">'+p.mark+'</div><div class="detail"><h3>'+p.name+'</h3><p>'+p.type+'</p></div></article>').join('');document.querySelectorAll('nav button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.category===category)));}
document.querySelectorAll('nav button').forEach(b=>b.addEventListener('click',()=>render(b.dataset.category)));render('all');
</script></body></html>`,
  );
  writeFileSync(path.join(directory, "worker.js"), "self.addEventListener('fetch', () => {});\n");
  writeFileSync(
    path.join(directory, "server.ts"),
    `import { readFileSync } from 'node:fs';
import path from 'node:path';
const root=import.meta.dirname;
const app=Bun.serve({hostname:'127.0.0.1',port:Number(process.env.DEMO_PORT||3000),fetch(req,server){
 const url=new URL(req.url);
 if(url.pathname==='/socket'){if(server.upgrade(req,{data:0}))return;return new Response('Upgrade required',{status:426});}
 if(url.pathname==='/echo')return Response.json({method:req.method});
 const file=url.pathname==='/'?'index.html':url.pathname.slice(1);
 if(!['index.html','filter.js','worker.js'].includes(file))return new Response('Not found',{status:404});
 return new Response(readFileSync(path.join(root,file)),{headers:{'content-type':file.endsWith('.js')?'text/javascript':'text/html','cache-control':'no-store','set-cookie':'demo=website; Path=/; HttpOnly'}});
},websocket:{message(ws,message){ws.send(message)}}});
console.log('Northstar website ready on http://127.0.0.1:'+app.port);\n`,
  );
}
