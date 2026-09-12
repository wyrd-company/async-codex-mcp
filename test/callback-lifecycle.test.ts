// ---
// relationships:
//   verifies: callback-cli
//   references: callback-hub
// ---
import { build } from "esbuild";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CallbackHub } from "../src/callback-hub.js";
import { SessionStore } from "../src/session-store.js";
let directory: string;
beforeAll(async () => {
 directory = fs.mkdtempSync(path.join(os.tmpdir(),"callback-lifecycle-"));
 await build({ entryPoints:["src/callback-cli.ts"], bundle:true, platform:"node", format:"esm", outfile:path.join(directory,"callback-cli.js"),banner:{js:"import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"} });
 fs.writeFileSync(path.join(directory,"package.json"),JSON.stringify({type:"module"}));
});
afterAll(()=>fs.rmSync(directory,{recursive:true,force:true}));
describe("callback process lifecycle",()=>{
 it.each(["completed","failed","interrupted"])("exits when its session is %s without closing stdin",async(status)=>{
  const store = new SessionStore({persistent:false});
  const session=store.create({toolName:"worker",prompt:"process a sample"});
  const hub=new CallbackHub({ask:async()=>"answer",notify:async()=>{}});
  const connection=await hub.ensureStarted();hub.beginRound(session.id,1);
  store.onChange=()=>{if(!["running","waiting_for_input"].includes(session.status))hub.endRound(session.id,1);};
  const child=spawn(process.execPath,[path.join(directory,"callback-cli.js"),"--url",connection.url,"--token",connection.token,"--session-id",session.id,"--round","1"],{stdio:["pipe","pipe","pipe"]});
  const exited=new Promise<number|null>(resolve=>child.once("exit",resolve));
  try{
   if(status==="completed")store.complete(session.id,{content:[]});
   else if(status==="failed")store.fail(session.id,"sample failure");
   else store.interruptOwned();
   expect(await exited).toBe(0);
  }finally{child.kill();await hub.close();}
 });
 it("rejects stale round callbacks while a new round is active",async()=>{
  const hub=new CallbackHub({ask:async()=>"answer",notify:async()=>{}});
  const connection=await hub.ensureStarted();hub.beginRound("sample-session",1);hub.endRound("sample-session",1);hub.beginRound("sample-session",2);
  try{
   const send=(round:number)=>fetch(`${connection.url}/notify`,{method:"POST",headers:{authorization:`Bearer ${connection.token}`,"content-type":"application/json"},body:JSON.stringify({session_id:"sample-session",round,message:"progress"})});
   expect((await send(1)).status).toBe(409);
   expect((await send(2)).status).toBe(200);
  }finally{await hub.close();}
 });
 it("starts only one hub for concurrent rounds",async()=>{
  const hub=new CallbackHub({ask:async()=>"answer",notify:async()=>{}});
  try{const connections=await Promise.all([hub.ensureStarted(),hub.ensureStarted()]);expect(connections[0]).toEqual(connections[1]);}
  finally{await hub.close();}
 });
});
