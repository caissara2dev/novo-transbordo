/* eslint-disable @typescript-eslint/no-require-imports -- Firebase CLI administrative SDK is CommonJS. */
const {request,project}=require('./cloud.cjs');
(async()=>{
 const member=`serviceAccount:checkin-portal-nf@${project}.iam.gserviceaccount.com`;
 const p=await request('cloudresourcemanager.googleapis.com',`/v1/projects/${project}:getIamPolicy`,'POST',{});let role=p.bindings.find(b=>b.role==='roles/firebaseapphosting.computeRunner');if(!role){role={role:'roles/firebaseapphosting.computeRunner',members:[]};p.bindings.push(role);}if(!role.members.includes(member))role.members.push(member);await request('cloudresourcemanager.googleapis.com',`/v1/projects/${project}:setIamPolicy`,'POST',{policy:p});
 const all=await request('storage.googleapis.com',`/storage/v1/b?project=${project}`);
 for(const b of all.items??[]){if(!b.name.startsWith('firebaseapphosting-sources-431638748152-'))continue;const policy=await request('storage.googleapis.com',`/storage/v1/b/${b.name}/iam`);let role=policy.bindings.find(b=>b.role==='roles/storage.objectViewer');if(!role){role={role:'roles/storage.objectViewer',members:[]};policy.bindings.push(role);}if(!role.members.includes(member))role.members.push(member);await request('storage.googleapis.com',`/storage/v1/b/${b.name}/iam`,'PUT',policy);}
 console.log('Portal build can read only staging App Hosting source buckets; invoice bucket access was not granted.');
})().catch(e=>{console.error(e.message);process.exitCode=1;});
