/* eslint-disable @typescript-eslint/no-require-imports -- Firebase CLI administrative SDK is CommonJS. */
const {request,project}=require('./cloud.cjs');const fs=require('node:fs');
(async()=>{
 const region='us-central1',id='checkin-document-worker',name=`projects/${project}/locations/${region}/services/${id}`,sa=`${id}@${project}.iam.gserviceaccount.com`;
 const saved=JSON.parse(fs.readFileSync('/tmp/checkin-nf-worker-build.json'));
 const body={name,ingress:'INGRESS_TRAFFIC_ALL',template:{serviceAccount:sa,maxInstanceRequestConcurrency:1,timeout:'240s',scaling:{minInstanceCount:0,maxInstanceCount:1},containers:[{image:saved.image,resources:{cpuIdle:true,limits:{cpu:'1',memory:'1Gi'}},env:[{name:'GOOGLE_CLOUD_PROJECT',value:project},{name:'CHECKIN_DOCUMENT_BUCKET',value:`${project}-checkin-nf`}]}]}};
 let existing;try{existing=await request('run.googleapis.com','/v2/'+name);}catch(e){if(!e.message.includes('404'))throw e;}
 if(!existing)delete body.name;
 const operation=existing?await request('run.googleapis.com','/v2/'+name,'PATCH',body):await request('run.googleapis.com',`/v2/projects/${project}/locations/${region}/services?serviceId=${id}`,'POST',body);
 console.log(JSON.stringify({operation:operation.name}));fs.writeFileSync('/tmp/checkin-nf-worker-deployment.json',JSON.stringify(operation));
 // IAM denies unauthenticated invocation; only the job's OIDC identity can call /run.
 await request('run.googleapis.com',`/v2/${name}:setIamPolicy`,'POST',{policy:{bindings:[{role:'roles/run.invoker',members:[`serviceAccount:${sa}`]}]}});
})().catch(e=>{console.error(e.message);process.exitCode=1;});
