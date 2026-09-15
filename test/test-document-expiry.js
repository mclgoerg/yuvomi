/**
 * Modul: Dokument-Ablauf + Erinnerungs-Sync (Proposal 7, Package A)
 * Zweck: expires_at/expiry_reminder_days auf family_documents - Validierung
 *        (inkl. eines erhaltenen expliziten 0), die Erinnerung, die bei jedem
 *        Schreiben neu berechnet wird (server/routes/inventory/items.js#syncReminder
 *        ist das Vorbild), und ihr Abbau auf jedem Weg, der ein Dokument aus dem
 *        aktiven Bestand nimmt: Loeschen, Ordner-Baum-Loeschen, Archivieren.
 * Ausführen: npm run test:document-expiry
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'document-expiry-test-secret';

const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { default: documentsRouter } = await import('../server/routes/documents.js');

const moduleDatabase = get();
const suiteDatabase = buildMigratedDatabase(MIGRATIONS);
_setTestDatabase(suiteDatabase);
moduleDatabase.close();

test.after(() => suiteDatabase.close());

function applyMigration(db, migration) {
  if (typeof migration.up === 'function') migration.up(db);
  else db.exec(migration.up);
  if (typeof migration.afterUp === 'function') migration.afterUp(db);
  db.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)')
    .run(migration.version, migration.description);
}

function buildMigratedDatabase(migrations) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )
  `);
  for (const migration of migrations) applyMigration(db, migration);
  return db;
}

function seedUser(role = 'member') {
  return get().prepare(`
    INSERT INTO users (username, display_name, password_hash, role)
    VALUES (?, ?, 'hash', ?)
  `).run(`doc-expiry-${role}-${randomUUID()}`, `Doc Expiry ${role}`, role).lastInsertRowid;
}

const OWNER = seedUser('member');
const ADMIN = seedUser('admin');

function createHarness({ userId = OWNER, role = 'member' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.authUserId = userId;
    req.authRole = role;
    req.session = { userId, role };
    next();
  });
  app.use('/api/v1/documents', documentsRouter);
  const server = http.createServer(app);
  return {
    async call(method, pathname, body) {
      if (!server.listening) {
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      }
      const base = `http://127.0.0.1:${server.address().port}/api/v1/documents`;
      const res = await fetch(`${base}${pathname}`, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    },
    close() {
      return new Promise((resolve) => (server.listening ? server.close(resolve) : resolve()));
    },
  };
}

function dateKey(date) {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

function daysFromToday(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return dateKey(d);
}

const PDF_DATA_URL = `data:application/pdf;base64,${Buffer.from('%PDF-1.4 test').toString('base64')}`;

function uploadPayload(overrides = {}) {
  return {
    name: 'Reisepass',
    original_name: 'passport.pdf',
    content_data: PDF_DATA_URL,
    category: 'identity',
    visibility: 'family',
    ...overrides,
  };
}

function reminderRows(entityId) {
  return get().prepare(`
    SELECT * FROM reminders WHERE entity_type = 'document_expiry' AND entity_id = ?
  `).all(entityId);
}

// --------------------------------------------------------
// Validierung
// --------------------------------------------------------

test('POST /documents akzeptiert ein explizites 0 als Erinnerungs-Vorlauf', async () => {
  const h = createHarness();
  try {
    const res = await h.call('POST', '', uploadPayload({
      expires_at: daysFromToday(30),
      expiry_reminder_days: 0,
    }));
    assert.equal(res.status, 201);
    assert.equal(res.body.data.expiry_reminder_days, 0, '0 darf nicht auf den Default zurueckfallen');
  } finally {
    await h.close();
  }
});

test('POST /documents lehnt einen Vorlauf ausserhalb von 0-365 ab', async () => {
  const h = createHarness();
  try {
    const tooHigh = await h.call('POST', '', uploadPayload({
      expires_at: daysFromToday(30),
      expiry_reminder_days: 366,
    }));
    assert.equal(tooHigh.status, 400);

    const negative = await h.call('POST', '', uploadPayload({
      expires_at: daysFromToday(30),
      expiry_reminder_days: -1,
    }));
    assert.equal(negative.status, 400);
  } finally {
    await h.close();
  }
});

test('POST /documents lehnt ein falsch formatiertes Ablaufdatum ab', async () => {
  const h = createHarness();
  try {
    const res = await h.call('POST', '', uploadPayload({ expires_at: '30.09.2026' }));
    assert.equal(res.status, 400);
  } finally {
    await h.close();
  }
});

test('GET /documents gibt expires_at und expiry_reminder_days zurueck', async () => {
  const h = createHarness();
  try {
    const created = await h.call('POST', '', uploadPayload({
      expires_at: daysFromToday(45),
      expiry_reminder_days: 10,
    }));
    assert.equal(created.status, 201);
    const list = await h.call('GET', '?status=active');
    const row = list.body.data.find((d) => d.id === created.body.data.id);
    assert.equal(row.expires_at, daysFromToday(45));
    assert.equal(row.expiry_reminder_days, 10);
  } finally {
    await h.close();
  }
});

// --------------------------------------------------------
// Erinnerungs-Sync bei jedem Schreiben
// --------------------------------------------------------

test('POST /documents legt eine document_expiry-Erinnerung an, Besitzer ist created_by', async () => {
  const h = createHarness();
  try {
    const created = await h.call('POST', '', uploadPayload({
      expires_at: daysFromToday(30),
      expiry_reminder_days: 5,
    }));
    assert.equal(created.status, 201);
    const rows = reminderRows(created.body.data.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].remind_at, `${daysFromToday(25)}T09:00`);
    assert.equal(rows[0].created_by, OWNER);
  } finally {
    await h.close();
  }
});

test('kein Ablaufdatum oder kein Vorlauf legt keine Erinnerung an', async () => {
  const h = createHarness();
  try {
    const noExpiry = await h.call('POST', '', uploadPayload({}));
    assert.equal(reminderRows(noExpiry.body.data.id).length, 0);

    const noLead = await h.call('POST', '', uploadPayload({ expires_at: daysFromToday(30) }));
    assert.equal(reminderRows(noLead.body.data.id).length, 0);
  } finally {
    await h.close();
  }
});

test('ein bereits vergangener Erinnerungstermin wird nicht angelegt', async () => {
  const h = createHarness();
  try {
    // Ablauf gestern, kein Vorlauf: remind_at liegt in der Vergangenheit.
    const created = await h.call('POST', '', uploadPayload({
      expires_at: daysFromToday(-1),
      expiry_reminder_days: 0,
    }));
    assert.equal(created.status, 201);
    assert.equal(reminderRows(created.body.data.id).length, 0);
  } finally {
    await h.close();
  }
});

test('PUT /documents/:id verschiebt die Erinnerung, wenn sich das Ablaufdatum aendert', async () => {
  const h = createHarness();
  try {
    const created = await h.call('POST', '', uploadPayload({
      expires_at: daysFromToday(30),
      expiry_reminder_days: 5,
    }));
    const id = created.body.data.id;
    assert.equal(reminderRows(id)[0].remind_at, `${daysFromToday(25)}T09:00`);

    await h.call('PUT', `/${id}`, { expires_at: daysFromToday(60), expiry_reminder_days: 5 });
    const rows = reminderRows(id);
    assert.equal(rows.length, 1, 'die alte Zeile darf nicht liegen bleiben');
    assert.equal(rows[0].remind_at, `${daysFromToday(55)}T09:00`);
  } finally {
    await h.close();
  }
});

test('PUT /documents/:id raeumt die Erinnerung ab, wenn das Ablaufdatum entfernt wird', async () => {
  const h = createHarness();
  try {
    const created = await h.call('POST', '', uploadPayload({
      expires_at: daysFromToday(30),
      expiry_reminder_days: 5,
    }));
    const id = created.body.data.id;
    assert.equal(reminderRows(id).length, 1);

    await h.call('PUT', `/${id}`, { expires_at: null });
    assert.equal(reminderRows(id).length, 0);
  } finally {
    await h.close();
  }
});

// --------------------------------------------------------
// Abbau, wo ein Dokument den aktiven Bestand verlaesst
// --------------------------------------------------------

test('DELETE /documents/:id raeumt die Erinnerung ab', async () => {
  const h = createHarness();
  try {
    const created = await h.call('POST', '', uploadPayload({
      expires_at: daysFromToday(30),
      expiry_reminder_days: 5,
    }));
    const id = created.body.data.id;
    assert.equal(reminderRows(id).length, 1);

    const del = await h.call('DELETE', `/${id}`);
    assert.equal(del.status, 204);
    assert.equal(reminderRows(id).length, 0);
  } finally {
    await h.close();
  }
});

test('PATCH /documents/:id/archive raeumt die Erinnerung ab - ein archiviertes Dokument darf nicht nagen', async () => {
  const h = createHarness();
  try {
    const created = await h.call('POST', '', uploadPayload({
      expires_at: daysFromToday(30),
      expiry_reminder_days: 5,
    }));
    const id = created.body.data.id;
    assert.equal(reminderRows(id).length, 1);

    const archived = await h.call('PATCH', `/${id}/archive`, {});
    assert.equal(archived.status, 200);
    assert.equal(reminderRows(id).length, 0);

    // Reaktivieren stellt sie wieder her, solange der Ablauf noch in der Zukunft liegt.
    const restored = await h.call('PATCH', `/${id}/archive`, { archived: false });
    assert.equal(restored.status, 200);
    assert.equal(reminderRows(id).length, 1);
  } finally {
    await h.close();
  }
});

test('PUT /documents/:id mit status=archived raeumt die Erinnerung ebenso ab', async () => {
  const h = createHarness();
  try {
    const created = await h.call('POST', '', uploadPayload({
      expires_at: daysFromToday(30),
      expiry_reminder_days: 5,
    }));
    const id = created.body.data.id;
    assert.equal(reminderRows(id).length, 1);

    await h.call('PUT', `/${id}`, { status: 'archived' });
    assert.equal(reminderRows(id).length, 0);
  } finally {
    await h.close();
  }
});

test('DELETE /folders/:id?documents=delete raeumt die Erinnerungen des ganzen Zweigs ab', async () => {
  const h = createHarness();
  try {
    const folder = await h.call('POST', '/folders', { name: `Zweig-${randomUUID()}` });
    const folderId = folder.body.data.id;
    const created = await h.call('POST', '', uploadPayload({
      expires_at: daysFromToday(30),
      expiry_reminder_days: 5,
      folder_id: folderId,
    }));
    const id = created.body.data.id;
    assert.equal(reminderRows(id).length, 1);

    const impact = await h.call('GET', `/folders/${folderId}/delete-impact`);
    const del = await h.call(
      'DELETE',
      `/folders/${folderId}?documents=delete&expected_snapshot=${impact.body.data.snapshot}`,
    );
    assert.equal(del.status, 200);
    assert.equal(reminderRows(id).length, 0);
  } finally {
    await h.close();
  }
});

test('die Erinnerung gehoert created_by, nicht der bearbeitenden Person (Admin)', async () => {
  const owner = createHarness({ userId: OWNER, role: 'member' });
  const admin = createHarness({ userId: ADMIN, role: 'admin' });
  try {
    const created = await owner.call('POST', '', uploadPayload({
      expires_at: daysFromToday(30),
      expiry_reminder_days: 5,
    }));
    const id = created.body.data.id;
    assert.equal(reminderRows(id)[0].created_by, OWNER);

    // Ein Admin darf das fremde Dokument bearbeiten (#989) - die Erinnerung
    // bleibt trotzdem bei der Person, die das Dokument angelegt hat.
    const edited = await admin.call('PUT', `/${id}`, { expires_at: daysFromToday(90), expiry_reminder_days: 3 });
    assert.equal(edited.status, 200);
    const rows = reminderRows(id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].created_by, OWNER);
  } finally {
    await owner.close();
    await admin.close();
  }
});

// --------------------------------------------------------
// ?expiring=<days>-Filter
// --------------------------------------------------------

test('GET /documents?expiring=<days> zeigt nur bald ablaufende/ueberfaellige Dokumente', async () => {
  const h = createHarness();
  try {
    const soon = await h.call('POST', '', uploadPayload({ name: 'Bald faellig', expires_at: daysFromToday(5) }));
    const later = await h.call('POST', '', uploadPayload({ name: 'Weit weg', expires_at: daysFromToday(200) }));
    const none = await h.call('POST', '', uploadPayload({ name: 'Ohne Ablauf' }));

    const res = await h.call('GET', '?expiring=10');
    const ids = res.body.data.map((d) => d.id);
    assert.ok(ids.includes(soon.body.data.id));
    assert.ok(!ids.includes(later.body.data.id));
    assert.ok(!ids.includes(none.body.data.id));
  } finally {
    await h.close();
  }
});
