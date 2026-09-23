"""Private Cloud Run worker. Cloud Scheduler calls POST /run with an OIDC token.
Cloud Run IAM, not a public shared token, authenticates callers.
"""
import calendar
import json
import math
import os
import re
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from uuid import NAMESPACE_URL, uuid4, uuid5
import requests
from google.api_core.exceptions import NotFound, PreconditionFailed
from google.cloud import firestore, storage
from google.cloud.firestore_v1.base_query import FieldFilter
from preview import make_preview
from runtime_config import document_environment

PROJECT, BUCKET = document_environment(os.environ)
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



TERMINAL_STATUSES = ('CONCLUIDO', 'CANCELADO')
SYSTEM_UID = 'checkin-document-worker'


def parse_iso(value):
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return parsed.astimezone(timezone.utc) if parsed.tzinfo is not None else None
    except (ValueError, TypeError, AttributeError):
        return None


def calendar_deadline_iso(closed_at):
    closed = parse_iso(closed_at)
    if not closed or closed.year >= 9999:
        return None
    deadline = closed.replace(year=closed.year + 1,
                              day=min(closed.day, calendar.monthrange(closed.year + 1, closed.month)[1]))
    return iso_time(round(deadline.timestamp() * 1000))


def valid_closure(value):
    closed = parse_iso(value.get('closedAtIso'))
    deadline = calendar_deadline_iso(value.get('closedAtIso'))
    return bool(closed and deadline and value.get('documentExpiresAtIso') == deadline)


def current_preview_allowed(visit, timestamp):
    # Unknown legacy closure dates are not guessed, but an explicit expired
    # deadline must never cause a new copy of the document to be generated.
    deadline = parse_iso(visit.get('documentExpiresAtIso'))
    return not (deadline and deadline.timestamp() * 1000 <= timestamp)


def valid_deletion_marker(archive, timestamp):
    marker = archive.get('deletion')
    if not isinstance(marker, dict) or not UUID.fullmatch(str(marker.get('operationId', ''))):
        return False
    requested = parse_iso(marker.get('requestedAtIso'))
    if not requested or requested.timestamp() * 1000 > timestamp:
        return False
    if not all(isinstance(marker.get(key), str) and marker[key].strip()
               for key in ('actorUid', 'actorName', 'reason')):
        return False
    kind = archive.get('kind', 'replacement')
    if marker.get('source') == 'manual':
        return (marker.get('actorRole') in ('ADMIN', 'SUPERVISOR')
                and kind in ('replacement', 'manual-deletion')
                and (kind != 'replacement' or valid_retention(archive)))
    if marker.get('source') == 'expiration':
        deadline = parse_iso(archive.get('documentExpiresAtIso'))
        return bool(kind == 'current-expiration' and marker.get('actorRole') == 'SYSTEM'
                    and marker.get('actorUid') == SYSTEM_UID and valid_closure(archive) and deadline
                    and archive.get('expiresAt') == round(deadline.timestamp() * 1000)
                    and archive['expiresAt'] <= timestamp)
    return False


