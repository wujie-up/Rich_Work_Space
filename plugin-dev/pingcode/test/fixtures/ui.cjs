const { app, BrowserWindow, protocol, net } = require('electron');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

app.setPath('userData', process.argv.find(value => value.startsWith('--test-data=')).slice(12));
protocol.registerSchemesAsPrivileged(['desk-host', 'desk-plugin'].map(scheme => ({
  scheme, privileges: { standard: true, secure: true }
})));
app.whenReady().then(async () => {
  protocol.handle('desk-plugin', request => net.fetch(pathToFileURL(resolve('plugin-dev/pingcode',
    new URL(request.url).pathname.slice(1))).href));
  protocol.handle('desk-host', () => new Response(`<!doctype html><meta charset="UTF-8">
    <style>html,body{height:100%;margin:0;overflow:hidden}iframe{width:100%;height:100%;border:0;display:block}</style>
    <iframe src="desk-plugin://pingcode/dist/renderer/index.html" sandbox="allow-scripts allow-same-origin"></iframe>
    <script>
    window.fixture = { failTasks:false, slow:false, calls:[], session:{state:'closed',epoch:'initial',error:null}, projects:[{id:'project',name:'全平台开发任务'}], settings:{apiRoot:'https://open.pingcode.com',
      site:'https://example.pingcode.com',authMode:'token',webMode:'window',clientId:'',hasAccessToken:true,hasClientSecret:false,
      projectId:'project',valueKey:'renwujiazhifen',revision:'v1'} };
    const jobs=new Map();let sequence=0;
    const configuration=()=>({...fixture.settings,webSession:{...fixture.session},revision:fixture.settings.authMode==='web'?
      fixture.settings.revision+':'+fixture.session.epoch:fixture.settings.revision});
    const members=[{id:'one',name:'吴杰',username:'wujie-1'},{id:'two',name:'吴杰',username:'wujie-2'}];
    const now=new Date();const monthStart=new Date(now.getFullYear(),now.getMonth(),1).getTime()/1000;
    const tasks=[5,0.1,'0.2',null,'bad'].map((score,index)=>({id:String(index),number:'DKY-'+index,
      title:index===0?'<img src=x onerror=alert(1)>': '任务 '+index,score,assignee:'吴杰',project:'全平台开发任务',
      createdAt:index===1?monthStart-1:monthStart+86400,completedAt:index===0?null:monthStart+86400,
      stateId:index===0?'open':'done',state:index===0?'进行中':'已完成',url:'https://example.pingcode.com/pjm/workitems/'+index}));
    window.addEventListener('message',event=>{
      const {type,id,method,args}=event.data;
      if(type!=='desk:invoke')return;
      let value;let error;
      if(method==='host.openExternal'){(fixture.externalCalls||=[]).push(args[0]);}
      if(method==='storage.getPreferences')value={theme:'light'};
      if(method==='plugin.invoke'){
        const [name,input]=args;fixture.calls.push({name,args:input});
        if(name==='pingcode.settings')value=configuration();
        if(name==='pingcode.session')value={...fixture.session};
        if(name==='pingcode.login'){fixture.session={...fixture.session,state:'needs-login',epoch:'login',error:null};value={...fixture.session};
          if(fixture.session.transport==='extension'&&!fixture.session.extensionConnected)value.pairingUrl='http://127.0.0.1:12345/pair#'+'a'.repeat(43);}
        if(name==='pingcode.checkLogin'){
          if(fixture.checkError)error={message:'浏览器连接检查失败',code:'WEB_REQUEST_FAILED'};
          else{fixture.session={...fixture.session,state:'connected',epoch:'checked',error:null};value={...fixture.session};}
        }
        if(name==='pingcode.logout'){fixture.session={...fixture.session,state:'closed',extensionConnected:false,epoch:'logout',error:null};value={...fixture.session};}
        if(name==='pingcode.saveSettings'){
          const change=input[0];for(const [key,v]of Object.entries(change)){
            if(!['accessToken','clientSecret','clearAccessToken','clearClientSecret'].includes(key))fixture.settings[key]=v;
          }
          if(change.accessToken)fixture.settings.hasAccessToken=true;
          if(change.clearAccessToken)fixture.settings.hasAccessToken=false;
          if(change.clientSecret)fixture.settings.hasClientSecret=true;
          if(change.clearClientSecret)fixture.settings.hasClientSecret=false;
          fixture.settings.revision='v2';value=configuration();
        }
        if(name==='pingcode.start'){
          const query=input[0];const job={id:String(++sequence),kind:query.kind,state:'running',revision:configuration().revision,
            progress:{loaded:2,total:5},polls:0,query};jobs.set(job.id,job);value={id:job.id,revision:job.revision};
        }
        if(name==='pingcode.status'){
          const job=jobs.get(input[0]);job.polls++;
          if(fixture.progressPhase)job.progress.phase=fixture.progressPhase;
          if(fixture.cancelTasks&&job.kind==='tasks')job.state='cancelled';
          if(job.state==='running'&&job.polls>1&&!fixture.slow){
            job.state=fixture.failTasks&&job.kind==='tasks'?'failed':'complete';
            if(job.state==='failed')job.error={message:'第二页读取失败'};
            else {
              let selected=tasks;
              if(job.query.month){
                const [year,month]=job.query.month.split('-').map(Number);
                const start=new Date(year,month-1,1).getTime()/1000;const end=new Date(year,month,1).getTime()/1000;
                const field=job.query.dateField||'completedAt';selected=tasks.filter(row=>Number.isFinite(row[field])&&row[field]>=start&&row[field]<end);
              }
              job.result=job.kind==='members'?(fixture.members||members):job.kind==='projects'?fixture.projects:selected;
            }
            job.completedAt=Date.now();
          }value={...job};
        }
        if(name==='pingcode.cancel'){const job=jobs.get(input[0]);job.state='cancelled';}
      }
      const delay=method==='plugin.invoke'&&args[0]==='pingcode.settings'?(fixture.delaySettings||0):0;
      setTimeout(()=>event.source.postMessage({type:'desk:result',id,value,error},event.origin),delay);
    });
    </script>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
  const window = new BrowserWindow({ width: 1100, height: 760, webPreferences: { sandbox: true, contextIsolation: true } });
  await window.loadURL('desk-host://desktop/index.html');
});
app.on('window-all-closed', () => app.quit());
