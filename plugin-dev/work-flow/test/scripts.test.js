import test from 'node:test';
import assert from 'node:assert/strict';
import { createScriptRunner } from '../src/main/common/scripts.js';

for (const [language, code] of [['javascript', 'console.log("checked"); return {ids: input.filter(x => x.status === params.status).map(x => x.id)};'],
  ['python', 'print("checked")\nreturn {"ids": [x["id"] for x in input if x["status"] == params["status"]]}']]) {
  test(`${language} executes in a registered child with typed JSON input/output`, async () => {
    const snapshots = [];
    const runner = createScriptRunner({ ownProcesses: pids => snapshots.push([...pids]) });
    const result = await runner.run({ language, code, input: [{id:'9007199254740993',status:2},{id:'2',status:1}],
      params: {status:2}, pythonExecutable: '/usr/bin/python3', timeoutSeconds: 5, shouldStop: () => false });
    assert.deepEqual(result.value, {ids:['9007199254740993']});
    assert.match(result.stdout, /checked/);
    assert.ok(snapshots.some(pids => pids.length === 1));
    assert.deepEqual(snapshots.at(-1), []);
  });
}

test('infinite scripts time out and cancellation kills the child without hanging the plugin', async () => {
  const snapshots=[];
  const runner=createScriptRunner({ownProcesses:pids=>snapshots.push([...pids])});
  await assert.rejects(runner.run({language:'javascript',code:'while(true) {}',input:null,params:{},timeoutSeconds:1,shouldStop:()=>false}), {code:'SCRIPT_TIMEOUT'});
  for(const pids of snapshots.filter(p=>p.length)) assert.throws(()=>process.kill(pids[0],0),{code:'ESRCH'});
  let canceled=false;
  const pending=runner.run({language:'python',pythonExecutable:'/usr/bin/python3',code:'while True:\n    pass',input:null,params:{},timeoutSeconds:5,shouldStop:()=>canceled});
  setTimeout(()=>{canceled=true;},150);
  await assert.rejects(pending,{code:'SCRIPT_CANCELED'});
  assert.deepEqual(snapshots.at(-1),[]);
});

test('missing interpreter, script errors, oversized output and inherited secrets fail predictably', async () => {
  const runner=createScriptRunner();
  const base={input:null,params:{},timeoutSeconds:3,shouldStop:()=>false};
  await assert.rejects(runner.run({...base,language:'python',pythonExecutable:'/no/such/python',code:'return input'}),{code:'SCRIPT_RUNTIME_MISSING'});
  await assert.rejects(runner.run({...base,language:'javascript',code:'throw Error("fixture error")'}),/fixture error/);
  await assert.rejects(runner.run({...base,language:'javascript',code:'return "x".repeat(5*1024*1024)'}),{code:'SCRIPT_OUTPUT_LIMIT'});
  const previous=process.env.WORKFLOW_FIXTURE_SECRET;process.env.WORKFLOW_FIXTURE_SECRET='must-not-inherit';
  try {
    const result=await runner.run({...base,language:'javascript',code:'return {secret:process.env.WORKFLOW_FIXTURE_SECRET ?? null};'});
    assert.deepEqual(result.value,{secret:null});
  } finally {
    if(previous===undefined) delete process.env.WORKFLOW_FIXTURE_SECRET; else process.env.WORKFLOW_FIXTURE_SECRET=previous;
  }
});

test('Python numeric IDs cannot silently lose precision when crossing the JSON boundary', async () => {
  const runner=createScriptRunner();
  await assert.rejects(runner.run({language:'python',pythonExecutable:'/usr/bin/python3',code:'return {"id": 9007199254740993}',
    input:null,params:{},timeoutSeconds:5}),{code:'SCRIPT_NUMBER_PRECISION'});
});

test('a crashed runner parent cannot leave a looping script supervisor running', {timeout:10000}, async () => {
  const {spawn,execFileSync}=await import('node:child_process');
  const source=`import {createScriptRunner} from ${JSON.stringify(new URL('../src/main/common/scripts.js',import.meta.url).href)};
    const runner=createScriptRunner({ownProcesses:pids=>{if(pids.length)process.stdout.write(JSON.stringify(pids)+'\\n')}});
    await runner.run({language:'javascript',code:'while(true){}',timeoutSeconds:30});`;
  const parent=spawn(process.execPath,['--input-type=module','-e',source],{stdio:['ignore','pipe','ignore']});
  const pid=await new Promise((resolve,reject)=>{
    let text='';parent.stdout.on('data',chunk=>{text+=chunk;if(text.includes('\n'))resolve(JSON.parse(text.split('\n')[0])[0]);});
    parent.once('error',reject);parent.once('exit',()=>reject(Error('fixture exited before reporting supervisor')));
  });
  parent.kill('SIGKILL');
  await new Promise(resolve=>parent.once('close',resolve));
  let running=true;
  try {
    for(let i=0;i<50;i++) {
      try {running=!execFileSync('/bin/ps',['-p',String(pid),'-o','state='],{encoding:'utf8'}).trim().startsWith('Z');}
      catch(error){if(error.status===1)running=false;else throw error;}
      if(!running)break;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    assert.equal(running,false,'supervisor must terminate itself when the parent pipe closes');
  } finally {
    try {process.kill(-pid,'SIGKILL');}catch(error){if(!['ESRCH','EPERM'].includes(error.code))throw error;}
  }
});

test('returned results complete even when a descendant inherits log pipes', async () => {
  const runner=createScriptRunner();
  const result=await runner.run({language:'javascript',code:'const {spawn}=await import("node:child_process");spawn("/bin/sleep",["10"],{stdio:"inherit"});return 1;',
    input:null,params:{},timeoutSeconds:1});
  assert.equal(result.value,1);
});
