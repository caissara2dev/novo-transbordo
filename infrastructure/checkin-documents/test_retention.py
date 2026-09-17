"""Worker orchestration tests with in-memory storage and explicit transaction boundaries.

No credentials, GCP emulator or production resource is used. Image decoding has
its own real JPEG/PNG/HEIC tests in test_preview.py.
"""
import copy
import importlib
import os
import unittest
from unittest.mock import patch

from google.api_core.exceptions import NotFound, PreconditionFailed

PROJECT = 'line-transbordo-staging-382612'
with patch.dict(os.environ, {'GOOGLE_CLOUD_PROJECT': PROJECT, 'CHECKIN_DOCUMENT_BUCKET': PROJECT + '-checkin-nf'}), \
        patch('google.cloud.firestore.Client'), patch('google.cloud.storage.Client'), \
        patch('google.cloud.firestore.transactional', lambda function: function):
    worker = importlib.import_module('main')

VISIT = '11111111-1111-4111-8111-111111111111'
OTHER_VISIT = '22222222-2222-4222-8222-222222222222'
DOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
NEW_DOC = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
ORIGINAL = f'checkin-uploads/{"c" * 64}/{DOC}/original'
NEW_ORIGINAL = f'checkin-uploads/{"d" * 64}/{NEW_DOC}/original'
PREVIEW = f'checkin-previews/{VISIT}/{DOC}.jpg'
REPLACED = 1_789_000_000_000
EXPIRES = REPLACED + 90 * 86_400_000


class Snapshot:
    def __init__(self, ref):
        self.reference, self.id = ref, ref.id
        self.value = copy.deepcopy(ref.db.rows.get(ref.path))

    def to_dict(self):
        return copy.deepcopy(self.value)


class Ref:
    def __init__(self, db, path):
        self.db, self.path, self.id = db, path, path.split('/')[-1]

    def get(self, transaction=None):
        if transaction:
            if transaction.written:
                raise AssertionError('Firestore transactions must read before writing')
        return Snapshot(self)

    def update(self, patch):
        value = self.db.rows[self.path]
        for path, data in patch.items():
            parts = path.split('.')
            target = value
            for part in parts[:-1]:
                target = target.setdefault(part, {})
            target[parts[-1]] = copy.deepcopy(data)


class Query:
    def __init__(self, db, name, filters=(), limit=None):
        self.db, self.name, self.filters, self.row_limit = db, name, filters, limit

    def document(self, document_id):
        return Ref(self.db, f'{self.name}/{document_id}')

    def where(self, filter):
        return Query(self.db, self.name, self.filters + (filter,), self.row_limit)

    def limit(self, limit):
        return Query(self.db, self.name, self.filters, limit)

    def stream(self):
        def matches(value, condition):
            actual = value.get(condition.field_path)
            return actual in condition.value if condition.op_string == 'in' else actual is not None and actual <= condition.value
        rows = [Snapshot(Ref(self.db, path)) for path, value in list(self.db.rows.items())
                if path.startswith(self.name + '/') and all(matches(value, f) for f in self.filters)]
        return iter(rows[:self.row_limit])


class Transaction:
    def __init__(self):
        self.written = False

    def update(self, ref, value):
        self.written = True
        ref.update(value)


class Database:
    def __init__(self):
        self.rows = {}

    def collection(self, name):
        return Query(self, name)

    def transaction(self):
        return Transaction()


