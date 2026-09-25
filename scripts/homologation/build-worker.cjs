/* eslint-disable @typescript-eslint/no-require-imports -- Firebase CLI administrative SDK is CommonJS. */
const {request,project}=require('./cloud.cjs');
const fs=require('node:fs');const {execFileSync}=require('node:child_process');
const {getGlobalDefaultAccount,setActiveAccount}=require('firebase-tools/lib/auth');const {requireAuth}=require('firebase-tools/lib/requireAuth');const {Client}=require('firebase-tools/lib/apiv2');
(async()=>{
 const bucket=`${project}-checkin-nf`,region='us-central1',repository='checkin-nf',tag='v1-'+Date.now();
 try {await request('artifactregistry.googleapis.com',`/v1/projects/${project}/locations/${region}/repositories/${repository}`);}catch(e){if(!e.message.includes('404'))throw e;await request('artifactregistry.googleapis.com',`/v1/projects/${project}/locations/${region}/repositories?repositoryId=${repository}`,'POST',{format:'DOCKER',description:'Invoice preview homologation'});}
 const tar='/tmp/checkin-nf-worker.tar.gz';execFileSync('tar',['-czf',tar,'-C','infrastructure/checkin-documents','Dockerfile','main.py','preview.py','runtime_config.py','requirements.txt']);
 const options={project,nonInteractive:true};setActiveAccount(options,getGlobalDefaultAccount());await requireAuth(options);
 const api=new Client({urlPrefix:'https://storage.googleapis.com',apiVersion:''});const object=`build-sources/${tag}.tar.gz`;
 await api.request({method:'POST',path:`/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(object)}`,headers:{'Content-Type':'application/gzip'},body:fs.readFileSync(tar)});
 const image=`${region}-docker.pkg.dev/${project}/${repository}/preview:${tag}`;
 const build=await request('cloudbuild.googleapis.com',`/v1/projects/${project}/locations/${region}/builds`,'POST',{source:{storageSource:{bucket,object}},steps:[{name:'gcr.io/cloud-builders/docker',args:['build','-t',image,'.']}],images:[image],options:{logging:'CLOUD_LOGGING_ONLY'},timeout:'900s'});
 fs.writeFileSync('/tmp/checkin-nf-worker-build.json',JSON.stringify({image,build}));console.log(JSON.stringify({operation:build.name,image}));
})().catch(e=>{console.error(e.message);process.exitCode=1;});
