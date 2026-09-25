"""Environment selection tests; no cloud clients or credentials."""
import unittest
from runtime_config import document_environment


class RuntimeConfigTests(unittest.TestCase):
    def test_production_requires_explicit_selection(self):
        config = {'GOOGLE_CLOUD_PROJECT': 'line-transbordo',
                  'CHECKIN_DOCUMENT_BUCKET': 'line-transbordo-checkin-nf'}
        for selector in (None, '', 'staging', 'prod', 'demo'):
            with self.subTest(selector=selector), self.assertRaises(RuntimeError):
                document_environment({**config, 'CHECKIN_DOCUMENT_ENVIRONMENT': selector})
        self.assertEqual(document_environment({**config, 'CHECKIN_DOCUMENT_ENVIRONMENT': 'production'}),
                         ('line-transbordo', 'line-transbordo-checkin-nf'))

    def test_staging_compatibility(self):
        project = 'line-transbordo-staging-382612'
        for selector in (None, '', 'staging'):
            self.assertEqual(document_environment({'GOOGLE_CLOUD_PROJECT': project,
                'CHECKIN_DOCUMENT_BUCKET': project + '-checkin-nf',
                'CHECKIN_DOCUMENT_ENVIRONMENT': selector}), (project, project + '-checkin-nf'))

    def test_rejects_crossed_missing_and_unknown_configuration(self):
        config = {'GOOGLE_CLOUD_PROJECT': 'line-transbordo',
                  'CHECKIN_DOCUMENT_BUCKET': 'line-transbordo-checkin-nf',
                  'CHECKIN_DOCUMENT_ENVIRONMENT': 'production'}
        overrides = [
            {'GOOGLE_CLOUD_PROJECT': 'unknown'}, {'GOOGLE_CLOUD_PROJECT': None},
            {'GOOGLE_CLOUD_PROJECT': 'line-transbordo-staging-382612'},
            {'CHECKIN_DOCUMENT_BUCKET': 'line-transbordo-staging-382612-checkin-nf'},
            {'CHECKIN_DOCUMENT_BUCKET': None},
        ] + [{key: '127.0.0.1:8188'} for key in (
            'FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST',
            'STORAGE_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST')]
        for override in overrides:
            with self.subTest(override=override), self.assertRaises(RuntimeError):
                document_environment({**config, **override})
        with self.assertRaises(RuntimeError):
            document_environment({'GOOGLE_CLOUD_PROJECT': 'demo-checkin-nf',
                                  'CHECKIN_DOCUMENT_BUCKET': 'demo-checkin-nf-checkin-nf',
                                  'FIRESTORE_EMULATOR_HOST': '127.0.0.1:8188'})
