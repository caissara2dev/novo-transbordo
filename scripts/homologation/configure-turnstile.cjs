/* eslint-disable @typescript-eslint/no-require-imports -- Firebase CLI administrative SDK is CommonJS. */
const {request,project}=require('./cloud.cjs');const fs=require('node:fs');
(async()=>{
 const value=JSON.parse(fs.readFileSync('/tmp/checkin-nf-turnstile.json','utf8'));
 const base=`/v1/projects/${project}/secrets/CHECKIN_NF_TURNSTILE`;
 let exists=true;try{await request('secretmanager.googleapis.com',base);}catch(e){if(!e.message.includes('404'))throw e;exists=false;}
 if(!exists){await request('secretmanager.googleapis.com',`/v1/projects/${project}/secrets?secretId=CHECKIN_NF_TURNSTILE`,'POST',{replication:{automatic:{}},labels:{environment:'homologation'}});await request('secretmanager.googleapis.com',base+':addVersion','POST',{payload:{data:Buffer.from(value.secretKey).toString('base64')}});}
 const policy={bindings:[{role:'roles/secretmanager.secretAccessor',members:[`serviceAccount:checkin-portal-nf@${project}.iam.gserviceaccount.com`,`serviceAccount:service-431638748152@gcp-sa-firebaseapphosting.iam.gserviceaccount.com`]}]};
 await request('secretmanager.googleapis.com',base+':setIamPolicy','POST',{policy});console.log('Turnstile secret configured in staging Secret Manager.');
})().catch(e=>{console.error(e.message);process.exitCode=1;});
