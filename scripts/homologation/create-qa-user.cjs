/* eslint-disable @typescript-eslint/no-require-imports -- Firebase CLI administrative SDK is CommonJS. */
const fs=require('node:fs');const {randomBytes}=require('node:crypto');const {initializeApp}=require('firebase-admin/app');const {getAuth}=require('firebase-admin/auth');const {getGlobalDefaultAccount,getAccessToken}=require('firebase-tools/lib/auth');
const {request,project}=require('./cloud.cjs');
(async()=>{
 const account=getGlobalDefaultAccount();const app=initializeApp({projectId:project,credential:{getAccessToken:async()=>{const t=await getAccessToken(account.tokens.refresh_token,['https://www.googleapis.com/auth/cloud-platform']);return {access_token:t.access_token,expires_in:3600};}}},'checkin-nf-qa');
 const path='/tmp/checkin-nf-qa-credentials.json';let user;
 if(fs.existsSync(path)){user=JSON.parse(fs.readFileSync(path));await getAuth(app).getUser(user.uid);}else{
  user={uid:'checkin-nf-qa-20260914',email:'checkin-nf-qa-20260914@example.invalid',password:randomBytes(24).toString('base64url')};
  await getAuth(app).createUser({...user,displayName:'Analista - Homologacao NF',emailVerified:true});fs.writeFileSync(path,JSON.stringify(user),{mode:0o600});
 }
 const now=new Date().toISOString();
 await request('firestore.googleapis.com',`/v1/projects/${project}/databases/(default)/documents/users/${user.uid}`,'PATCH',{fields:{email:{stringValue:user.email},name:{stringValue:'Analista - Homologacao NF'},role:{stringValue:'ANALYST'},active:{booleanValue:true},approved:{booleanValue:true},createdAt:{timestampValue:now},updatedAt:{timestampValue:now},approvedAt:{timestampValue:now},approvedByUid:{nullValue:null},approvedByEmail:{nullValue:null},environment:{stringValue:'homologation'}}});
 console.log('Dedicated analyst test account ready. Credentials saved locally, not printed.');
})().catch(e=>{console.error(e.message);process.exitCode=1;});