class Blob:
    def __init__(self, bucket, name, generation=None):
        self.bucket, self.name, self.generation = bucket, name, generation
        self.metadata, self.size = None, None

    def reload(self, **_):
        matching = [g for name, g in self.bucket.objects if name == self.name]
        if self.generation is None:
            if not matching:
                raise NotFound('missing')
            self.generation = max(matching)
        if (self.name, self.generation) not in self.bucket.objects:
            raise NotFound('missing')
        self.size = len(self.bucket.objects[self.name, self.generation])

    def download_as_bytes(self, if_generation_match, **_):
        self.reload()
        if self.generation != if_generation_match:
            raise PreconditionFailed('generation mismatch')
        return self.bucket.objects[self.name, self.generation]

    def upload_from_string(self, data, if_generation_match, **_):
        if self.bucket.on_upload:
            self.bucket.on_upload()
        if if_generation_match != 0 or any(name == self.name for name, _ in self.bucket.objects):
            raise PreconditionFailed('generation mismatch')
        self.generation = self.bucket.next_generation
        self.bucket.next_generation += 1
        self.bucket.objects[self.name, self.generation] = data

    def delete(self, if_generation_match, **_):
        if self.generation != if_generation_match:
            raise AssertionError('Deletion was not pinned to an immutable generation')
        key = self.name, self.generation
        if key in self.bucket.fail_deletes:
            raise RuntimeError('storage unavailable')
        if key not in self.bucket.objects:
            raise NotFound('missing')
        self.bucket.deleted.append(key)
        del self.bucket.objects[key]


class Bucket:
    def __init__(self):
        self.objects, self.deleted, self.fail_deletes = {}, [], set()
        self.next_generation, self.on_upload = 1000, None

    def blob(self, name, generation=None):
        return Blob(self, name, generation)


