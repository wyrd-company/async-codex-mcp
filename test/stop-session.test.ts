// ---
// relationships:
//   verifies: server
//   references: codex-client
// ---
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { SessionStore } from "../src/session-store.js";
import { isProcessAlive } from "../src/process-liveness.js";
import { close, connect } from "./mcp-testing-kit-shim.js";
const payload = (result: any) => JSON.parse(result.content[0].text);
let directory: string;
let server: ReturnType<typeof createServer>;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), "stop-session-")); });
afterEach(async () => { if(server) await close(server.server as never); fs.rmSync(directory,{recursive:true,force:true}); });
async function setup(initializing = false) {
 const config = loadConfig();
 config.codex.command = process.execPath;
 config.codex.args = initializing ? ['-e',`require('fs').writeFileSync(process.env.CONTROL_DIR+'/initializing.json',JSON.stringify({pid:process.pid}));process.stdin.resume()`] : [fileURLToPath(new URL('./fixtures/app-server.mjs',import.meta.url))];
 config.codex.env = { CONTROL_DIR: directory };
 const store = new SessionStore({directory:path.join(directory,'sessions')});
 server = createServer(config,{store});
 return {client:await connect(server.server as never),store};
}
async function marker(key: string) {
 const file=path.join(directory,key+'.json');
 await expect.poll(()=>fs.existsSync(file)).toBe(true);
 return JSON.parse(fs.readFileSync(file,'utf8'));
}
describe('stop-session',()=>{
 it.each([false,true])('stops a process while waiting for input=%s and preserves another active session',async(waiting)=>{
  const {client,store}=await setup();
  const a=payload(await client.callTool('codex',{prompt:'hold:alpha'})).session_id;
  const b=payload(await client.callTool('codex',{prompt:'hold:beta'})).session_id;
  const first=await marker('alpha');const second=await marker('beta');
  expect(first.pid).not.toBe(second.pid);
  let ask:Promise<Response>|undefined;
  if(waiting){
   const args=first.profile.config.mcp_servers.async_codex_mcp_callback.args;
   ask=fetch(args[args.indexOf('--url')+1]+'/ask',{method:'POST',headers:{authorization:'Bearer '+args[args.indexOf('--token')+1],'content-type':'application/json'},body:JSON.stringify({session_id:a,round:1,message:'Choose a sample.'})});
   await expect.poll(()=>store.get(a)?.status).toBe('waiting_for_input');
  }
  const stopped=await client.callTool('stop-session',{session_id:a});
  expect(stopped.isError).not.toBe(true);
  expect(payload(stopped)).toEqual({session_id:a,status:'stopped'});
  expect(isProcessAlive(first.pid)).toBe(false);
  expect(isProcessAlive(second.pid)).toBe(true);
  expect(store.get(b)?.status).toBe('running');
  if(ask) expect((await ask).status).toBe(500);
  expect((await client.callTool('answer-session',{session_id:a,message:'late'})).isError).toBe(true);
  expect((await client.callTool('continue-session',{session_id:a,prompt:'late'})).isError).toBe(true);
  expect((await client.callTool('stop-session',{session_id:a})).isError).toBe(true);
  expect(new SessionStore({directory:path.join(directory,'sessions')}).get(a)?.status).toBe('stopped');
  fs.writeFileSync(path.join(directory,'beta.finish'),'');
  await expect.poll(()=>store.get(b)?.status).toBe('completed');
 });
 it('resumes in a fresh process with new callback arguments and persists the second result',async()=>{
  const {client,store}=await setup();
  const id=payload(await client.callTool('codex',{prompt:'hold:alpha'})).session_id;
  const first=await marker('alpha');
  fs.writeFileSync(path.join(directory,'alpha.finish'),'');
  await expect.poll(()=>isProcessAlive(first.pid)).toBe(false);
  const continued=client.callTool('continue-session',{session_id:id,prompt:'hold:beta'});
  const second=await marker('beta');
  expect(second.pid).not.toBe(first.pid);
  expect(store.get(id)).toMatchObject({round:2,status:'running',result:undefined});
  const args=second.profile.config.mcp_servers.async_codex_mcp_callback.args;
  expect(args[args.indexOf('--round')+1]).toBe('2');
  const callback=(round:number)=>fetch(args[args.indexOf('--url')+1]+'/notify',{method:'POST',headers:{authorization:'Bearer '+args[args.indexOf('--token')+1],'content-type':'application/json'},body:JSON.stringify({session_id:id,round,message:'Sample progress.'})});
  expect((await callback(1)).status).toBe(409);
  expect((await callback(2)).status).toBe(200);
  fs.writeFileSync(path.join(directory,'beta.finish'),'');
  expect((await continued).content).toEqual([{type:'text',text:'finished beta'}]);
  const persisted=new SessionStore({directory:path.join(directory,'sessions')}).get(id);
  expect(persisted).toMatchObject({round:2,status:'completed',result:{content:[{type:'text',text:'finished beta'}]}});
 });
 it('stops during app-server initialization before any thread exists',async()=>{
  const {client,store}=await setup(true);
  const id=payload(await client.callTool('codex',{prompt:'sample'})).session_id;
  const backend=await marker('initializing');
  expect(payload(await client.callTool('stop-session',{session_id:id})).status).toBe('stopped');
  expect(isProcessAlive(backend.pid)).toBe(false);
  expect(store.get(id)?.status).toBe('stopped');
 });
 it('rejects unknown, terminal and foreign live records without mutation',async()=>{
  const {client,store}=await setup();
  expect((await client.callTool('stop-session',{session_id:'missing'})).isError).toBe(true);
  const terminal=store.create({toolName:'codex',prompt:'sample'});store.complete(terminal.id,{content:[]},'thread-sample');
  const before=JSON.stringify(terminal);
  const terminalResult=await client.callTool('stop-session',{session_id:terminal.id});
  expect(terminalResult.isError).toBe(true);
  expect((terminalResult.content[0] as {text:string}).text).toContain('is completed');
  expect(JSON.stringify(terminal)).toBe(before);
  const foreign=store.create({toolName:'codex',prompt:'foreign'});
  expect((await client.callTool('stop-session',{session_id:foreign.id})).isError).toBe(true);
  expect(foreign.status).toBe('running');
 });
});
