/* eslint-disable @typescript-eslint/no-require-imports -- Firebase CLI administrative SDK is CommonJS. */
const {request,project}=require('./cloud.cjs');const fs=require('node:fs');const {createHash}=require('node:crypto');
(async()=>{
 const qa=JSON.parse(fs.readFileSync('/tmp/checkin-nf-qa-credentials.json'));const web=JSON.parse(fs.readFileSync('/tmp/checkin-nf-web-config.json'));const smoke=JSON.parse(fs.readFileSync('/tmp/checkin-nf-smoke.json'));
 const sign=await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${web.apiKey}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:qa.email,password:qa.password,returnSecureToken:true})});const signed=await sign.json();if(!sign.ok)throw new Error(`Staging login failed: ${signed.error?.message}`);
 const url=`https://checkin-system-nf--${project}.us-central1.hosted.app/api/checkins/${smoke.visitId}/document`;
 const publicRequest=await fetch(url);if(![401,403].includes(publicRequest.status))throw new Error(`Anonymous document access: ${publicRequest.status}`);
 const originalPublic=await fetch(`https://storage.googleapis.com/${project}-checkin-nf/${smoke.object}`);if(![401,403].includes(originalPublic.status))throw new Error('Bucket is not private');
 const response=await fetch(url,{headers:{Authorization:`Bearer ${signed.idToken}`}});const body=await response.json();if(!response.ok)throw new Error(`Document API ${response.status}: ${body.error?.message}`);
 const original=await fetch(body.data.url);if(!original.ok)throw new Error('Original download failed: '+original.status);const bytes=Buffer.from(await original.arrayBuffer());if(createHash('sha256').update(bytes).digest('hex')!==smoke.sha256)throw new Error('Original bytes changed');
 const roleUrl=`/v1/projects/${project}/databases/(default)/documents/users/${qa.uid}?updateMask.fieldPaths=role`;
 let customerDenied=false;
 try {await request('firestore.googleapis.com',roleUrl,'PATCH',{fields:{role:{stringValue:'CUSTOMER'}}});const customer=await fetch(url,{headers:{Authorization:`Bearer ${signed.idToken}`}});customerDenied=customer.status===403;if(!customerDenied)throw new Error('Customer could access document');}
 finally {await request('firestore.googleapis.com',roleUrl,'PATCH',{fields:{role:{stringValue:'ANALYST'}}});}
 const result={project,anonymousDenied:true,bucketPrivate:true,analystDownloadMatchesOriginal:true,customerDenied,downloadBytes:bytes.length,testedAt:new Date().toISOString()};fs.writeFileSync('/tmp/checkin-nf-download-evidence.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 await request('cloudscheduler.googleapis.com',`/v1/projects/${project}/locations/us-central1/jobs/checkin-documents-maintenance:run`,'POST',{});console.log('Preview worker requested via its private scheduled job.');
})().catch(e=>{console.error(e.message);process.exitCode=1;});
