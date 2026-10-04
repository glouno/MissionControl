import importlib.machinery
import importlib.util
import json
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path

loader = importlib.machinery.SourceFileLoader('status_cli', str(Path(__file__).with_name('missioncontrol')))
spec = importlib.util.spec_from_loader(loader.name, loader)
status = importlib.util.module_from_spec(spec)
loader.exec_module(status)


class StatusTests(unittest.TestCase):
    def test_v1_lease_expiry_and_read_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / 'mission-control.db'
            with sqlite3.connect(p) as db:
                db.executescript('''CREATE TABLE control_goals(id,status,config,created_at);
                CREATE TABLE control_tasks(id,goal_id,key,status,worker_id,lease_until,created_at);
                CREATE TABLE control_workers(id,last_seen);''')
                db.execute('INSERT INTO control_goals VALUES(?,?,?,?)', ('g','running',json.dumps({'title':'Example'}),'2026'))
                db.execute('INSERT INTO control_tasks VALUES(?,?,?,?,?,?,?)', ('t','g','work','claimed','w',int(time.time()*1000)-1000,'2026'))
                db.execute('INSERT INTO control_workers VALUES(?,?)', ('w',0))
            before = p.read_bytes()
            d = status.inspect_database(p)
            self.assertEqual(d['version'], 'v1')
            self.assertFalse(d['tasks'][0]['lease_valid'])
            self.assertEqual(d['workers_fresh'], 0)
            self.assertEqual(before, p.read_bytes())
            with sqlite3.connect(p) as db:
                db.execute('UPDATE control_tasks SET lease_until=?', (int(time.time()*1000)+120000,))
            self.assertTrue(status.inspect_database(p)['tasks'][0]['lease_valid'])

    def test_missing_database_is_not_created(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / 'missing.db'
            self.assertIn('error',status.inspect_database(p))
            self.assertFalse(p.exists())

    def test_legacy_running_is_unverified(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / 'mission-control.db'
            with sqlite3.connect(p) as db:
                db.executescript('CREATE TABLE missions(id,status,objective,created_at); CREATE TABLE tasks(id,mission_id,title,status);')
                db.execute("INSERT INTO missions VALUES('m','running','Example','2026')")
                db.execute("INSERT INTO tasks VALUES('t','m','Build','running')")
            d = status.inspect_database(p)
            self.assertEqual(d['version'],'legacy')
            self.assertNotIn('lease_valid',d['tasks'][0])

    def test_terminal_escape_removed(self):
        self.assertNotIn('\x1b',status.text('\x1b[2Junsafe'))

    def test_unrecognized_schema_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / 'mission-control.db'
            with sqlite3.connect(p) as db:
                db.execute('CREATE TABLE unrelated(id)')
            self.assertIn('error',status.inspect_database(p))


if __name__ == '__main__':
    unittest.main()
