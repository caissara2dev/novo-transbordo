"""Explicit cloud project/bucket pairs. No clients or credentials are loaded here."""


def document_environment(env):
    project = env.get('GOOGLE_CLOUD_PROJECT')
    environment = env.get('CHECKIN_DOCUMENT_ENVIRONMENT')
    bucket = env.get('CHECKIN_DOCUMENT_BUCKET')
    staging = project == 'line-transbordo-staging-382612' and environment in (None, '', 'staging')
    production = project == 'line-transbordo' and environment == 'production'
    if not (staging or production):
        raise RuntimeError('Document environment is not enabled')
    if any(env.get(key) for key in ('FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST',
                                   'STORAGE_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST')):
        raise RuntimeError('Cloud document worker cannot use emulators')
    if bucket != f'{project}-checkin-nf':
        raise RuntimeError('Unexpected document bucket')
    return project, bucket
