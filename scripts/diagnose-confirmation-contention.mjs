import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
if (process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8188') throw Error('Local emulator required');
const env={...process.env,FIREBASE_PROJECT_ID:'demo-checkin-nf',GCLOUD_PROJECT:'demo-checkin-nf',GOOGLE_CLOUD_PROJECT:'demo-checkin-nf',NODE_OPTIONS:'--require '+resolve('scripts/diagnose-firestore-retries.cjs')};
for(const key of ['GOOGLE_APPLICATION_CREDENTIALS','FIREBASE_CLIENT_EMAIL','FIREBASE_PRIVATE_KEY']) delete env[key];
for(let i=1;i<=10;i++) {
 console.log('DIAGNOSTIC_ITERATION',i);
 const r=spawnSync(process.execPath,[resolve('node_modules/vitest/vitest.mjs'),'run','tests/integration/checkin-documents-emulator.test.ts','-t','serializes duplicate confirmation and produces one visit and one original','--testTimeout','20000','--reporter','verbose'],{stdio:'inherit',env});
 if(r.status!==0)process.exit(r.status??1);
}
