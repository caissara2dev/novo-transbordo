"""Copy a bounded inventory of immutable object generations. Never delete source data."""
import argparse
from dataclasses import dataclass
import hashlib
import json
import re


@dataclass(frozen=True)
class Object:
    name: str
    generation: str
    size: int
    crc32c: str


def validate(item):
    if (not isinstance(item, Object) or not item.name
            or not re.fullmatch(r"[1-9][0-9]*", item.generation)
            or type(item.size) is not int or item.size < 0
            or not re.fullmatch(r"[A-Za-z0-9+/]{6}==", item.crc32c)):
        raise ValueError("Invalid object metadata")


def snapshot(store, source, destination, snapshot_id, *, apply=False,
             max_objects=1000, max_bytes=20 * 1024**3):
    if (not source or not destination or source == destination
            or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", snapshot_id)
            or type(max_objects) is not int or max_objects <= 0
            or type(max_bytes) is not int or max_bytes <= 0):
        raise ValueError("Invalid snapshot configuration")
    # Exhaust and validate the bounded inventory before the first write.
    items = []
    size = 0
    names = set()
    for item in store.inventory(source):
        validate(item)
        if item.name in names:
            raise ValueError("Duplicate source object")
        names.add(item.name)
        items.append(item)
        size += item.size
        if len(items) > max_objects or size > max_bytes:
            raise ValueError("Inventory exceeds authorized limits")
    entries = []
    for item in sorted(items, key=lambda value: value.name):
        digest = hashlib.sha256(item.name.encode("utf-8")).hexdigest()
        target = f"attachment-snapshots/{snapshot_id}/objects/{digest}/{item.generation}"
        entries.append({"source": item.name, "sourceGeneration": item.generation,
                        "size": item.size, "crc32c": item.crc32c, "destination": target})
    manifest = {"schema": 1, "sourceBucket": source, "destinationBucket": destination,
                "snapshotId": snapshot_id, "objects": entries}
    if not apply:
        return {"mode": "dry-run", "complete": False, "objects": len(items), "bytes": size}
    # Freeze this snapshot's intended inventory before copying. A changed inventory
    # cannot reuse an old snapshot id; an interrupted identical run can resume.
    base = f"attachment-snapshots/{snapshot_id}"
    store.create_json(destination, base + "/inventory.json", manifest)
    for entry in entries:
        current = store.metadata(destination, entry["destination"])
        if current is None:
            store.copy(source, entry["source"], entry["sourceGeneration"],
                       destination, entry["destination"])
            current = store.metadata(destination, entry["destination"])
        if (current is None or current.size != entry["size"]
                or current.crc32c != entry["crc32c"]):
            raise ValueError("Destination integrity mismatch; snapshot incomplete")
    # Completion marker is written only after every generation is verified.
    store.create_json(destination, base + "/complete.json", manifest)
    return {"mode": "apply", "complete": True, "objects": len(items), "bytes": size}


class GoogleStore:
    def __init__(self, project):
        from google.cloud import storage
        from google.api_core.exceptions import NotFound, PreconditionFailed
        self.client = storage.Client(project=project)
        self.not_found = NotFound
        self.conflict = PreconditionFailed

    def inventory(self, bucket):
        for blob in self.client.list_blobs(bucket):
            yield Object(blob.name, str(blob.generation), int(blob.size), blob.crc32c)

    def metadata(self, bucket, name):
        blob = self.client.bucket(bucket).get_blob(name)
        return None if blob is None else Object(name, str(blob.generation), int(blob.size), blob.crc32c)

    def copy(self, source, name, generation, destination, target):
        origin = self.client.bucket(source).blob(name, generation=int(generation))
        result = self.client.bucket(destination).blob(target)
        token = None
        while True:
            try:
                token, _, _ = result.rewrite(origin, token=token,
                    if_source_generation_match=int(generation), if_generation_match=0)
            except self.conflict:
                # Another identical executor may have completed the same target.
                # Caller must verify its size/CRC before considering it successful.
                if self.metadata(destination, target) is None:
                    raise
                return
            if token is None:
                return

    def create_json(self, bucket, name, content):
        text = json.dumps(content, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        blob = self.client.bucket(bucket).blob(name)
        try:
            blob.upload_from_string(text, content_type="application/json", if_generation_match=0)
        except self.conflict:
            # Pin the observed generation so concurrent replacement is not ignored.
            observed = self.client.bucket(bucket).get_blob(name)
            if observed is None or observed.download_as_text(
                    if_generation_match=observed.generation) != text:
                raise ValueError("Snapshot id already has a different manifest")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True)
    parser.add_argument("--source", required=True)
    parser.add_argument("--destination", required=True)
    parser.add_argument("--snapshot-id", required=True)
    parser.add_argument("--max-objects", type=int, default=1000)
    parser.add_argument("--max-bytes", type=int, default=20 * 1024**3)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    result = snapshot(GoogleStore(args.project), args.source, args.destination,
                      args.snapshot_id, apply=args.apply,
                      max_objects=args.max_objects, max_bytes=args.max_bytes)
    print(json.dumps(result))  # No object names, credentials or private URIs in stdout.


if __name__ == "__main__":
    main()
