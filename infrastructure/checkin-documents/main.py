"""Private Cloud Run worker. Cloud Scheduler calls POST /run with an OIDC token.
Cloud Run IAM, not a public shared token, authenticates callers.
"""
import json
import os
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
import requests
from google.cloud import firestore, storage
from google.cloud.firestore_v1.base_query import FieldFilter
from preview import make_preview

PROJECT = os.environ['GOOGLE_CLOUD_PROJECT']
if PROJECT != 'line-transbordo-staging-382612':
    raise RuntimeError('This worker is restricted to homologation')
BUCKET = os.environ['CHECKIN_DOCUMENT_BUCKET']
db = firestore.Client(project=PROJECT)
bucket = storage.Client(project=PROJECT).bucket(BUCKET)

def now():
    return int(time.time() * 1000)

@firestore.transactional
def claim_job(tx, ref):
    snapshot = ref.get(transaction=tx)
    job = snapshot.to_dict()
    if not job or job['state'] not in ('pending', 'processing'):
        return None
    if job.get('leaseUntil', 0) > now():
        return None
    tx.update(ref, {'state': 'processing', 'leaseUntil': now() + 300_000, 'attempts': job['attempts'] + 1})
    return job

@firestore.transactional
def finish_job(tx, ref, job, preview_object, error):
    visit_ref = db.collection('checkins').document(job['visitId'])
    visit = visit_ref.get(transaction=tx).to_dict()
    current = ((visit or {}).get('document') or {}).get('current')
    if current and current['id'] == job['documentId'] and current['generation'] == job['generation']:
        patch = {'document.current.previewStatus': 'failed' if error else 'ready'}
        if preview_object:
            patch['document.current.previewObject'] = preview_object
        tx.update(visit_ref, patch)
    tx.update(ref, {'state': 'failed' if error else 'complete', 'completedAt': now(), 'error': error})

def process_previews():
    count = 0
    jobs = db.collection('_checkinPreviewJobs').where(filter=FieldFilter('state', 'in', ['pending', 'processing'])).limit(5).stream()
    for snap in jobs:
        job = claim_job(db.transaction(), snap.reference)
        if not job:
            continue
        output = None
        error = None
        try:
            blob = bucket.blob(job['object'], generation=int(job['generation']))
            blob.reload()
            if not blob.size or blob.size > 10_000_000:
                raise ValueError('Invalid size')
            data = blob.download_as_bytes(if_generation_match=int(job['generation']))
            preview = make_preview(data)
            output = f"checkin-previews/{job['visitId']}/{job['documentId']}.jpg"
            target = bucket.blob(output)
            target.cache_control = 'private, no-store'
            target.upload_from_string(preview, content_type='image/jpeg')
        except Exception:
            # No filenames, GPS, document content, URLs or identity in logs.
            error = 'PREVIEW_UNAVAILABLE'
        finish_job(db.transaction(), snap.reference, job, output, error)
        count += 1
    return count

@firestore.transactional
def claim_cleanup(tx, ref):
    value = ref.get(transaction=tx).to_dict()
    if not value or value['state'] not in ('open', 'deleting') or value.get('visitId') or value['createdAt'] > now() - 86_400_000:
        return None
    if value['state'] == 'deleting' and value.get('cleanupLeaseUntil', 0) > now():
        return None
    tx.update(ref, {'state': 'deleting', 'cleanupLeaseUntil': now() + 300_000})
    return value

def clean_temporary():
    count = 0
    # An index avoids starvation by old linked sessions. Linking and claiming
    # deletion contend on the same session document; only one can commit.
    sessions = db.collection('_checkinDocumentSessions').where(filter=FieldFilter('state', 'in', ['open', 'deleting'])).where(filter=FieldFilter('createdAt', '<=', now() - 86_400_000)).limit(20).stream()
    for snap in sessions:
        session = claim_cleanup(db.transaction(), snap.reference)
        if not session:
            continue
        try:
            for attempt in session['attempts'].values():
                if attempt.get('uploadUrl'):
                    response = requests.delete(attempt['uploadUrl'], timeout=15)
                    if response.status_code not in (200, 204, 404, 410, 499):
                        raise RuntimeError('Revocation unavailable')
            for blob in bucket.list_blobs(prefix=f'checkin-uploads/{snap.id}/'):
                blob.delete(if_generation_match=blob.generation)
            snap.reference.update({'state': 'deleted', 'attempts': {}, 'current': None, 'deletedAt': now()})
            count += 1
        except Exception:
            # Retry after the lease; never mark partial cleanup successful.
            continue
    return count

@firestore.transactional
def claim_orphan(tx, ref):
    value=ref.get(transaction=tx).to_dict()
    if not value or value['state'] not in ('unlinked','deleting') or value.get('visitId') or value['createdAt']>now()-86_400_000:
        return None
    if value.get('leaseUntil',0)>now():
        return None
    session=db.collection('_checkinDocumentSessions').document(value['sessionId']).get(transaction=tx).to_dict()
    if session and session['state']=='linked' and (session.get('current') or {}).get('id')==ref.id:
        return None
    tx.update(ref,{'state':'deleting','leaseUntil':now()+300_000})
    return value

def clean_orphan_objects():
    count=0
    rows=db.collection('_checkinTemporaryObjects').where(filter=FieldFilter('state','in',['unlinked','deleting'])).where(filter=FieldFilter('createdAt','<=',now()-86_400_000)).limit(30).stream()
    for snap in rows:
        value=claim_orphan(db.transaction(),snap.reference)
        if not value:continue
        try:
            if value.get('uploadUrl'):
                response=requests.delete(value['uploadUrl'],timeout=15)
                if response.status_code not in (200,204,404,410,499):raise RuntimeError('Revocation unavailable')
            blob=bucket.blob(value['object'])
            if blob.exists():
                blob.reload();blob.delete(if_generation_match=blob.generation)
            snap.reference.update({'state':'deleted','deletedAt':now(),'uploadUrl':firestore.DELETE_FIELD})
            count+=1
        except Exception:continue
    return count

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != '/run':
            self.send_error(404)
            return
        try:
            payload = {'previews': process_previews(), 'temporarySessionsDeleted': clean_temporary(), 'orphanObjectsDeleted':clean_orphan_objects()}
            self.send_response(200)
        except Exception:
            payload = {'error': 'WORKER_RETRY_REQUIRED'}
            self.send_response(503)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(payload).encode())

    def log_message(self, *_):
        pass

if __name__ == '__main__':
    HTTPServer(('0.0.0.0', int(os.getenv('PORT', '8080'))), Handler).serve_forever()
