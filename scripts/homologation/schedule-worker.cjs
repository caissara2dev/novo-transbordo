/* eslint-disable @typescript-eslint/no-require-imports -- Firebase CLI administrative SDK is CommonJS. */
const {request,project}=require('./cloud.cjs');
(async()=>{
 const region='us-central1',id='checkin-document-worker',sa=`${id}@${project}.iam.gserviceaccount.com`;
 const service=await request('run.googleapis.com',`/v2/projects/${project}/locations/${region}/services/${id}`);
 if(!service.uri)throw new Error('Cloud Run service is still starting');
 const name=`projects/${project}/locations/${region}/jobs/checkin-documents-maintenance`;
 const job={name,schedule:'*/5 * * * *',timeZone:'Etc/UTC',attemptDeadline:'240s',httpTarget:{uri:service.uri+'/run',httpMethod:'POST',oidcToken:{serviceAccountEmail:sa,audience:service.uri}}};
 let exists=true;try{await request('cloudscheduler.googleapis.com','/v1/'+name);}catch(e){if(!e.message.includes('404'))throw e;exists=false;}
 const result=exists?await request('cloudscheduler.googleapis.com','/v1/'+name,'PATCH',job):await request('cloudscheduler.googleapis.com',`/v1/projects/${project}/locations/${region}/jobs`,'POST',job);
 console.log(JSON.stringify({worker:service.uri,schedule:result.schedule,job:result.name}));
})().catch(e=>{console.error(e.message);process.exitCode=1;});
