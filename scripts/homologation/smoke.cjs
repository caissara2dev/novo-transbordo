/* eslint-disable @typescript-eslint/no-require-imports -- Firebase CLI administrative SDK is CommonJS. */
const {request,project}=require('./cloud.cjs');const fs=require('node:fs');const {createHash,createHmac,randomUUID}=require('node:crypto');
const base=`https://checkin-system-nf--${project}.us-central1.hosted.app`;
const secrets=JSON.parse(fs.readFileSync('/tmp/checkin-nf-homologation-secrets.json'));
async function api(action,body){const path='/api/integrations/checkins/v1/'+action,raw=JSON.stringify(body),timestamp=new Date().toISOString(),requestId=randomUUID();const sig=createHmac('sha256',secrets.CHECKIN_NF_HMAC).update(['POST',path,timestamp,requestId,createHash('sha256').update(raw).digest('hex')].join('\n')).digest('hex');const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','x-checkin-key-id':'checkin-nf-homologation-v1','x-checkin-request-id':requestId,'x-checkin-timestamp':timestamp,'x-checkin-signature':sig},body:raw});const envelope=await r.json().catch(()=>null);if(!r.ok||!envelope?.ok)throw new Error(`${action}: ${r.status} ${envelope?.error?.message??'Invalid response'}`);return envelope.data;}
function cnh(){const d=Array.from({length:9},()=>Math.floor(Math.random()*10));for(const reverse of [true,false]){const n=d.slice(0,9).reduce((s,v,i)=>s+v*(reverse?9-i:i+1),0)%11;d.push(n===10?0:n);}return d.join('');}
const form={driverName:'TESTE HOMOLOGACAO - NAO OPERAR',driverLicense:cnh(),driverPhone:'13999990001',plate:'TST1A01',carrierName:'TRANSPORTADORA FICTICIA',vehicleType:'Bitrem',product:'Produto teste',originPlant:'USINA FICTICIA',originInvoiceNumbers:'000123',remittanceInvoiceNumber:'000456',whatsappNoticeAccepted:true,queueLocationAccepted:true};
function unpack(v){if(v.stringValue!==undefined)return v.stringValue;if(v.integerValue!==undefined)return Number(v.integerValue);if(v.doubleValue!==undefined)return v.doubleValue;if(v.booleanValue!==undefined)return v.booleanValue;if(v.nullValue!==undefined)return null;if(v.mapValue)return Object.fromEntries(Object.entries(v.mapValue.fields??{}).map(([k,x])=>[k,unpack(x)]));if(v.arrayValue)return (v.arrayValue.values??[]).map(unpack);return v;}
async function readDocument(collection,id){const r=await request('firestore.googleapis.com',`/v1/projects/${project}/databases/(default)/documents/${collection}/${id}`);return Object.fromEntries(Object.entries(r.fields??{}).map(([k,v])=>[k,unpack(v)]));}
if(require.main===module)(async()=>{
 const identity={driverLicense:form.driverLicense,driverPhone:form.driverPhone,plate:form.plate};
 const session=await api('documents',{action:'open',operation:'walk-in',operationId:randomUUID(),identity});
 const bytes=fs.readFileSync('tests/fixtures/invoices/nota-ficticia.jpg'),attemptId=randomUUID();
 const upload=await api('documents',{action:'begin',sessionId:session.sessionId,attemptId,name:'nota-ficticia.jpg',size:bytes.length});
 const sent=await fetch(upload.uploadUrl,{method:'PUT',headers:{'Content-Range':`bytes 0-${bytes.length-1}/${bytes.length}`},body:bytes});if(!sent.ok)throw new Error('Storage upload: '+sent.status);
 const document=await api('documents',{action:'finalize',sessionId:session.sessionId,attemptId});if(!document.received)throw new Error('Document not received');
 const body={form,location:{latitude:-23.9608,longitude:-46.3336,accuracyMeters:10,capturedAtIso:new Date().toISOString()},document:{sessionId:session.sessionId,skip:false}};
 const confirmed=await api('walk-ins',body);const repeated=await api('walk-ins',body);if(confirmed.publicCode!==repeated.publicCode)throw new Error('Duplicate visit');
 const storedSession=await readDocument('_checkinDocumentSessions',session.sessionId);const visit=await readDocument('checkins',storedSession.visitId);
 if(visit.document.current.sha256!==createHash('sha256').update(bytes).digest('hex')||visit.document.status!=='received'||visit.status!=='AGUARDANDO_LIBERACAO')throw new Error('Persistence mismatch');
 const result={project,visitId:storedSession.visitId,publicCode:confirmed.publicCode,status:visit.status,documentStatus:visit.document.status,originalBytes:bytes.length,sha256:visit.document.current.sha256,duplicateConfirmationSameVisit:true,sessionId:session.sessionId,documentId:attemptId,object:visit.document.current.object,testedAt:new Date().toISOString()};
 fs.writeFileSync('/tmp/checkin-nf-smoke.json',JSON.stringify(result,null,2));console.log(JSON.stringify({...result,sessionId:'[omitted]',object:'[private object]'}));
})().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={api,readDocument};
