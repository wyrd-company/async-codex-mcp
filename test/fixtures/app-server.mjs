// ---
// relationships:
//   references: codex-client
// ---
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
let initialized = false;
let sequence = 0;
const threads = new Map();
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
 const request = JSON.parse(line);
 const {id, method, params} = request;
 if (method === 'initialize') return send({id, result: {userAgent:'fixture'}});
 if (method === 'initialized') { initialized = true; return; }
 if (!initialized) return send({id,error:{code:-32600,message:'Not initialized'}});
 if (method === 'thread/start') {
  const threadId = `thread-${++sequence}`;
  threads.set(threadId, params);
  return send({id,result:{thread:{id:threadId}}});
 }
 if (method === 'thread/resume') { threads.set(params.threadId, {resumed:true,...Object.fromEntries(Object.entries(params).filter(([key])=>key!=='threadId'))}); return send({id,result:{thread:{id:params.threadId}}}); }
 if (method === 'turn/interrupt') {
  if(process.env.INTERRUPT_MARKER) fs.writeFileSync(process.env.INTERRUPT_MARKER, JSON.stringify(params));
  return send({id,result:{}});
 }
 if (method === 'turn/start') {
  const text = params.input[0].text;
  if(text === 'crash') return process.exit(7);
  if(text === 'invalid') return process.stdout.write('not-json\n');
  if(text.startsWith('hold:') && process.env.CONTROL_DIR) {
   const key = text.slice(5);
   const directory = process.env.CONTROL_DIR;
   const watcher = fs.watch(directory, () => {
    if (!fs.existsSync(path.join(directory, key + '.finish'))) return;
    watcher.close();
    send({method:'turn/completed',params:{threadId:params.threadId,turn:{id:'held-turn',status:'completed',items:[{id:'message',type:'agentMessage',text:'finished '+key}]}}});
   });
   fs.writeFileSync(path.join(directory,key+'.json'), JSON.stringify({pid:process.pid,profile:threads.get(params.threadId)}));
   return send({id,result:{turn:{id:'held-turn'}}});
  }
  if(text === 'hold') return send({id,result:{turn:{id:'held-turn'}}});
  if(!Array.isArray(params.input[0].text_elements)) return send({id,error:{code:-32602,message:'text_elements required'}});
  if(text === 'rpc-error') return send({id,error:{code:-32602,message:'Invalid turn'}});
  const turnId = `turn-${params.threadId}`;
  send({method:'item/completed',params:{threadId:params.threadId,turnId,item:{id:'message',type:'agentMessage',text:JSON.stringify({text,profile:threads.get(params.threadId)})}}});
  send({method:'turn/completed',params:{threadId:params.threadId,turn:{id:turnId,status:text === 'fail' ? 'failed' : text === 'interrupt' ? 'interrupted' : 'completed',items:[],error:text==='fail'?{message:'fixture failure'}:null}}});
  // Deliberately complete before acknowledging turn/start.
  send({id,result:{turn:{id:turnId,status:'inProgress'}}});
 }
});