class RetentionTests(unittest.TestCase):
    def setUp(self):
        self.db, self.bucket, self.timestamp = Database(), Bucket(), EXPIRES
        self.patches = [patch.object(worker, 'db', self.db), patch.object(worker, 'bucket', self.bucket),
                        patch.object(worker, 'now', lambda: self.timestamp)]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)
        self.document = {'id': DOC, 'object': ORIGINAL, 'generation': '11', 'name': 'fake.jpg', 'size': 100,
                         'contentType': 'image/jpeg', 'previewStatus': 'ready', 'previewObject': PREVIEW,
                         'previewGeneration': '22', 'receivedAtIso': worker.iso_time(REPLACED - 1000)}
        self.new_document = {'id': NEW_DOC, 'object': NEW_ORIGINAL, 'generation': '33', 'previewStatus': 'pending'}
        self.visit = {'document': {'current': self.new_document, 'status': 'received'}, 'status': 'AGUARDANDO_LIBERACAO'}
        self.archive = {'visitId': VISIT, 'document': self.document, 'state': 'available',
                        'replacedAtIso': worker.iso_time(REPLACED), 'expiresAt': EXPIRES,
                        'replacedBy': 'Analista de teste', 'actorUid': 'fake-user', 'replacementDocumentId': NEW_DOC}
        self.db.rows[f'checkins/{VISIT}'] = self.visit
        self.db.rows[f'_checkinDocumentVersions/{DOC}'] = self.archive
        self.db.rows[f'_checkinTemporaryObjects/{DOC}'] = {'state': 'linked', 'visitId': VISIT, 'object': ORIGINAL}
        self.db.rows[f'_checkinPreviewJobs/{DOC}'] = self.job('complete')
        self.ref = self.db.collection('_checkinDocumentVersions').document(DOC)
        self.job_ref = self.db.collection('_checkinPreviewJobs').document(DOC)
        self.bucket.objects = {(ORIGINAL, 11): b'original', (PREVIEW, 22): b'preview', (NEW_ORIGINAL, 33): b'current original'}

    def job(self, state='pending'):
        return {'state': state, 'visitId': VISIT, 'documentId': DOC, 'object': ORIGINAL, 'generation': '11', 'attempts': 0}

    def test_before_90_days_keeps_both_files_and_metadata(self):
        self.timestamp = EXPIRES - 1
        self.assertEqual(worker.clean_replaced_versions(), 0)
        self.assertEqual(self.archive['state'], 'available')
        self.assertEqual(self.bucket.deleted, [])

    def test_at_90_days_removes_only_archived_generations_and_keeps_metadata(self):
        before_visit = copy.deepcopy(self.visit)
        before_document = copy.deepcopy(self.document)
        self.assertEqual(worker.clean_replaced_versions(), 1)
        self.assertCountEqual(self.bucket.deleted, [(ORIGINAL, 11), (PREVIEW, 22)])
        self.assertEqual(self.bucket.objects, {(NEW_ORIGINAL, 33): b'current original'})
        self.assertEqual(self.archive['state'], 'deleted')
        self.assertEqual(self.archive['document'], before_document)
        self.assertEqual(self.archive['replacedBy'], 'Analista de teste')
        self.assertEqual(self.archive['deletedAtIso'], worker.iso_time(EXPIRES))
        self.assertEqual(self.visit, before_visit)
        self.assertEqual(worker.clean_replaced_versions(), 0)

    def test_rejects_metadata_with_less_than_90_days_retention(self):
        self.archive['expiresAt'] = EXPIRES - 1
        self.assertEqual(worker.clean_replaced_versions(), 0)
        self.assertEqual(self.bucket.deleted, [])

    def test_refuses_current_document_even_if_archive_exists(self):
        for current in [self.document, {**self.document, 'generation': '99'},
                        {**self.new_document, 'object': ORIGINAL}]:
            with self.subTest(current=current):
                self.visit['document']['current'] = current
                self.assertEqual(worker.clean_replaced_versions(), 0)
                self.assertEqual(self.bucket.deleted, [])

    def test_refuses_cross_visit_archive(self):
        self.archive['visitId'] = OTHER_VISIT
        self.db.rows[f'checkins/{OTHER_VISIT}'] = copy.deepcopy(self.visit)
        self.document.pop('previewObject')
        self.assertEqual(worker.clean_replaced_versions(), 0)
        self.assertEqual(self.bucket.deleted, [])

    def test_missing_visit_is_not_permission_to_delete(self):
        del self.db.rows[f'checkins/{VISIT}']
        self.assertEqual(worker.clean_replaced_versions(), 0)

    def test_rejects_unbound_original(self):
        self.db.rows[f'_checkinTemporaryObjects/{DOC}']['state'] = 'unlinked'
        self.assertEqual(worker.clean_replaced_versions(), 0)
        self.assertEqual(self.bucket.deleted, [])

    def test_rejects_unexpected_paths_and_generations(self):
        for key, value in [('object', NEW_ORIGINAL), ('object', 'checkin-uploads/../../original'),
                           ('previewObject', f'checkin-previews/{OTHER_VISIT}/{DOC}.jpg'),
                           ('id', NEW_DOC), ('generation', '0'), ('generation', 'nan')]:
            with self.subTest(key=key, value=value):
                original = self.document[key]
                self.document[key] = value
                self.assertEqual(worker.clean_replaced_versions(), 0)
                self.assertEqual(self.bucket.deleted, [])
                self.document[key] = original

    def test_partial_delete_retries_after_lease_and_preserves_current(self):
        self.bucket.fail_deletes.add((PREVIEW, 22))
        self.assertEqual(worker.clean_replaced_versions(), 0)
        self.assertEqual(self.archive['state'], 'deleting')
        self.assertNotIn('deletedAtIso', self.archive)
        self.assertEqual(self.bucket.deleted, [(ORIGINAL, 11)])
        self.bucket.fail_deletes.clear()
        self.assertEqual(worker.clean_replaced_versions(), 0)
        self.timestamp += worker.LEASE_MS
        self.assertEqual(worker.clean_replaced_versions(), 1)
        self.assertEqual(self.archive['state'], 'deleted')
        self.assertEqual(self.bucket.objects, {(NEW_ORIGINAL, 33): b'current original'})

    def test_missing_blobs_are_successful_idempotent_cleanup(self):
        del self.bucket.objects[(ORIGINAL, 11)]
        del self.bucket.objects[(PREVIEW, 22)]
        self.assertEqual(worker.clean_replaced_versions(), 1)
        self.assertEqual(self.archive['state'], 'deleted')
        self.assertEqual(self.bucket.deleted, [])

    def test_new_storage_generation_is_never_deleted_by_old_receipt(self):
        self.bucket.objects[(ORIGINAL, 44)] = b'other generation'
        self.bucket.objects[(PREVIEW, 55)] = b'other preview generation'
        self.assertEqual(worker.clean_replaced_versions(), 1)
        self.assertIn((ORIGINAL, 44), self.bucket.objects)
        self.assertIn((PREVIEW, 55), self.bucket.objects)

    def test_legacy_preview_without_generation_is_pinned_before_delete(self):
        del self.document['previewGeneration']
        self.assertEqual(worker.clean_replaced_versions(), 1)
        self.assertEqual(self.archive['cleanupPreviewGeneration'], '22')
        self.assertCountEqual(self.bucket.deleted, [(ORIGINAL, 11), (PREVIEW, 22)])

    def test_pdf_without_preview_deletes_only_original(self):
        self.document.update({'contentType': 'application/pdf', 'previewStatus': 'not-applicable'})
        self.document.pop('previewObject')
        self.document.pop('previewGeneration')
        del self.bucket.objects[(PREVIEW, 22)]
        del self.db.rows[f'_checkinPreviewJobs/{DOC}']
        self.assertEqual(worker.clean_replaced_versions(), 1)
        self.assertEqual(self.bucket.deleted, [(ORIGINAL, 11)])

    def test_active_preview_lease_prevents_cleanup(self):
        self.db.rows[f'_checkinPreviewJobs/{DOC}'].update({'state': 'processing', 'leaseUntil': EXPIRES + 1})
        self.assertEqual(worker.clean_replaced_versions(), 0)
        self.assertEqual(self.bucket.deleted, [])
        self.timestamp += 1
        self.assertEqual(worker.clean_replaced_versions(), 1)
        self.assertEqual(self.db.rows[f'_checkinPreviewJobs/{DOC}']['state'], 'cancelled')

    def test_pending_preview_is_cancelled_and_cannot_recreate_after_cleanup(self):
        self.db.rows[f'_checkinPreviewJobs/{DOC}']['state'] = 'pending'
        self.assertEqual(worker.clean_replaced_versions(), 1)
        self.assertIsNone(worker.claim_job(self.db.transaction(), self.job_ref))
        self.assertEqual(worker.process_previews(), 0)

    def test_mismatched_preview_job_blocks_cleanup(self):
        self.db.rows[f'_checkinPreviewJobs/{DOC}']['visitId'] = OTHER_VISIT
        self.assertEqual(worker.clean_replaced_versions(), 0)
        self.assertEqual(self.bucket.deleted, [])

    def test_expired_archive_cannot_start_preview_even_before_cleanup(self):
        self.db.rows[f'_checkinPreviewJobs/{DOC}']['state'] = 'pending'
        self.assertIsNone(worker.claim_job(self.db.transaction(), self.job_ref))

    def test_stale_cleanup_cannot_commit_after_another_claim(self):
        first = worker.claim_expired_version(self.db.transaction(), self.ref)
        self.timestamp += worker.LEASE_MS
        second = worker.claim_expired_version(self.db.transaction(), self.ref)
        self.assertNotEqual(first['cleanupToken'], second['cleanupToken'])
        self.assertFalse(worker.record_preview_generation(self.db.transaction(), self.ref, first, '22'))
        self.assertFalse(worker.finish_version_cleanup(self.db.transaction(), self.ref, first))
        self.assertTrue(worker.finish_version_cleanup(self.db.transaction(), self.ref, second))

    def test_preview_finishes_in_archive_after_replacement_during_processing(self):
        self.timestamp = REPLACED - 1
        self.db.rows[f'_checkinPreviewJobs/{DOC}']['state'] = 'pending'
        self.visit['document']['current'] = self.document
        self.db.rows.pop(f'_checkinDocumentVersions/{DOC}')
        claimed = worker.claim_job(self.db.transaction(), self.job_ref)
        self.assertIsNotNone(claimed)
        # Atomic replacement happened after the worker read its original.
        self.visit['document']['current'] = self.new_document
        self.db.rows[f'_checkinDocumentVersions/{DOC}'] = self.archive
        self.timestamp = REPLACED + 1
        before_current = copy.deepcopy(self.new_document)
        self.assertTrue(worker.finish_job(self.db.transaction(), self.job_ref, claimed, PREVIEW, '123', None))
        self.assertEqual(self.document['previewGeneration'], '123')
        self.assertEqual(self.document['previewStatus'], 'ready')
        self.assertEqual(self.new_document, before_current)

    def test_old_preview_completion_cannot_repopulate_deleted_archive(self):
        self.timestamp = EXPIRES - worker.LEASE_MS
        self.db.rows[f'_checkinPreviewJobs/{DOC}']['state'] = 'pending'
        claimed = worker.claim_job(self.db.transaction(), self.job_ref)
        self.timestamp = EXPIRES
        self.assertEqual(worker.clean_replaced_versions(), 1)
        self.assertFalse(worker.finish_job(self.db.transaction(), self.job_ref, claimed, PREVIEW, '123', None))
        self.assertEqual(self.document['previewGeneration'], '22')
        self.assertTrue(worker.obsolete_preview(self.db.transaction(), claimed))

    def test_stale_preview_owner_must_not_delete_output_recovered_by_new_owner(self):
        self.timestamp = REPLACED
        self.db.rows[f'_checkinPreviewJobs/{DOC}']['state'] = 'pending'
        first = worker.claim_job(self.db.transaction(), self.job_ref)
        self.timestamp += worker.LEASE_MS
        second = worker.claim_job(self.db.transaction(), self.job_ref)
        self.assertFalse(worker.finish_job(self.db.transaction(), self.job_ref, first, PREVIEW, '22', None))
        self.assertTrue(worker.finish_job(self.db.transaction(), self.job_ref, second, PREVIEW, '22', None))
        self.assertFalse(worker.obsolete_preview(self.db.transaction(), first))

    def test_preview_upload_of_replaced_original_preserves_original_and_current(self):
        self.timestamp = REPLACED
        self.db.rows[f'_checkinPreviewJobs/{DOC}']['state'] = 'pending'
        del self.bucket.objects[(PREVIEW, 22)]
        with patch.object(worker, 'make_preview', return_value=b'new preview'):
            self.assertEqual(worker.process_previews(), 1)
        self.assertEqual(self.document['previewGeneration'], '1000')
        self.assertEqual(self.document['previewStatus'], 'ready')
        self.assertEqual(self.bucket.objects[(ORIGINAL, 11)], b'original')
        self.assertEqual(self.bucket.objects[(NEW_ORIGINAL, 33)], b'current original')

    def test_recover_previous_upload_without_overwriting_its_generation(self):
        self.timestamp = REPLACED
        self.db.rows[f'_checkinPreviewJobs/{DOC}']['state'] = 'pending'
        with patch.object(worker, 'make_preview', return_value=b'new preview'):
            self.assertEqual(worker.process_previews(), 1)
        self.assertEqual(self.document['previewGeneration'], '22')
        self.assertEqual(self.bucket.objects[(PREVIEW, 22)], b'preview')

    def test_expiry_during_upload_cleans_late_output_without_resurrecting_archive(self):
        self.timestamp = EXPIRES - 1
        self.db.rows[f'_checkinPreviewJobs/{DOC}']['state'] = 'pending'
        del self.bucket.objects[(PREVIEW, 22)]
        def expire_and_clean():
            # A paused upload outlives the lease; another request completes
            # retention before the old upload response returns.
            self.timestamp = EXPIRES + worker.LEASE_MS
            self.assertEqual(worker.clean_replaced_versions(), 1)
        self.bucket.on_upload = expire_and_clean
        with patch.object(worker, 'make_preview', return_value=b'late preview'):
            self.assertEqual(worker.process_previews(), 1)
        self.assertEqual(self.archive['state'], 'deleted')
        self.assertEqual(self.bucket.objects, {(NEW_ORIGINAL, 33): b'current original'})
        self.assertIn((PREVIEW, 1000), self.bucket.deleted)

    def test_malformed_preview_job_is_not_allowed_to_delete_an_archive(self):
        del self.db.rows[f'_checkinPreviewJobs/{DOC}']['generation']
        self.assertEqual(worker.clean_replaced_versions(), 0)
        self.assertEqual(self.bucket.deleted, [])

    def uppercase_document_fixture(self):
        # z.string().uuid() accepts uppercase public attempt IDs. Object paths
        # are case-sensitive and must retain exactly what the API stored.
        upper_id = DOC.upper()
        upper_visit = 'CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC'
        upper_original = ORIGINAL.replace(DOC, upper_id)
        upper_preview = f'checkin-previews/{upper_visit}/{upper_id}.jpg'
        self.document.update({'id': upper_id, 'object': upper_original, 'previewObject': upper_preview})
        self.archive['visitId'] = upper_visit
        self.db.rows[f'checkins/{upper_visit}'] = self.db.rows.pop(f'checkins/{VISIT}')
        self.db.rows[f'_checkinDocumentVersions/{upper_id}'] = self.db.rows.pop(f'_checkinDocumentVersions/{DOC}')
        self.db.rows.pop(f'_checkinTemporaryObjects/{DOC}')
        self.db.rows[f'_checkinTemporaryObjects/{upper_id}'] = {
            'state': 'linked', 'visitId': upper_visit, 'object': upper_original}
        self.db.rows.pop(f'_checkinPreviewJobs/{DOC}')
        self.db.rows[f'_checkinPreviewJobs/{upper_id}'] = {
            **self.job('pending'), 'documentId': upper_id, 'visitId': upper_visit, 'object': upper_original}
        self.bucket.objects[(upper_original, 11)] = self.bucket.objects.pop((ORIGINAL, 11))
        self.bucket.objects[(upper_preview, 22)] = self.bucket.objects.pop((PREVIEW, 22))
        return upper_id, upper_original, upper_preview

    def test_uppercase_public_attempt_generates_preview_preserving_path_case(self):
        upper_id, upper_original, upper_preview = self.uppercase_document_fixture()
        self.timestamp = REPLACED
        # Exercise a still-current driver upload, before any replacement.
        self.visit['document']['current'] = self.document
        del self.db.rows[f'_checkinDocumentVersions/{upper_id}']
        del self.bucket.objects[(upper_preview, 22)]
        with patch.object(worker, 'make_preview', return_value=b'uppercase preview'):
            self.assertEqual(worker.process_previews(), 1)
        self.assertEqual(self.document['previewStatus'], 'ready')
        self.assertEqual(self.document['previewObject'], upper_preview)
        self.assertEqual(self.bucket.objects[(upper_preview, 1000)], b'uppercase preview')
        self.assertIn((upper_original, 11), self.bucket.objects)

    def test_uppercase_archived_attempt_is_cleaned_after_retention(self):
        _, upper_original, upper_preview = self.uppercase_document_fixture()
        self.assertEqual(worker.clean_replaced_versions(), 1)
        self.assertCountEqual(self.bucket.deleted, [(upper_original, 11), (upper_preview, 22)])
        self.assertEqual(self.archive['state'], 'deleted')

    def test_uppercase_compatibility_does_not_allow_different_case_object_id(self):
        upper_id, _, _ = self.uppercase_document_fixture()
        self.document['object'] = ORIGINAL  # Different GCS object, not an alias.
        self.assertFalse(worker.valid_receipt(self.document, self.archive['visitId'], upper_id))
        self.assertEqual(worker.clean_replaced_versions(), 0)
        self.assertEqual(self.bucket.deleted, [])

    def test_failure_preview_does_not_delete_original_or_release_visit(self):
        self.timestamp = REPLACED
        self.db.rows[f'_checkinPreviewJobs/{DOC}']['state'] = 'pending'
        with patch.object(worker, 'make_preview', side_effect=ValueError('broken image')):
            self.assertEqual(worker.process_previews(), 1)
        self.assertEqual(self.document['previewStatus'], 'failed')
        self.assertIn((ORIGINAL, 11), self.bucket.objects)
        self.assertEqual(self.visit['status'], 'AGUARDANDO_LIBERACAO')


if __name__ == '__main__':
    unittest.main()
