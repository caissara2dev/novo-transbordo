import copy
import unittest
from snapshot import Object, snapshot


class Store:
    def __init__(self):
        self.sources = [Object("private/note.jpg", "11", 7, "AAAAAA==")]
        self.objects = {}
        self.manifests = {}
        self.writes = []
        self.corrupt = False
        self.fail_copy = False

    def inventory(self, bucket):
        return iter(self.sources)

    def metadata(self, bucket, name):
        return self.objects.get(name)

    def copy(self, source, name, generation, destination, target):
        if self.fail_copy:
            raise RuntimeError("Source generation no longer available")
        item = next(x for x in self.sources if x.name == name and x.generation == generation)
        self.objects[target] = Object(target, "99", item.size, "BBBBBB==" if self.corrupt else item.crc32c)
        self.writes.append(target)

    def create_json(self, bucket, name, content):
        if name in self.manifests and self.manifests[name] != content:
            raise ValueError("Snapshot id already has a different manifest")
        self.manifests[name] = copy.deepcopy(content)


class Tests(unittest.TestCase):
    def setUp(self):
        self.store = Store()

    def run_snapshot(self, **kwargs):
        return snapshot(self.store, "source", "backup", "fixture-001", **kwargs)

    def test_default_only_reads_inventory(self):
        result = self.run_snapshot()
        self.assertEqual(result, {"mode": "dry-run", "complete": False, "objects": 1, "bytes": 7})
        self.assertFalse(self.store.writes or self.store.manifests)

    def test_identical_snapshot_is_idempotent(self):
        first = self.run_snapshot(apply=True)
        self.assertEqual(first, self.run_snapshot(apply=True))
        self.assertEqual(len(self.store.writes), 1)
        self.assertTrue(any(key.endswith("/complete.json") for key in self.store.manifests))
        self.assertEqual(self.store.sources[0].generation, "11")

    def test_changed_source_requires_new_snapshot_id(self):
        self.run_snapshot(apply=True)
        self.store.sources[0] = Object("private/note.jpg", "12", 7, "BBBBBB==")
        with self.assertRaisesRegex(ValueError, "different manifest"):
            self.run_snapshot(apply=True)
        self.assertEqual(len(self.store.writes), 1)

    def test_corrupt_target_never_marks_complete(self):
        self.store.corrupt = True
        with self.assertRaisesRegex(ValueError, "integrity"):
            self.run_snapshot(apply=True)
        self.assertFalse(any(key.endswith("/complete.json") for key in self.store.manifests))

    def test_missing_generation_never_marks_complete(self):
        self.store.fail_copy = True
        with self.assertRaises(RuntimeError):
            self.run_snapshot(apply=True)
        self.assertFalse(any(key.endswith("/complete.json") for key in self.store.manifests))

    def test_object_and_byte_limits_fail_before_writes(self):
        for options in [{"max_bytes": 6}, {"max_objects": 1}]:
            self.store.sources.append(Object("private/second.pdf", "12", 8, "CCCCCC=="))
            with self.assertRaisesRegex(ValueError, "limits"):
                self.run_snapshot(apply=True, **options)
            self.assertFalse(self.store.writes or self.store.manifests)

    def test_invalid_metadata_and_duplicates_fail_before_writes(self):
        for invalid in [Object("bad", "0", 1, "AAAAAA=="),
                        Object("bad", "10", -1, "AAAAAA=="),
                        Object("bad", "10", 1, "bad-checksum"), self.store.sources[0]]:
            with self.subTest(invalid=invalid):
                self.store.sources = [Object("private/note.jpg", "11", 7, "AAAAAA=="), invalid]
                with self.assertRaises(ValueError):
                    self.run_snapshot(apply=True)
                self.assertFalse(self.store.writes or self.store.manifests)

    def test_same_bucket_and_invalid_limits_or_ids_rejected(self):
        for source, dest, key, options in [("same", "same", "id", {}),
                                         ("source", "backup", "../escape", {}),
                                         ("source", "backup", "id", {"max_objects": 0})]:
            with self.assertRaises(ValueError):
                snapshot(self.store, source, dest, key, apply=True, **options)


if __name__ == "__main__":
    unittest.main()
