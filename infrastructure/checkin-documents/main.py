"""Private Cloud Run worker. Cloud Scheduler calls POST /run with an OIDC token.
Cloud Run IAM, not a public shared token, authenticates callers.
"""
import json
import math
import os
import re
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from uuid import uuid4
import requests
from google.api_core.exceptions import NotFound, PreconditionFailed
from google.cloud import firestore, storage
from google.cloud.firestore_v1.base_query import FieldFilter
from preview import make_preview

PROJECT = os.environ['GOOGLE_CLOUD_PROJECT']
if PROJECT != 'line-transbordo-staging-382612':
    raise RuntimeError('This worker is restricted to homologation')
BUCKET = os.environ['CHECKIN_DOCUMENT_BUCKET']
if BUCKET != f'{PROJECT}-checkin-nf':
    raise RuntimeError('Unexpected document bucket')
db = firestore.Client(project=PROJECT)
bucket = storage.Client(project=PROJECT).bucket(BUCKET)
LEASE_MS = 300_000
REPLACED_RETENTION_MS = 90 * 86_400_000
UUID = re.compile(r'[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}\Z')
ORIGINAL = re.compile(r'checkin-uploads/[a-f0-9]{64}/([a-fA-F0-9-]{36})/original\Z')


def now():
    return int(time.time() * 1000)


