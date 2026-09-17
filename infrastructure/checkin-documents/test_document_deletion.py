"""Manual deletion and calendar retention extend the replacement-only worker."""
import copy
from unittest.mock import patch
import test_retention as fixtures
from test_retention import worker, VISIT, DOC, ORIGINAL, PREVIEW, NEW_ORIGINAL, EXPIRES, REPLACED


class DocumentDeletionTests(fixtures.WorkerFixture):
    def closed_current(self):
        self.visit.update({'status': 'CONCLUIDO', 'version': 8,
                           'closedAtIso': '2024-02-29T09:10:11.012Z',
                           'documentExpiresAtIso': '2025-02-28T09:10:11.012Z',
                           'documentRetentionReviewRequired': False})
        self.visit['document']['current'] = self.document
        self.db.rows.pop(f'_checkinDocumentVersions/{DOC}')
        self.timestamp = round(worker.parse_iso(self.visit['documentExpiresAtIso']).timestamp() * 1000)
        self.db.rows[f'_checkinPreviewJobs/{DOC}']['state'] = 'pending'

    def marker(self, **patches):
        return {'operationId': 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'source': 'manual',
                'requestedAtIso': worker.iso_time(self.timestamp), 'actorUid': 'fake-supervisor',
                'actorRole': 'SUPERVISOR', 'actorName': 'Supervisor de teste', 'reason': 'Documento anexado indevidamente', **patches}

    def test_calendar_deadline_clamps_leap_day_without_changing_clock(self):
        self.assertEqual(worker.calendar_deadline_iso('2024-02-29T09:10:11.012Z'), '2025-02-28T09:10:11.012Z')
        self.assertEqual(worker.calendar_deadline_iso('2023-03-31T23:59:59.999Z'), '2024-03-31T23:59:59.999Z')
        self.assertEqual(worker.calendar_deadline_iso('2024-02-29T23:00:00-03:00'), '2025-03-01T02:00:00.000Z')
        self.assertIsNone(worker.calendar_deadline_iso('unproven'))

    def test_current_expiration_detaches_once_then_deletes_with_two_audit_events(self):
        self.closed_current()
        before = copy.deepcopy(self.document)
        self.assertEqual(worker.expire_current_documents(), 1)
        self.assertIsNone(self.visit['document']['current'])
        self.assertEqual(self.visit['document']['status'], 'pending')
        self.assertEqual(self.visit['status'], 'CONCLUIDO')
        self.assertEqual(self.visit['version'], 9)
        archived = self.db.rows[f'_checkinDocumentVersions/{DOC}']
        self.assertEqual(archived['document'], before)
        self.assertEqual(archived['kind'], 'current-expiration')
        self.assertEqual(archived['state'], 'deletion-requested')
        self.assertIn((ORIGINAL, 11), self.bucket.objects)
        self.assertEqual(worker.expire_current_documents(), 0)
        self.assertEqual(worker.clean_replaced_versions(), 1)
        self.assertCountEqual(self.bucket.deleted, [(ORIGINAL, 11), (PREVIEW, 22)])
        self.assertIn((NEW_ORIGINAL, 33), self.bucket.objects)
        self.assertEqual(worker.clean_replaced_versions(), 0)
        audits = [v for path, v in self.db.rows.items() if f'checkins/{VISIT}/revisions/' in path]
        self.assertEqual(len(audits), 2)
        self.assertEqual({v['action'] for v in audits}, {'Nota fiscal expirada', 'Arquivo da nota fiscal removido'})
        self.assertEqual(self.visit['version'], 9)

    def test_current_is_retained_until_exact_calendar_deadline(self):
        self.closed_current()
        self.timestamp -= 1
        self.assertEqual(worker.expire_current_documents(), 0)
        self.assertIsNotNone(self.visit['document']['current'])
        self.timestamp += 1
        self.assertEqual(worker.expire_current_documents(), 1)

    def test_active_unknown_or_reviewed_closure_never_deletes_current(self):
        self.closed_current()
        for patch in [{'status': 'CHAMADO'}, {'documentRetentionReviewRequired': True},
                      {'documentExpiresAtIso': '2024-03-01T00:00:00.000Z'},
                      {'closedAtIso': None}, {'documentRetentionReviewRequired': None}, {'pendingOfficialMutation': {'id': 'reserved'}}]:
            with self.subTest(patch=patch):
                prior = copy.deepcopy(self.visit)
                self.visit.update(patch)
                self.assertFalse(worker.detach_expired_current(self.db.transaction(), self.db.collection('checkins').document(VISIT)))
                self.assertEqual(self.bucket.deleted, [])
                self.visit.clear()
                self.visit.update(prior)

    def test_cancelled_visit_has_same_calendar_retention(self):
        self.closed_current()
        self.visit['status'] = 'CANCELADO'
        self.assertEqual(worker.expire_current_documents(), 1)
        self.assertEqual(self.visit['status'], 'CANCELADO')

    def test_expired_current_cannot_start_or_finish_preview(self):
        self.closed_current()
        self.assertIsNone(worker.claim_job(self.db.transaction(), self.job_ref))
        self.timestamp -= 1
        claimed = worker.claim_job(self.db.transaction(), self.job_ref)
        self.timestamp += 1
        self.assertFalse(worker.finish_job(self.db.transaction(), self.job_ref, claimed, PREVIEW, '99', None))
        self.assertEqual(self.document['previewGeneration'], '22')

    def test_manual_deletion_of_old_version_preserves_real_90_day_deadline(self):
        self.timestamp = REPLACED + 1000
        self.archive.update({'state': 'deletion-requested', 'deletion': self.marker()})
        self.assertEqual(worker.clean_replaced_versions(), 1)
        self.assertEqual(self.archive['expiresAt'], EXPIRES)
        self.assertEqual(self.archive['state'], 'deleted')
        self.assertEqual(self.archive['deletion']['actorUid'], 'fake-supervisor')

    def test_manual_current_archive_needs_no_fictitious_90_day_age(self):
        self.timestamp = REPLACED + 1000
        self.archive.update({'kind': 'manual-deletion', 'state': 'deletion-requested',
                             'deletion': self.marker(), 'expiresAt': self.timestamp,
                             'replacementDocumentId': None, 'replacedAtIso': worker.iso_time(self.timestamp)})
        self.assertEqual(worker.clean_replaced_versions(), 1)
        self.assertEqual(self.archive['state'], 'deleted')

    def test_manual_marker_rejects_analyst_empty_reason_wrong_kind_and_future_request(self):
        self.timestamp = REPLACED + 1000
        for patches in [{'actorRole': 'ANALYST'}, {'reason': '   '}, {'actorUid': ''},
                        {'operationId': 'not-uuid'}, {'source': 'expiration'},
                        {'requestedAtIso': worker.iso_time(self.timestamp + 1)}]:
            with self.subTest(patches=patches):
                self.archive.update({'state': 'deletion-requested', 'deletion': self.marker(**patches)})
                self.assertEqual(worker.clean_replaced_versions(), 0)
                self.assertEqual(self.bucket.deleted, [])
        self.archive.update({'deletion': self.marker(), 'kind': 'unexpected'})
        self.assertEqual(worker.clean_replaced_versions(), 0)

    def test_deletion_requested_without_marker_does_not_fake_90_day_expiry(self):
        self.archive['state'] = 'deletion-requested'
        self.assertEqual(worker.clean_replaced_versions(), 0)
        self.assertEqual(self.bucket.deleted, [])

    def test_manual_request_stops_pending_preview_even_before_retention(self):
        self.timestamp = REPLACED + 1000
        self.archive.update({'state': 'deletion-requested', 'deletion': self.marker()})
        self.db.rows[f'_checkinPreviewJobs/{DOC}']['state'] = 'pending'
        self.assertIsNone(worker.claim_job(self.db.transaction(), self.job_ref))
        self.assertEqual(worker.process_previews(), 0)
        self.assertEqual(worker.clean_replaced_versions(), 1)

    def test_manual_delete_waits_for_preview_lease_and_retries_partial_removal(self):
        self.timestamp = REPLACED + 1000
        self.archive.update({'state': 'deletion-requested', 'deletion': self.marker()})
        self.db.rows[f'_checkinPreviewJobs/{DOC}'].update({'state': 'processing', 'leaseUntil': self.timestamp + 1000})
        self.assertEqual(worker.clean_replaced_versions(), 0)
        self.timestamp += 1000
        self.bucket.fail_deletes.add((PREVIEW, 22))
        self.assertEqual(worker.clean_replaced_versions(), 0)
        self.assertEqual(self.archive['state'], 'deleting')
        self.bucket.fail_deletes.clear()
        self.timestamp += worker.LEASE_MS
        self.assertEqual(worker.clean_replaced_versions(), 1)
        self.assertEqual(self.archive['state'], 'deleted')

    def test_forged_expiration_with_shortened_deadline_cannot_remove_files(self):
        self.closed_current()
        self.assertEqual(worker.expire_current_documents(), 1)
        archived = self.db.rows[f'_checkinDocumentVersions/{DOC}']
        archived['documentExpiresAtIso'] = '2024-03-01T00:00:00.000Z'
        archived['expiresAt'] = round(worker.parse_iso(archived['documentExpiresAtIso']).timestamp() * 1000)
        self.assertEqual(worker.clean_replaced_versions(), 0)
        self.assertEqual(self.bucket.deleted, [])

    def test_expiration_during_preview_upload_does_not_restore_file(self):
        self.closed_current()
        self.timestamp -= 1
        del self.bucket.objects[(PREVIEW, 22)]
        def expire():
            self.timestamp += worker.LEASE_MS + 1
            self.assertEqual(worker.expire_current_documents(), 1)
            self.assertEqual(worker.clean_replaced_versions(), 1)
        self.bucket.on_upload = expire
        with patch.object(worker, 'make_preview', return_value=b'late preview'):
            self.assertEqual(worker.process_previews(), 1)
        self.assertNotIn((ORIGINAL, 11), self.bucket.objects)
        self.assertNotIn((PREVIEW, 1000), self.bucket.objects)
        self.assertIsNone(self.visit['document']['current'])
