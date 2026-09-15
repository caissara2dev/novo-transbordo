/* eslint-disable @typescript-eslint/no-require-imports -- Firebase CLI administrative SDK is CommonJS. */
// Administrative helper scoped to the explicitly authorized staging project.
const {getGlobalDefaultAccount,setActiveAccount}=require('firebase-tools/lib/auth');
const {requireAuth}=require('firebase-tools/lib/requireAuth');
const {Client}=require('firebase-tools/lib/apiv2');
const project='line-transbordo-staging-382612';
async function client(origin) {const options={project,nonInteractive:true};setActiveAccount(options,getGlobalDefaultAccount());await requireAuth(options);return new Client({urlPrefix:origin,apiVersion:''});}
async function request(host,path,method='GET',body) {
 if(!host.endsWith('.googleapis.com') || !(path.includes(project)||path.includes('431638748152')||path.startsWith('/v1/operations/')))throw new Error('Scope guard');
 const api=await client('https://'+host);try { const result=await api.request({method,path,body,skipLog:{body:true,resBody:true}});return result.body; } catch(e) { e.message=host+' '+method+' '+path+': '+e.message;throw e; }
}
module.exports={request,project};
if(require.main===module) (async()=>{
 const op=process.argv[2];
 if(op==='inventory') {
  for(const [host,path] of [
   ['firebaseapphosting.googleapis.com',`/v1/projects/${project}/locations/us-central1/backends`],
   ['firebase.googleapis.com',`/v1beta1/projects/${project}/webApps`],
   ['firestore.googleapis.com',`/v1/projects/${project}/databases`],
   ['storage.googleapis.com',`/storage/v1/b?project=${project}`],
  ]) {try{console.log(JSON.stringify({service:host,result:await request(host,path)}));}catch(e){console.log(JSON.stringify({service:host,error:e.message}));}}
 }
})().catch(e=>{console.error(e.message);process.exitCode=1;});