def iso_time(value):
    return datetime.fromtimestamp(value / 1000, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def preview_name(visit_id, document_id):
    return f'checkin-previews/{visit_id}/{document_id}.jpg'


def valid_receipt(document, visit_id, document_id):
    """Only immutable originals from the documented upload namespace qualify."""
    if not isinstance(document, dict) or not UUID.fullmatch(str(visit_id)) or not UUID.fullmatch(str(document_id)):
        return False
    match = ORIGINAL.fullmatch(str(document.get('object', '')))
    return bool(document.get('id') == document_id and match and match[1] == document_id
                and re.fullmatch(r'[1-9][0-9]*', str(document.get('generation', '')))
                and document.get('previewObject', preview_name(visit_id, document_id)) == preview_name(visit_id, document_id))


def same_document(document, job):
    return bool(document and document.get('id') == job.get('documentId')
                and document.get('object') == job.get('object')
                and str(document.get('generation')) == str(job.get('generation')))


def valid_retention(archive):
    expires = archive.get('expiresAt')
    if isinstance(expires, bool) or not isinstance(expires, (int, float)) or not math.isfinite(expires):
        return False
    try:
        replaced = datetime.fromisoformat(archive['replacedAtIso'].replace('Z', '+00:00'))
        return replaced.tzinfo is not None and expires >= replaced.timestamp() * 1000 + REPLACED_RETENTION_MS
    except (KeyError, ValueError, TypeError, AttributeError):
        return False


def linked_original(tx, document_id, visit_id, object_name):
    linked = db.collection('_checkinTemporaryObjects').document(document_id).get(transaction=tx).to_dict()
    return bool(linked and linked.get('state') == 'linked' and linked.get('visitId') == visit_id
                and linked.get('object') == object_name)


@firestore.transactional
def claim_job(tx, ref):
    job = ref.get(transaction=tx).to_dict()
    timestamp = now()
    if not job or job.get('state') not in ('pending', 'processing') or job.get('leaseUntil', 0) > timestamp:
        return None
    if ref.id != job.get('documentId') or not valid_receipt(
            {'id': job.get('documentId'), 'object': job.get('object'), 'generation': job.get('generation')},
            job.get('visitId'), job.get('documentId')):
        return None
    visit = db.collection('checkins').document(job['visitId']).get(transaction=tx).to_dict()
    current = ((visit or {}).get('document') or {}).get('current')
    archive = db.collection('_checkinDocumentVersions').document(job['documentId']).get(transaction=tx).to_dict()
    archived = bool(archive and archive.get('visitId') == job['visitId'] and archive.get('state') == 'available'
                    and valid_retention(archive) and archive['expiresAt'] > timestamp
                    and same_document(archive.get('document'), job))
    if not visit or not (same_document(current, job) or archived):
        return None
    if not linked_original(tx, job['documentId'], job['visitId'], job['object']):
        return None
    claimed = {**job, 'state': 'processing', 'leaseUntil': timestamp + LEASE_MS,
               'leaseToken': str(uuid4()), 'attempts': job.get('attempts', 0) + 1}
    tx.update(ref, {key: claimed[key] for key in ('state', 'leaseUntil', 'leaseToken', 'attempts')})
    return claimed


@firestore.transactional
def finish_job(tx, ref, job, preview_object, preview_generation, error):
    active = ref.get(transaction=tx).to_dict()
    if not active or active.get('state') != 'processing' or active.get('leaseToken') != job['leaseToken']:
        return False
    visit_ref = db.collection('checkins').document(job['visitId'])
    archive_ref = db.collection('_checkinDocumentVersions').document(job['documentId'])
    visit = visit_ref.get(transaction=tx).to_dict()
    archive = archive_ref.get(transaction=tx).to_dict()
    current = ((visit or {}).get('document') or {}).get('current')
    target = None
    prefix = None
    if same_document(current, job):
        target, prefix = visit_ref, 'document.current'
    elif (archive and archive.get('visitId') == job['visitId'] and archive.get('state') == 'available'
          and valid_retention(archive) and archive['expiresAt'] > now()
          and same_document(archive.get('document'), job)):
        target, prefix = archive_ref, 'document'
    if target:
        patch = {f'{prefix}.previewStatus': 'failed' if error else 'ready'}
        if preview_object and preview_generation and not error:
            patch.update({f'{prefix}.previewObject': preview_object,
                          f'{prefix}.previewGeneration': str(preview_generation)})
        tx.update(target, patch)
    tx.update(ref, {'state': ('failed' if error else 'complete') if target else 'cancelled',
                    'completedAt': now(), 'error': error, 'leaseUntil': 0})
    return bool(target)


@firestore.transactional
def obsolete_preview(tx, job):
    visit = db.collection('checkins').document(job['visitId']).get(transaction=tx).to_dict()
    archive = db.collection('_checkinDocumentVersions').document(job['documentId']).get(transaction=tx).to_dict()
    current = ((visit or {}).get('document') or {}).get('current')
    if same_document(current, job):
        return False
    return not (archive and archive.get('state') == 'available' and archive.get('visitId') == job['visitId']
                and valid_retention(archive) and archive['expiresAt'] > now()
                and same_document(archive.get('document'), job))


def process_previews():
    count = 0
    jobs = db.collection('_checkinPreviewJobs').where(filter=FieldFilter('state', 'in', ['pending', 'processing'])).limit(5).stream()
    for snap in jobs:
        job = claim_job(db.transaction(), snap.reference)
        if not job:
            continue
        output, generation, error, created = None, None, None, False
        try:
            blob = bucket.blob(job['object'], generation=int(job['generation']))
            blob.reload(timeout=30)
            if not blob.size or blob.size > 10_000_000:
                raise ValueError('Invalid size')
            data = blob.download_as_bytes(if_generation_match=int(job['generation']), timeout=30)
            preview = make_preview(data)
            output = preview_name(job['visitId'], job['documentId'])
            target = bucket.blob(output)
            target.cache_control = 'private, no-store'
            # Never overwrite the output of another claim. A retry can recover
            # an upload whose response was lost without generating another blob.
            target.metadata = {'visitId': job['visitId'], 'documentId': job['documentId'],
                               'originalGeneration': str(job['generation'])}
            if now() >= job['leaseUntil']:
                raise RuntimeError('Preview lease expired')
            try:
                target.upload_from_string(preview, content_type='image/jpeg', if_generation_match=0, timeout=30)
                created = True
            except PreconditionFailed:
                target.reload(timeout=30)
            generation = str(target.generation)
        except Exception:
            # No filenames, GPS, document content, URLs or identity in logs.
            error = 'PREVIEW_UNAVAILABLE'
        attached = finish_job(db.transaction(), snap.reference, job, output, generation, error)
        if not attached and created and generation and obsolete_preview(db.transaction(), job):
            # A concurrent expiry cancelled this lease. Delete only this output,
            # never an output later created by another worker.
            try:
                bucket.blob(output, generation=int(generation)).delete(if_generation_match=int(generation), timeout=30)
            except NotFound:
                pass
        count += 1
    return count


@firestore.transactional
def claim_expired_version(tx, ref):
    archive = ref.get(transaction=tx).to_dict()
    timestamp = now()
    if (not archive or archive.get('state') not in ('available', 'deleting')
            or not valid_retention(archive) or archive['expiresAt'] > timestamp
            or archive.get('cleanupLeaseUntil', 0) > timestamp):
        return None
    document = archive.get('document')
    visit_id = archive.get('visitId')
    if not valid_receipt(document, visit_id, ref.id):
        return None
    visit = db.collection('checkins').document(visit_id).get(transaction=tx).to_dict()
    current = ((visit or {}).get('document') or {}).get('current')
    # Fail closed if the archive points at the current original, even with an
    # inconsistent ID or generation. A missing visit is not a deletion permit.
    if not visit or (current and (current.get('id') == ref.id or current.get('object') == document['object'])):
        return None
    if not linked_original(tx, ref.id, visit_id, document['object']):
        return None
    job_ref = db.collection('_checkinPreviewJobs').document(ref.id)
    job = job_ref.get(transaction=tx).to_dict()
    if job and (not same_document(document, job) or job.get('visitId') != visit_id
                or (job.get('state') == 'processing' and job.get('leaseUntil', 0) > timestamp)):
        return None
    claimed = {**archive, 'state': 'deleting', 'cleanupToken': str(uuid4()), 'cleanupLeaseUntil': timestamp + LEASE_MS}
    tx.update(ref, {key: claimed[key] for key in ('state', 'cleanupToken', 'cleanupLeaseUntil')})
    if job and job.get('state') in ('pending', 'processing'):
        tx.update(job_ref, {'state': 'cancelled', 'leaseUntil': 0, 'completedAt': timestamp})
    return claimed


@firestore.transactional
def record_preview_generation(tx, ref, claim, generation):
    archive = ref.get(transaction=tx).to_dict()
    if (not archive or archive.get('state') != 'deleting'
            or archive.get('cleanupToken') != claim['cleanupToken'] or archive.get('cleanupLeaseUntil', 0) <= now()):
        return False
    tx.update(ref, {'cleanupPreviewGeneration': generation})
    return True


@firestore.transactional
def finish_version_cleanup(tx, ref, claim):
    archive = ref.get(transaction=tx).to_dict()
    if not archive or archive.get('state') != 'deleting' or archive.get('cleanupToken') != claim['cleanupToken']:
        return False
    tx.update(ref, {'state': 'deleted', 'deletedAtIso': iso_time(now()), 'cleanupLeaseUntil': 0})
    return True


def delete_generation(object_name, generation):
    try:
        bucket.blob(object_name, generation=int(generation)).delete(if_generation_match=int(generation), timeout=30)
    except NotFound:
        # Idempotent after a partial deletion or a lost storage response.
        pass


def clean_replaced_versions():
    count = 0
    rows = (db.collection('_checkinDocumentVersions')
            .where(filter=FieldFilter('state', 'in', ['available', 'deleting']))
            .where(filter=FieldFilter('expiresAt', '<=', now())).limit(30).stream())
    for snap in rows:
        claim = claim_expired_version(db.transaction(), snap.reference)
        if not claim:
            continue
        try:
            document = claim['document']
            output = preview_name(claim['visitId'], snap.id)
            # Even a crashed preview job may have produced an object before
            # writing its receipt. Discover that exact generation under the
            # shared job/archive lock, then persist it before deleting anything.
            generation = claim.get('cleanupPreviewGeneration') or document.get('previewGeneration')
            if not generation:
                target = bucket.blob(output)
                try:
                    target.reload(timeout=30)
                    generation = str(target.generation)
                except NotFound:
                    generation = None
            if not record_preview_generation(db.transaction(), snap.reference, claim, generation):
                continue
            delete_generation(document['object'], document['generation'])
            if generation:
                delete_generation(output, generation)
            if finish_version_cleanup(db.transaction(), snap.reference, claim):
                count += 1
        except Exception:
            # Keep 'deleting' and the immutable receipt for retry after lease.
            # Never mark a partially removed version as fully deleted.
            continue
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
            payload = {'previews': process_previews(), 'temporarySessionsDeleted': clean_temporary(), 'orphanObjectsDeleted':clean_orphan_objects(), 'replacedVersionsDeleted': clean_replaced_versions()}
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
