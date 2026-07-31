const bundledFirebaseAdminPathPattern =
  /(?:^|\/)node_modules_firebase-admin_lib_[^/]+\.js$/;

const externalFirebaseAdminPatterns = [
  /firebase-admin-[A-Za-z0-9_-]+\/(?:app|app-check|auth|firestore)\b/,
  /\brequire\s*\(\s*["']firebase-admin(?:\/[^"']+)?["']\s*\)/,
  /\bimport\s*\(\s*["']firebase-admin(?:\/[^"']+)?["']\s*\)/,
  /\bfrom\s*["']firebase-admin(?:\/[^"']+)?["']/
];

const forbiddenClientMarkers = [
  "firebase-admin",
  "FIREBASE_PRIVATE_KEY",
  "FIREBASE_CLIENT_EMAIL"
];

function externalAdminViolations(serverFiles) {
  return serverFiles.flatMap((file) =>
    externalFirebaseAdminPatterns.some((pattern) => pattern.test(file.source))
      ? [
          {
            code: "EXTERNAL_FIREBASE_ADMIN",
            file: file.path,
            message: "Firebase Admin permanece externo no bundle do servidor."
          }
        ]
      : []
  );
}

function bundledAdminViolations(serverFiles) {
  const hasBundledAdmin = serverFiles.some((file) =>
    bundledFirebaseAdminPathPattern.test(file.path)
  );

  return hasBundledAdmin
    ? []
    : [
        {
          code: "MISSING_BUNDLED_FIREBASE_ADMIN",
          file: ".next/server",
          message: "O bundle do servidor não contém o chunk do Firebase Admin."
        }
      ];
}

function clientBundleViolations(clientFiles) {
  return clientFiles.flatMap((file) =>
    forbiddenClientMarkers.flatMap((marker) =>
      file.source.includes(marker)
        ? [
            {
              code: "ADMIN_MARKER_IN_CLIENT_BUNDLE",
              file: file.path,
              message: `Marcador administrativo encontrado no cliente: ${marker}.`
            }
          ]
        : []
    )
  );
}

export function findServerBundleViolations({ serverFiles, clientFiles }) {
  return [
    ...externalAdminViolations(serverFiles),
    ...bundledAdminViolations(serverFiles),
    ...clientBundleViolations(clientFiles)
  ];
}
