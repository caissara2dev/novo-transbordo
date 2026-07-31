export type BundleFile = {
  path: string;
  source: string;
};

export type ServerBundleViolation = {
  code:
    | "EXTERNAL_FIREBASE_ADMIN"
    | "MISSING_BUNDLED_FIREBASE_ADMIN"
    | "ADMIN_MARKER_IN_CLIENT_BUNDLE";
  file: string;
  message: string;
};

export function findServerBundleViolations(input: {
  serverFiles: BundleFile[];
  clientFiles: BundleFile[];
}): ServerBundleViolation[];
