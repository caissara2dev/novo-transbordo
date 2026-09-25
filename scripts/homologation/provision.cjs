/* eslint-disable @typescript-eslint/no-require-imports -- Firebase CLI administrative SDK is CommonJS. */
const {request,project}=require('./cloud.cjs');
const {randomBytes}=require('node:crypto');const fs=require('node:fs');
const number='431638748152',region='us-central1',bucket=`${project}-checkin-nf`;
const appSA=`firebase-app-hosting-compute@${project}.iam.gserviceaccount.com`;
const portalSA=`checkin-portal-nf@${project}.iam.gserviceaccount.com`;
const workerSA=`checkin-document-worker@${project}.iam.gserviceaccount.com`;
async function allow(host,path,bindings) {const policy=await request(host,path+':getIamPolicy',host==='secretmanager.googleapis.com'?'GET':'POST',host==='secretmanager.googleapis.com'?undefined:{});policy.bindings??=[];for(const [role,members]of bindings){let binding=policy.bindings.find(b=>b.role===role&&!b.condition);if(!binding){binding={role,members:[]};policy.bindings.push(binding);}for(const member of members)if(!binding.members.includes(member))binding.members.push(member);}await request(host,path+':setIamPolicy','POST',{policy});}
async function exists(host,path) {try{return await request(host,path);}catch(e){if(e.status===404||e.message.includes('404')||e.message.includes('NOT_FOUND'))return null;throw e;}}
(async()=>{
 for(const api of ['run.googleapis.com','cloudbuild.googleapis.com','artifactregistry.googleapis.com','cloudscheduler.googleapis.com','secretmanager.googleapis.com','iamcredentials.googleapis.com','storage.googleapis.com']){
  await request('serviceusage.googleapis.com',`/v1/projects/${number}/services/${api}:enable`,'POST',{});console.log(`API ready: ${api}`);
 }
 for(const id of ['checkin-portal-nf','checkin-document-worker']){
  const name=`projects/${project}/serviceAccounts/${id}@${project}.iam.gserviceaccount.com`;
  if(!await exists('iam.googleapis.com',`/v1/${name}`))await request('iam.googleapis.com',`/v1/projects/${project}/serviceAccounts`,'POST',{accountId:id,serviceAccount:{displayName:`Homologation ${id}`}});
 }
 await request('firebaseapphosting.googleapis.com',`/v1/projects/${project}/locations/${region}/backends/checkin-portal-nf?updateMask=serviceAccount`,'PATCH',{serviceAccount:portalSA});
 if(!await exists('storage.googleapis.com',`/storage/v1/b/${bucket}`))await request('storage.googleapis.com',`/storage/v1/b?project=${project}`,'POST',{name:bucket,location:'US-CENTRAL1',storageClass:'STANDARD',iamConfiguration:{uniformBucketLevelAccess:{enabled:true},publicAccessPrevention:'enforced'},softDeletePolicy:{retentionDurationSeconds:'0'},cors:[{origin:[`https://checkin-portal-nf--${project}.${region}.hosted.app`],method:['PUT'],responseHeader:['Content-Type','Content-Range','Range'],maxAgeSeconds:3600}],labels:{environment:'homologation',feature:'checkin-nf'}});
 // Storage IAM uses a different REST shape.
 const storagePolicy=await request('storage.googleapis.com',`/storage/v1/b/${bucket}/iam`);storagePolicy.bindings??=[];
 for(const sa of [appSA,workerSA]){const role='roles/storage.objectAdmin';let b=storagePolicy.bindings.find(b=>b.role===role);if(!b){b={role,members:[]};storagePolicy.bindings.push(b);}if(!b.members.includes(`serviceAccount:${sa}`))b.members.push(`serviceAccount:${sa}`);}
 await request('storage.googleapis.com',`/storage/v1/b/${bucket}/iam`,'PUT',storagePolicy);
 await allow('cloudresourcemanager.googleapis.com',`/v1/projects/${project}`, [['roles/datastore.user',[`serviceAccount:${appSA}`,`serviceAccount:${workerSA}`]]]);
 await allow('iam.googleapis.com',`/v1/projects/${project}/serviceAccounts/${appSA}`, [['roles/iam.serviceAccountTokenCreator',[`serviceAccount:${appSA}`]]]);
 const local='/tmp/checkin-nf-homologation-secrets.json';
 const secrets=fs.existsSync(local)?JSON.parse(fs.readFileSync(local,'utf8')):{CHECKIN_NF_HMAC:randomBytes(48).toString('hex'),CHECKIN_NF_INDEX:randomBytes(48).toString('hex'),CHECKIN_NF_RATE:randomBytes(48).toString('hex')};fs.writeFileSync(local,JSON.stringify(secrets),{mode:0o600});
 for(const [name,value]of Object.entries(secrets)){
  const base=`/v1/projects/${project}/secrets/${name}`;
  if(!await exists('secretmanager.googleapis.com',base)){
   await request('secretmanager.googleapis.com',`/v1/projects/${project}/secrets?secretId=${name}`,'POST',{replication:{automatic:{}},labels:{environment:'homologation'}});
   await request('secretmanager.googleapis.com',base+':addVersion','POST',{payload:{data:Buffer.from(value).toString('base64')}});
  }
  await allow('secretmanager.googleapis.com',base,[['roles/secretmanager.secretAccessor',[`serviceAccount:${appSA}`,`serviceAccount:${portalSA}`,`serviceAccount:service-${number}@gcp-sa-firebaseapphosting.iam.gserviceaccount.com`]]]);
  console.log(`Secret configured: ${name}`);
 }
 const web=await request('firebase.googleapis.com',`/v1beta1/projects/${project}/webApps/1:431638748152:web:423a977312ddfb7736940d/config`);
 fs.writeFileSync('/tmp/checkin-nf-web-config.json',JSON.stringify(web),{mode:0o600});
 console.log('Staging storage, identities and secrets prepared.');
})().catch(e=>{console.error(e.message);process.exitCode=1;});
