/* eslint-disable @typescript-eslint/no-require-imports -- Firebase CLI administrative SDK is CommonJS. */
const {api,readDocument}=require('./smoke.cjs');const {request,project}=require('./cloud.cjs');const fs=require('node:fs');const {randomUUID}=require('node:crypto');
function form(plate,license){return {driverName:'TESTE FICTICIO - NAO OPERAR',driverLicense:license,driverPhone:'13999990002',plate,carrierName:'TRANSPORTADORA FICTICIA',vehicleType:'Bitrem',product:'Teste NF',originPlant:'USINA FICTICIA',originInvoiceNumbers:'123',remittanceInvoiceNumber:'456',whatsappNoticeAccepted:true,queueLocationAccepted:true};}
const identity=f=>({driverLicense:f.driverLicense,driverPhone:f.driverPhone,plate:f.plate});const location=()=>({latitude:-23.9608,longitude:-46.3336,accuracyMeters:10,capturedAtIso:new Date().toISOString()});
async function upload(sessionId,name,bytes){const attemptId=randomUUID();const started=await api('documents',{action:'begin',sessionId,attemptId,name,size:bytes.length});const sent=await fetch(started.uploadUrl,{method:'PUT',headers:{'Content-Range':`bytes 0-${bytes.length-1}/${bytes.length}`},body:bytes});if(!sent.ok)throw new Error('Upload failed');const done=await api('documents',{action:'finalize',sessionId,attemptId});if(!done.received)throw new Error('Not received');return attemptId;}
(async()=>{
 const f=form('TST2A02','98765432109'); // generated valid test CNH is calculated below
 const digits=[9,8,7,6,5,4,3,2,1];f.driverLicense=digits.join('')+[true,false].map(reverse=>{const n=digits.reduce((s,d,i)=>s+d*(reverse?9-i:i+1),0)%11;return n===10?0:n;}).join('');
 const registration=await api('pre-registrations',{source:'CARRIER',form:f});
 const s=await api('documents',{action:'open',operationId:randomUUID(),operation:'confirm',identity:identity(f),publicCode:registration.publicCode});
 const abandoned=await upload(s.sessionId,'primeira-selecao.jpg',fs.readFileSync('tests/fixtures/invoices/nota-ficticia.jpg'));
 const current=await upload(s.sessionId,'nota-ficticia.pdf',fs.readFileSync('tests/fixtures/invoices/nota-ficticia.pdf'));
 const confirmed=await api('confirmations',{...identity(f),publicCode:registration.publicCode,location:location(),document:{sessionId:s.sessionId,skip:false}});
 const linked=await readDocument('_checkinDocumentSessions',s.sessionId);const visit=await readDocument('checkins',linked.visitId);if(visit.document.current.contentType!=='application/pdf')throw new Error('Expected PDF');
 // Backdate ONLY these two synthetic test objects to exercise the 24-hour cleanup now.
 for(const id of [abandoned,current])await request('firestore.googleapis.com',`/v1/projects/${project}/databases/(default)/documents/_checkinTemporaryObjects/${id}?updateMask.fieldPaths=createdAt`,'PATCH',{fields:{createdAt:{integerValue:String(Date.now()-25*3600000)}}});
 const missing=form('TST3A03','12345678070');const d=[1,2,3,4,5,6,7,8,0];missing.driverLicense=d.join('')+[true,false].map(reverse=>{const n=d.reduce((s,v,i)=>s+v*(reverse?9-i:i+1),0)%11;return n===10?0:n;}).join('');
 const session=await api('documents',{action:'open',operationId:randomUUID(),operation:'walk-in',identity:identity(missing)});
 for(let n=1;n<=2;n++){
  const attemptId=randomUUID();const started=await api('documents',{action:'begin',sessionId:session.sessionId,attemptId,name:'interrompido.pdf',size:524288});
  const partial=await fetch(started.uploadUrl,{method:'PUT',headers:{'Content-Range':'bytes 0-262143/524288'},body:Buffer.alloc(262144,1)});if(partial.status!==308)throw new Error('Partial upload did not pause');
  const failed=await api('documents',{action:'failed',sessionId:session.sessionId,attemptId});if(failed.failures!==n||failed.canSkip!==(n===2))throw new Error('Failure count mismatch');
  const replay=await api('documents',{action:'failed',sessionId:session.sessionId,attemptId});if(replay.failures!==n)throw new Error('Duplicate failure counted');
 }
 const pending=await api('walk-ins',{form:missing,location:location(),document:{sessionId:session.sessionId,skip:true}});const pendingSession=await readDocument('_checkinDocumentSessions',session.sessionId);const pendingVisit=await readDocument('checkins',pendingSession.visitId);if(pendingVisit.document.status!=='pending')throw new Error('Pending state missing');
 const result={project,pdfVisit:confirmed.publicCode,pdfVisitId:linked.visitId,pendingVisit:pending.publicCode,pendingVisitId:pendingSession.visitId,twoFailuresUnlockException:true,duplicateFailureNotCounted:true,abandonedObjectId:abandoned,currentObjectId:current,testedAt:new Date().toISOString()};fs.writeFileSync('/tmp/checkin-nf-extra-evidence.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 await request('cloudscheduler.googleapis.com',`/v1/projects/${project}/locations/us-central1/jobs/checkin-documents-maintenance:run`,'POST',{});
})().catch(e=>{console.error(e.message);process.exitCode=1;});