def deletion_due(archive, timestamp):
    # A validated manual request bypasses the wait, never rewrites the original
    # 90-day deadline to pretend that an early deletion was scheduled retention.
    if archive.get('deletion') is not None:
        return archive.get('state') in ('deletion-requested', 'deleting') and valid_deletion_marker(archive, timestamp)
    return (archive.get('kind', 'replacement') == 'replacement'
            and archive.get('state') != 'deletion-requested'
            and valid_retention(archive) and archive['expiresAt'] <= timestamp)


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
    if not visit or not ((same_document(current, job) and current_preview_allowed(visit, timestamp)) or archived):
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
    if same_document(current, job) and current_preview_allowed(visit, now()):
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
    if same_document(current, job) and current_preview_allowed(visit or {}, now()):
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
    if (not archive or archive.get('state') not in ('available', 'deletion-requested', 'deleting')
            or not deletion_due(archive, timestamp)
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
    audit_ref = db.collection('checkins').document(archive['visitId']).collection('revisions').document(f'document-deleted-{ref.id}')
    existing_audit = audit_ref.get(transaction=tx).to_dict()
    timestamp = iso_time(now())
    tx.update(ref, {'state': 'deleted', 'deletedAtIso': timestamp, 'cleanupLeaseUntil': 0})
    if not existing_audit:
        tx.create(audit_ref, {
            'action': 'Arquivo da nota fiscal removido', 'actor': 'Sistema Line', 'actorUid': SYSTEM_UID,
            'actorRole': 'SYSTEM', 'documentId': ref.id, 'createdAtIso': timestamp,
            'changedFields': [archive['document']['name']],
            'reason': (archive.get('deletion') or {}).get('reason', 'Prazo de 90 dias da versão substituída encerrado'),
        })
    return True


def delete_generation(object_name, generation):
    try:
        bucket.blob(object_name, generation=int(generation)).delete(if_generation_match=int(generation), timeout=30)
    except NotFound:
        # Idempotent after a partial deletion or a lost storage response.
        pass


def clean_replaced_versions():
    count = 0
    collection = db.collection('_checkinDocumentVersions')
    # Explicit deletions can have a future replacement deadline. Read those
    # states separately; the immutable marker is checked again in the claim.
    requested = list(collection.where(filter=FieldFilter('state', 'in', ['deletion-requested', 'deleting'])).limit(30).stream())
    expired = list(collection.where(filter=FieldFilter('state', '==', 'available'))
                   .where(filter=FieldFilter('expiresAt', '<=', now())).limit(30).stream())
    rows = {snap.id: snap for snap in requested + expired}
    for snap in rows.values():
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
def detach_expired_current(tx, ref):
    visit = ref.get(transaction=tx).to_dict()
    timestamp = now()
    if (not visit or visit.get('status') not in TERMINAL_STATUSES or visit.get('pendingOfficialMutation')
            or visit.get('documentRetentionReviewRequired') is not False or not valid_closure(visit)):
        return False
    deadline = parse_iso(visit['documentExpiresAtIso'])
    if deadline.timestamp() * 1000 > timestamp:
        return False
    receipt = (visit.get('document') or {}).get('current')
    if not receipt or not valid_receipt(receipt, ref.id, receipt.get('id')):
        return False
    archive_ref = db.collection('_checkinDocumentVersions').document(receipt['id'])
    if archive_ref.get(transaction=tx).to_dict():
        return False
    if not linked_original(tx, receipt['id'], ref.id, receipt['object']):
        return False
    version = visit.get('version')
    if not isinstance(version, int) or isinstance(version, bool) or version < 1:
        return False
    audit_ref = ref.collection('revisions').document(f'document-expiration-{receipt["id"]}')
    if audit_ref.get(transaction=tx).to_dict():
        return False
    at = iso_time(timestamp)
    marker = {'operationId': str(uuid5(NAMESPACE_URL, f'checkin-document-expiration:{ref.id}:{receipt["id"]}')),
              'requestedAtIso': at, 'actorUid': SYSTEM_UID, 'actorRole': 'SYSTEM', 'actorName': 'Sistema Line',
              'reason': 'Prazo de 12 meses após o encerramento da visita encerrado', 'source': 'expiration'}
    tx.create(archive_ref, {
        'visitId': ref.id, 'document': receipt, 'kind': 'current-expiration', 'state': 'deletion-requested',
        'replacedAtIso': at, 'replacedBy': 'Sistema Line', 'actorUid': SYSTEM_UID,
        'expiresAt': round(deadline.timestamp() * 1000), 'replacementDocumentId': None, 'deletion': marker,
        'closedAtIso': visit['closedAtIso'], 'documentExpiresAtIso': visit['documentExpiresAtIso'],
    })
    tx.update(ref, {'document.current': None, 'document.status': 'pending', 'version': version + 1,
                    'updatedAtIso': at, 'updatedBy': 'Sistema Line'})
    tx.create(audit_ref, {
        'action': 'Nota fiscal expirada', 'actor': 'Sistema Line', 'actorUid': SYSTEM_UID, 'actorRole': 'SYSTEM',
        'documentId': receipt['id'], 'createdAtIso': at, 'changedFields': [receipt['name']],
        'previousVersion': version, 'newVersion': version + 1, 'reason': marker['reason'],
    })
    return True


def expire_current_documents():
    rows = (db.collection('checkins').where(filter=FieldFilter('status', 'in', list(TERMINAL_STATUSES)))
            .where(filter=FieldFilter('document.status', '==', 'received'))
            .where(filter=FieldFilter('documentRetentionReviewRequired', '==', False))
            .where(filter=FieldFilter('documentExpiresAtIso', '<=', iso_time(now()))).limit(30).stream())
    return sum(bool(detach_expired_current(db.transaction(), snap.reference)) for snap in rows)


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
            payload = {'currentDocumentsExpired': expire_current_documents(), 'previews': process_previews(), 'temporarySessionsDeleted': clean_temporary(), 'orphanObjectsDeleted':clean_orphan_objects(), 'replacedVersionsDeleted': clean_replaced_versions()}
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
