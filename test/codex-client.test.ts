// ---
// relationships:
//   references: codex-client
// ---
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "../src/codex-client.js";
import { loadConfig } from "../src/config.js";
const clients: CodexAppServerClient[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(clients.splice(0).map(client => client.close())); });
function setup(args = [fileURLToPath(new URL("./fixtures/app-server.mjs", import.meta.url))]) {
 const config = loadConfig();
 config.codex.command = process.execPath;
 config.codex.args = args;
 const client = new CodexAppServerClient(config);
 clients.push(client);
 return {client,profile: config.tools.codex};
}
describe("Codex app-server process adapter", () => {
 it("maps profiles, preserves thread ids, and waits for completion even before turn/start response", async () => {
  const {client,profile} = setup();
  const result = await client.callCodex({...profile, model:'profile-model',sandboxMode:'read-only',approvalPolicy:'never',baseInstructions:'Base',developerInstructions:'Developer',compactPrompt:'Compact',config:{feature:true}}, {prompt:'Hello',model:'override-model',cwd:'/tmp'});
  expect(result._meta).toEqual({threadId:'thread-1'});
  expect(JSON.parse((result.content[0] as {text:string}).text)).toEqual({text:'Hello',profile:{model:'override-model',cwd:'/tmp',sandbox:'read-only',approvalPolicy:'never',baseInstructions:'Base',developerInstructions:'Developer',config:{feature:true,compact_prompt:'Compact'}}});
 });
 it("multiplexes concurrent first calls through a single initialized connection", async () => {
  const {client,profile}=setup();
  const results=await Promise.all(['one','two','three'].map(prompt=>client.callCodex(profile,{prompt})));
  expect(results.map(result=>result._meta?.threadId)).toEqual(['thread-1','thread-2','thread-3']);
 });
 it("resumes durable threads on a new process", async () => {
  const {client,profile}=setup();
  const first=await client.callCodex(profile,{prompt:'first'});
  await client.close();
  const second=setup().client;
  const result=await second.continueSession(first._meta!.threadId as string,'second','/tmp');
  expect(JSON.parse((result.content[0] as {text:string}).text)).toEqual({text:'second',profile:{resumed:true,cwd:'/tmp'}});
 });
 it.each(['fail','interrupt','rpc-error'])("settles %s turns as failures",async(prompt)=>{
  const {client,profile}=setup();
  await expect(client.callCodex(profile,{prompt})).rejects.toThrow(/fixture failure|interrupted|Invalid turn/);
 });
 it("reports missing interface at the real spawn boundary and permits retry",async()=>{
  const {client,profile}=setup(['-e','process.exit(2)']);
  await expect(client.callCodex(profile,{prompt:'hello'})).rejects.toThrow(/requires the app-server interface/);
  await expect(client.callCodex(profile,{prompt:'again'})).rejects.toThrow(/requires the app-server interface/);
 });
 it("settles all pending work on process exit and reconnects",async()=>{
  const {client,profile}=setup();
  const results=await Promise.allSettled(['hold','crash'].map(prompt=>client.callCodex(profile,{prompt})));
  expect(results.every(result=>result.status==='rejected')).toBe(true);
  await expect(client.callCodex(profile,{prompt:'recovered'})).resolves.toMatchObject({_meta:{threadId:'thread-1'}});
 });
 it("rejects malformed stdout and closes cleanly",async()=>{
  const {client,profile}=setup();
  await expect(client.callCodex(profile,{prompt:'invalid'})).rejects.toThrow(/invalid JSONL/);
 });
 it("retains the previous 60-second initialization limit",async()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
  const {client,profile}=setup(['-e','process.stdin.resume()']);
  const assertion=expect(client.callCodex(profile,{prompt:'hello'})).rejects.toThrow(/initialize exceeded its 60s wait limit/);
  await vi.advanceTimersByTimeAsync(60_000);
  await assertion;
 });
 it("interrupts a timed-out turn",async()=>{
  const directory=fs.mkdtempSync('/tmp/codex-interrupt-');
  const marker=directory+'/interrupted.json';
  const config=loadConfig();
  config.codex.command=process.execPath;
  config.codex.args=[fileURLToPath(new URL('./fixtures/app-server.mjs',import.meta.url))];
  config.codex.env={INTERRUPT_MARKER:marker};
  config.codex.requestTimeoutSec=1;
  const client=new CodexAppServerClient(config); clients.push(client);
  try {
   await expect(client.callCodex(config.tools.codex,{prompt:'hold'})).rejects.toThrow(/exceeded codex.requestTimeoutSec/);
   await expect.poll(()=>fs.existsSync(marker)).toBe(true);
   expect(JSON.parse(fs.readFileSync(marker,'utf8'))).toEqual({threadId:'thread-1',turnId:'held-turn'});
  } finally { await client.close();fs.rmSync(directory,{recursive:true,force:true}); }
 });
 it("names the interface when the executable is missing",async()=>{
  const config=loadConfig(); config.codex.command='/missing-codex-executable';
  const client=new CodexAppServerClient(config); clients.push(client);
  await expect(client.callCodex(config.tools.codex,{prompt:'hello'})).rejects.toThrow(/Cannot start Codex app-server/);
 });
 it("closes while initialization is still pending",async()=>{
  const {client,profile}=setup(['-e','process.stdin.resume()']);
  const pending=client.callCodex(profile,{prompt:'hello'});
  const assertion=expect(pending).rejects.toThrow(/closed/);
  await client.close();
  await assertion;
 });
 it("uses app-server by default and translates explicit legacy launch arguments",async()=>{
  expect(loadConfig().codex.args).toEqual(['app-server']);
  const {client,profile}=setup(['-e','if(process.argv[1]!=="app-server")process.exit(2);import(process.env.APP_SERVER_FIXTURE)','--','mcp-server']);
  // Test the actual argv delivered to the spawned child.
  process.env.APP_SERVER_FIXTURE=new URL('./fixtures/app-server.mjs',import.meta.url).href;
  try { await expect(client.callCodex(profile,{prompt:'hello'})).resolves.toMatchObject({_meta:{threadId:'thread-1'}}); }
  finally { delete process.env.APP_SERVER_FIXTURE; }
 });
 it("rejects pending work on shutdown",async()=>{
  const {client,profile}=setup();
  const pending=client.callCodex(profile,{prompt:'hold'});
  const assertion=expect(pending).rejects.toThrow(/closed/);
  await client.close();
  await assertion;
 });
});
