"""Create a deploy-only snapshot with an explicit allowlist; never copy local env files."""
from pathlib import Path
import json, shutil
system=Path(__file__).resolve().parents[2]
portal=system.parent/'checkin-portal-v2'
project='line-transbordo-staging-382612'
release=system.parent/'checkin-nf-release'
web=json.loads(Path('/tmp/checkin-nf-web-config.json').read_text())
turnstile=json.loads(Path('/tmp/checkin-nf-turnstile.json').read_text())
def config(values,secrets):
 env=[{'variable':k,'value':str(v),'availability':['BUILD','RUNTIME'] if k.startswith('NEXT_PUBLIC_') else ['RUNTIME']} for k,v in values.items()]
 env += [{'variable':k,'secret':v,'availability':['RUNTIME']} for k,v in secrets.items()]
 return json.dumps({'runConfig':{'minInstances':0,'maxInstances':2,'concurrency':40,'cpu':1,'memoryMiB':1024},'env':env},indent=2)+'\n'
for label,source in [('system',system),('portal',portal)]:
 target=release/label;target.mkdir(parents=True,exist_ok=True)
 for name in ['src','public']:
  if (source/name).exists():shutil.copytree(source/name,target/name,dirs_exist_ok=True)
 for pattern in ['package.json','package-lock.json','tsconfig.json','next-env.d.ts','next.config.*','postcss.config.*','tailwind.config.*','eslint.config.*']:
  for file in source.glob(pattern):shutil.copy2(file,target/file.name)
 if label=='system':
  values={'FIREBASE_PROJECT_ID':project,'NEXT_PUBLIC_FIREBASE_PROJECT_ID':project,'NEXT_PUBLIC_FIREBASE_API_KEY':web['apiKey'],'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN':web['authDomain'],'NEXT_PUBLIC_FIREBASE_APP_ID':web['appId'],'NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID':web['messagingSenderId'],'NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET':project+'-checkin-nf','NEXT_PUBLIC_APP_ENV':'staging','CHECKIN_SYSTEM_RECORD_ENABLED':'true','CHECKIN_DOCUMENTS_ENABLED':'true','CHECKIN_INTEGRATION_MODE':'enforce','CHECKIN_ENFORCE_ROLLOUT_APPROVED':'true','CHECKIN_INTEGRATION_KEY_ID':'checkin-nf-homologation-v1','CHECKIN_GEOFENCE_CENTER_LAT':'-23.9608','CHECKIN_GEOFENCE_CENTER_LNG':'-46.3336','CHECKIN_GEOFENCE_RADIUS_METERS':'20000','CHECKIN_DOCUMENT_BUCKET':project+'-checkin-nf','CHECKIN_PORTAL_ORIGIN':f'https://checkin-portal-nf--{project}.us-central1.hosted.app','APP_CHECK_MODE':'observe','RATE_LIMIT_MODE':'enforce','RATE_LIMIT_KEY_VERSION':'nf-v1','TRUSTED_PROXY_MODE':'google-lb','CONTAINER_TRANSFERS_ENABLED':'true'}
  secrets={'CHECKIN_INTEGRATION_HMAC_SECRET':'CHECKIN_NF_HMAC','CHECKIN_INDEX_HMAC_SECRET':'CHECKIN_NF_INDEX','RATE_LIMIT_HMAC_SECRET':'CHECKIN_NF_RATE'}
 else:
  values={'NEXT_PUBLIC_TURNSTILE_SITE_KEY':turnstile['siteKey'],'PUBLIC_APP_HOSTNAME':f'checkin-portal-nf--{project}.us-central1.hosted.app','TRANSBORDOLINE_API_BASE_URL':f'https://checkin-system-nf--{project}.us-central1.hosted.app','TRANSBORDOLINE_CHECKIN_KEY_ID':'checkin-nf-homologation-v1','TRUSTED_PROXY_MODE':'google-lb','NEXT_PUBLIC_CHECKIN_DOCUMENTS_ENABLED':'true','NEXT_PUBLIC_CHECKIN_ENVIRONMENT':'homologation'}
  secrets={'TURNSTILE_SECRET_KEY':'CHECKIN_NF_TURNSTILE','TRANSBORDOLINE_CHECKIN_HMAC_SECRET':'CHECKIN_NF_HMAC'}
 (target/'apphosting.yaml').write_text(config(values,secrets))
 for file in target.glob('.env*'):raise RuntimeError('Unexpected env file in release: '+str(file))
release_config={'apphosting':[{'backendId':'checkin-system-nf','rootDir':'system','ignore':['node_modules','.git','.next','.env*'],'alwaysDeployFromSource':True},{'backendId':'checkin-portal-nf','rootDir':'portal','ignore':['node_modules','.git','.next','.env*'],'alwaysDeployFromSource':True}],'firestore':{'rules':'firestore.rules','indexes':'firestore.indexes.json'}}
(release/'firebase.json').write_text(json.dumps(release_config,indent=2)+'\n')
for name in ['firestore.rules','firestore.indexes.json']:shutil.copy2(system/name,release/name)
(release/'.firebaserc').write_text(json.dumps({'projects':{'default':project}}))
print('Release snapshot:',release)
