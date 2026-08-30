/** Schedule API: patterns are computed into entries, never calendar events. */
import express from 'express';
import * as db from '../db.js';
import { bool, color, collectErrors, date, id, num, str, time } from '../middleware/validate.js';
import { createLogger } from '../logger.js';
import { resolveEntries, dateKeysInRange } from '../services/schedule.js';
import { daysBetweenDateKeys } from '../utils/timezone.js';

const router = express.Router();
const log = createLogger('Schedule');
const actorId = (req) => req.authUserId || req.session?.userId;
const isAdmin = (req) => req.authRole === 'admin' || req.session?.role === 'admin';
const fail = (res, code, error) => res.status(code).json({ error, code });
const userExists = (value) => !!db.get().prepare('SELECT 1 FROM users WHERE id = ?').get(value);
const typeExists = (value) => !!db.get().prepare('SELECT 1 FROM schedule_shift_types WHERE id = ?').get(value);
const mineOrAdmin = (req, userId) => isAdmin(req) || actorId(req) === userId;

/** Lucides laengster Name liegt bei 34 Zeichen; 48 laesst Luft nach oben - dieselbe Grenze wie bei den Schnellzugriffen (quick-links.js). */
const MAX_ICON_NAME_LENGTH = 48;
const ICON_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Wie iconName() in quick-links.js: der Name ist zur Laufzeit gewaehlt, geprueft wird nur die Form, nicht gegen Lucides Vorrat - das Vorrat-Modul (utils/lucide-icons.js) liegt auf `window.lucide` und ist serverseitig nicht erreichbar. */
function shiftIcon(value) {
  if (value === undefined || value === null || value === '') return { value: null, error: null };
  if (typeof value !== 'string') return { value: null, error: 'icon must be a string.' };
  const trimmed = value.trim();
  if (!trimmed) return { value: null, error: null };
  if (trimmed.length > MAX_ICON_NAME_LENGTH) return { value: null, error: 'icon is too long.' };
  if (!ICON_NAME_RE.test(trimmed)) return { value: null, error: 'icon must contain only lowercase letters, digits, and hyphens.' };
  return { value: trimmed, error: null };
}

/**
 * Ein Schichttyp gehoert dem Haushalt, nicht einer Person: er taucht in den
 * Mustern aller Mitglieder auf. Anlegen darf ihn deshalb jeder - das nimmt
 * niemandem etwas weg -, aendern und loeschen nur, wer ihn angelegt hat, oder
 * ein Admin. Sonst benennt ein Mitglied die Fruehschicht der ganzen Familie um.
 *
 * `created_by` ist `ON DELETE SET NULL`: ein Typ, dessen Ersteller nicht mehr
 * da ist, wird verwaist und liegt damit bei den Admins - nicht bei allen.
 */
const ownTypeOrAdmin = (req, type) => isAdmin(req) || (type.created_by != null && type.created_by === actorId(req));

/**
 * Hat SQLite das Loeschen wegen einer bestehenden Referenz abgelehnt?
 *
 * Steht als benannte Funktion hier und nicht als Ausdruck im Handler, damit ein
 * Test sie direkt befragen kann: der Handler antwortete vorher auf JEDEN Fehler
 * mit "noch in Benutzung", und ein Test auf den Statuscode allein bleibt dabei
 * gruen - er misst das Ergebnis, nicht den Grund.
 *
 * Gemessen und nicht geraten: ein abgelehntes `ON DELETE RESTRICT` kommt als
 * `SQLITE_CONSTRAINT_TRIGGER` an, NICHT als `_FOREIGNKEY` - die Meldung lautet
 * "FOREIGN KEY constraint failed", der Code sagt etwas anderes. Deshalb das
 * Praefix ueber alle Constraint-Varianten; ein DELETE kann ohnehin keinen
 * UNIQUE- oder CHECK-Verstoss ausloesen.
 */
export function isStillReferenced(err) {
  return String(err?.code || '').startsWith('SQLITE_CONSTRAINT');
}
const typeColumns = 'id, name, short_code, start_time, end_time, color, icon, created_by, created_at, updated_at';

// Der Zeitraum von `/entries` muss eine Obergrenze haben: `dateKeysInRange()`
// baut EINEN String je Tag, und `resolveEntries()` laeuft ihn je Haushaltsmitglied
// durch. `from=1000-01-01&to=9999-12-31` sind rund 3,3 Millionen Tage - synchron,
// je Mitglied, bei jedem Aufruf. Ein angemeldetes Mitglied oder ein Token mit
// `schedule:read` koennte den Server damit anhalten.
//
// Zwei Jahre und ein Tag: die Statistik-Ansicht bietet hoechstens ein Jahr an,
// und ein Jahreswechsel-Zeitraum ueber zwei Kalenderjahre bleibt darin bequem.
// Wie MAX_ITER in calendar-events.js begrenzt das die ARBEIT und nicht die
// Gueltigkeit der Eingabe - deshalb 400 mit Begruendung statt stiller Kuerzung.
const MAX_RANGE_DAYS = 731;

// `/overrides/fill` schreibt echte Zeilen, `/entries` liest nur - MAX_RANGE_DAYS
// gehoert deshalb nicht hierher, so verlockend die Wiederverwendung waere. Die
// Modul-Idee (SPEC.md, "Schedule") ist ausdruecklich "computed on read, never
// materialised" - ein Zwei-Jahre-Fuellen wuerde Overrides zu einem zweiten Weg
// machen, ein Muster zu bauen, nur ohne dessen Zyklus-Arithmetik. Die Grenze
// ist deshalb eigens gesetzt, nicht geerbt: gross genug fuer eine Abwesenheit
// (Urlaub, Elternzeit, eine Vertretung ueber ein Quartal), klein genug, dass
// sie keine Schatten-Rotation traegt.
const MAX_FILL_DAYS = 100;

// Exportiert fuer server/services/schedule-ics.js: derselbe Ausloese-Weg
// (Muster + Ausnahmen zum Lesezeitpunkt aufgeloest, Schichttyp eingebettet)
// statt einer zweiten Fassung, die bei der naechsten Aenderung hier
// auseinanderlaeuft.
export function scheduleData(from, to, userId) {
  const database = db.get();
  const condition = userId ? 'AND user_id = ?' : '';
  const patterns = database.prepare(`SELECT * FROM schedule_patterns WHERE is_active = 1
    AND (valid_from IS NULL OR valid_from <= ?) AND (valid_until IS NULL OR valid_until >= ?) ${condition}
    ORDER BY user_id, valid_from DESC, id DESC`).all(...(userId ? [to, from, userId] : [to, from]));
  // Ein Zyklustag kann mehrere Zeilen tragen (Stundenplan, mehrere Klassen am
  // selben Tag) - deshalb ein Array je Schluessel, nicht die letzte Zeile
  // gewinnt wie frueher.
  const patternDays = new Map();
  if (patterns.length) {
    const ids = patterns.map((p) => p.id);
    for (const row of database.prepare(`SELECT * FROM schedule_pattern_days WHERE pattern_id IN (${ids.map(() => '?').join(',')})`).all(...ids)) {
      const key = `${row.pattern_id}:${row.position}`;
      if (patternDays.has(key)) patternDays.get(key).push(row);
      else patternDays.set(key, [row]);
    }
  }
  const users = userId ? [userId] : database.prepare('SELECT id FROM users ORDER BY id').all().map((row) => row.id);
  const entries = []; const warnings = [];
  for (const memberId of users) {
    const overrides = database.prepare('SELECT * FROM schedule_overrides WHERE user_id = ? AND date_key BETWEEN ? AND ?').all(memberId, from, to);
    const resolved = resolveEntries({ from, to, userId: memberId, patterns: patterns.filter((p) => p.user_id === memberId), patternDays, overrides });
    entries.push(...resolved.entries); warnings.push(...resolved.warnings);
    // Additiv zum Ergebnis von resolveEntries(), nie ein Ersatz dafuer: ein
    // Extra (Bereitschaft neben einer regulaeren Schicht) zaehlt unabhaengig
    // davon, ob der Tag ueberhaupt eine primaere Schicht hat. Deshalb kein
    // Umweg ueber resolveEntries()'s Tag-fuer-Tag-Schleife - eine
    // schedule_extra_shifts-Zeile ist schon eine fertige Tatsache fuer genau
    // dieses Datum, es gibt nichts an ihr aufzuloesen.
    const extras = database.prepare('SELECT * FROM schedule_extra_shifts WHERE user_id = ? AND date_key BETWEEN ? AND ?').all(memberId, from, to);
    for (const row of extras) {
      entries.push({ user_id: memberId, date_key: row.date_key, source: 'extra', extra_id: row.id,
        shift_type_id: row.shift_type_id, note: row.note ?? null, reminder_offset_minutes: row.reminder_offset_minutes, is_free: false });
    }
  }
  const typeIds = [...new Set(entries.map((entry) => entry.shift_type_id).filter(Boolean))];
  const types = new Map();
  if (typeIds.length) for (const row of database.prepare(`SELECT ${typeColumns} FROM schedule_shift_types WHERE id IN (${typeIds.map(() => '?').join(',')})`).all(...typeIds)) types.set(row.id, row);
  return { entries: entries.map((entry) => ({ ...entry, shift_type: entry.shift_type_id ? types.get(entry.shift_type_id) || null : null, crosses_midnight: Boolean(types.get(entry.shift_type_id)?.start_time && types.get(entry.shift_type_id)?.end_time && types.get(entry.shift_type_id).end_time <= types.get(entry.shift_type_id).start_time) })), warnings };
}

router.get('/entries', (req, res) => {
  const from = date(req.query.from, 'from', true); const to = date(req.query.to, 'to', true);
  const requested = req.query.user_id == null ? null : id(req.query.user_id, 'user_id');
  const errors = collectErrors([from, to, requested].filter(Boolean));
  if (errors.length || (from.value && to.value && from.value > to.value)) return fail(res, 400, errors.join(' ') || 'from must be before to.');
  const span = daysBetweenDateKeys(from.value, to.value);
  if (span === null || span + 1 > MAX_RANGE_DAYS) {
    return fail(res, 400, `The range must not exceed ${MAX_RANGE_DAYS} days.`);
  }
  if (requested && !userExists(requested.value)) return fail(res, 404, 'User not found.');
  try { res.json({ data: scheduleData(from.value, to.value, requested?.value ?? null) }); }
  catch (err) {
    log.error('Error resolving schedule entries:', err.message);
    return fail(res, 500, 'Schedule entries could not be resolved.');
  }
});

router.get('/shift-types', (_req, res) => res.json({ data: db.get().prepare(`SELECT ${typeColumns} FROM schedule_shift_types ORDER BY name COLLATE NOCASE`).all() }));
router.post('/shift-types', (req, res) => {
  const name = str(req.body?.name, 'name'); const shortCode = str(req.body?.short_code, 'short_code', { required: false, max: 12 });
  const start = time(req.body?.start_time, 'start_time'); const end = time(req.body?.end_time, 'end_time'); const shade = color(req.body?.color || '#6C3AED', 'color');
  const icon = shiftIcon(req.body?.icon);
  const errors = collectErrors([name, shortCode, start, end, shade, icon]);
  if ((start.value == null) !== (end.value == null)) errors.push('start_time and end_time must be provided together.');
  if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });
  const result = db.get().prepare('INSERT INTO schedule_shift_types (name, short_code, start_time, end_time, color, icon, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)').run(name.value, shortCode.value, start.value, end.value, shade.value, icon.value, actorId(req));
  res.status(201).json({ data: db.get().prepare(`SELECT ${typeColumns} FROM schedule_shift_types WHERE id = ?`).get(result.lastInsertRowid) });
});
router.delete('/shift-types/:id', (req, res) => {
  const shiftType = id(req.params.id, 'id');
  if (shiftType.error) return fail(res, 400, shiftType.error);
  const existing = db.get().prepare('SELECT id, created_by FROM schedule_shift_types WHERE id = ?').get(shiftType.value);
  if (!existing) return fail(res, 404, 'Shift type not found.');
  if (!ownTypeOrAdmin(req, existing)) return fail(res, 403, 'Forbidden.');
  try {
    db.get().prepare('DELETE FROM schedule_shift_types WHERE id = ?').run(existing.id);
    return res.status(204).end();
  } catch (err) {
    // Nur der Fremdschluessel wird als "in Benutzung" gedeutet. Vorher fing der
    // Zweig JEDEN Fehler und nannte denselben Grund - ein Schreibfehler im SQL
    // haette dem Aufrufer erzaehlt, der Typ sei noch im Einsatz.
    if (isStillReferenced(err)) return fail(res, 409, 'Shift type is in use.');
    log.error('Error deleting shift type:', err.message);
    return fail(res, 500, 'Internal error.');
  }
});

router.get('/patterns', (req, res) => {
  const requested = req.query.user_id == null ? null : id(req.query.user_id, 'user_id');
  if (requested?.error) return fail(res, 400, requested.error);
  if (requested && !userExists(requested.value)) return fail(res, 404, 'User not found.');
  const rows = requested ? db.get().prepare('SELECT * FROM schedule_patterns WHERE user_id = ? ORDER BY valid_from DESC, id DESC').all(requested.value) : db.get().prepare('SELECT * FROM schedule_patterns ORDER BY user_id, valid_from DESC, id DESC').all();
  res.json({ data: rows });
});
router.post('/patterns', (req, res) => {
  const user = id(req.body?.user_id ?? actorId(req), 'user_id'); const name = str(req.body?.name, 'name'); const anchor = date(req.body?.anchor_date, 'anchor_date', true);
  const length = num(req.body?.cycle_length, 'cycle_length', { required: true }); const from = date(req.body?.valid_from, 'valid_from'); const until = date(req.body?.valid_until, 'valid_until');
  const active = req.body?.is_active === undefined ? { value: true, error: null } : bool(req.body.is_active, 'is_active');
  const errors = collectErrors([user, name, anchor, length, from, until, active]); if (!Number.isInteger(length.value) || length.value < 1 || length.value > 366) errors.push('cycle_length must be between 1 and 366.'); if (user.value && !userExists(user.value)) errors.push('user_id does not exist.');
  if (!mineOrAdmin(req, user.value)) errors.push('Forbidden.'); if (from.value && until.value && from.value > until.value) errors.push('valid_from must be before valid_until.');
  if (errors.length) return res.status(errors.includes('Forbidden.') ? 403 : 400).json({ error: errors.join(' '), code: errors.includes('Forbidden.') ? 403 : 400 });
  const result = db.get().prepare('INSERT INTO schedule_patterns (user_id, name, anchor_date, cycle_length, valid_from, valid_until, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)').run(user.value, name.value, anchor.value, length.value, from.value, until.value, Number(active.value));
  res.status(201).json({ data: db.get().prepare('SELECT * FROM schedule_patterns WHERE id = ?').get(result.lastInsertRowid) });
});
router.put('/overrides/:dateKey', (req, res) => {
  const key = date(req.params.dateKey, 'date_key', true); const user = id(req.body?.user_id ?? actorId(req), 'user_id'); const typeId = req.body?.shift_type_id == null ? null : id(req.body.shift_type_id, 'shift_type_id'); const note = str(req.body?.note, 'note', { required: false, max: 5000 });
  const errors = collectErrors([key, user, typeId, note].filter(Boolean)); if (user.value && !userExists(user.value)) errors.push('user_id does not exist.'); if (typeId && !typeExists(typeId.value)) errors.push('shift_type_id does not exist.'); if (!mineOrAdmin(req, user.value)) errors.push('Forbidden.'); if (errors.length) return res.status(errors.includes('Forbidden.') ? 403 : 400).json({ error: errors.join(' '), code: errors.includes('Forbidden.') ? 403 : 400 });
  db.get().prepare('INSERT INTO schedule_overrides (user_id, date_key, shift_type_id, note) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, date_key) DO UPDATE SET shift_type_id = excluded.shift_type_id, note = excluded.note').run(user.value, key.value, typeId?.value ?? null, note.value);
  res.json({ data: db.get().prepare('SELECT * FROM schedule_overrides WHERE user_id = ? AND date_key = ?').get(user.value, key.value) });
});

router.put('/shift-types/:id', (req, res) => {
  const key = id(req.params.id, 'id'); if (key.error) return fail(res, 400, key.error);
  const old = db.get().prepare(`SELECT ${typeColumns} FROM schedule_shift_types WHERE id = ?`).get(key.value);
  if (!old) return fail(res, 404, 'Shift type not found.');
  if (!ownTypeOrAdmin(req, old)) return fail(res, 403, 'Forbidden.');
  const name = req.body?.name === undefined ? { value: old.name } : str(req.body.name, 'name');
  const shortCode = req.body?.short_code === undefined ? { value: old.short_code } : str(req.body.short_code, 'short_code', { required: false, max: 12 });
  const start = req.body?.start_time === undefined ? { value: old.start_time } : time(req.body.start_time, 'start_time');
  const end = req.body?.end_time === undefined ? { value: old.end_time } : time(req.body.end_time, 'end_time');
  // `color()` antwortet auf jeden falsy Wert mit {value: null, error: null}, und
  // die Spalte ist NOT NULL - ein `{"color": ""}` schriebe also NULL und flöge als
  // roher 500er zurueck. Der Ruecksetzer ist die bestehende Farbe und nicht der
  // Palettenerste: die Anfrage sagt "nicht anfassen", nicht "auf Anfang".
  const shade = req.body?.color === undefined || !req.body.color
    ? { value: old.color, error: null }
    : color(req.body.color, 'color');
  const icon = req.body?.icon === undefined ? { value: old.icon, error: null } : shiftIcon(req.body.icon);
  const errors = collectErrors([name, shortCode, start, end, shade, icon]);
  if ((start.value == null) !== (end.value == null)) errors.push('start_time and end_time must be provided together.');
  if (errors.length) return fail(res, 400, errors.join(' '));
  db.get().prepare('UPDATE schedule_shift_types SET name=?, short_code=?, start_time=?, end_time=?, color=?, icon=? WHERE id=?').run(name.value, shortCode.value, start.value, end.value, shade.value, icon.value, key.value);
  return res.json({ data: db.get().prepare(`SELECT ${typeColumns} FROM schedule_shift_types WHERE id = ?`).get(key.value) });
});
router.put('/patterns/:id', (req, res) => {
  const key = id(req.params.id, 'id'); if (key.error) return fail(res, 400, key.error);
  const old = db.get().prepare('SELECT * FROM schedule_patterns WHERE id=?').get(key.value);
  if (!old) return fail(res, 404, 'Pattern not found.'); if (!mineOrAdmin(req, old.user_id)) return fail(res, 403, 'Forbidden.');
  const name = req.body?.name === undefined ? { value: old.name } : str(req.body.name, 'name');
  const anchor = req.body?.anchor_date === undefined ? { value: old.anchor_date } : date(req.body.anchor_date, 'anchor_date', true);
  const length = req.body?.cycle_length === undefined ? { value: old.cycle_length } : num(req.body.cycle_length, 'cycle_length', { required: true });
  const from = req.body?.valid_from === undefined ? { value: old.valid_from } : date(req.body.valid_from, 'valid_from');
  const until = req.body?.valid_until === undefined ? { value: old.valid_until } : date(req.body.valid_until, 'valid_until');
  const active = req.body?.is_active === undefined ? { value: Boolean(old.is_active) } : bool(req.body.is_active, 'is_active');
  const errors = collectErrors([name, anchor, length, from, until, active]);
  if (!Number.isInteger(length.value) || length.value < 1 || length.value > 366) errors.push('cycle_length must be between 1 and 366.');
  if (from.value && until.value && from.value > until.value) errors.push('valid_from must be before valid_until.');
  if (db.get().prepare('SELECT 1 FROM schedule_pattern_days WHERE pattern_id=? AND position>=?').get(old.id, length.value)) errors.push('cycle_length cannot exclude existing pattern days.');
  if (errors.length) return fail(res, 400, errors.join(' '));
  db.get().prepare('UPDATE schedule_patterns SET name=?,anchor_date=?,cycle_length=?,valid_from=?,valid_until=?,is_active=? WHERE id=?').run(name.value, anchor.value, length.value, from.value, until.value, Number(active.value), old.id);
  return res.json({ data: db.get().prepare('SELECT * FROM schedule_patterns WHERE id=?').get(old.id) });
});
router.delete('/patterns/:id', (req, res) => {
  const key = id(req.params.id, 'id'); if (key.error) return fail(res, 400, key.error);
  const old = db.get().prepare('SELECT * FROM schedule_patterns WHERE id=?').get(key.value);
  if (!old) return fail(res, 404, 'Pattern not found.'); if (!mineOrAdmin(req, old.user_id)) return fail(res, 403, 'Forbidden.');
  db.get().prepare('DELETE FROM schedule_patterns WHERE id=?').run(old.id); return res.status(204).end();
});
router.get('/patterns/:id/days', (req, res) => {
  const key = id(req.params.id, 'id'); if (key.error) return fail(res, 400, key.error);
  if (!db.get().prepare('SELECT 1 FROM schedule_patterns WHERE id=?').get(key.value)) return fail(res, 404, 'Pattern not found.');
  return res.json({ data: db.get().prepare('SELECT * FROM schedule_pattern_days WHERE pattern_id=? ORDER BY position, id').all(key.value) });
});
// Ersetzt IMMER alle Zyklustage des Musters in einem Rutsch (loeschen, neu
// anlegen) statt einzelner Upserts - es gibt kein natuerliches Merkmal, an dem
// sich "unveraendert" von "geloescht" unterscheiden liesse (derselbe Grund wie
// server/routes/inventory/item-dates.js). Dieselbe Position darf jetzt
// MEHRFACH vorkommen - ein Zyklustag kann mehrere Klassen zu verschiedenen
// Zeiten tragen (Stundenplan) statt hoechstens einer. Das bedeutet: JEDES
// Speichern vergibt allen Zeilen des Musters frische Ids, auch unveraenderten -
// server/services/schedule-reminders.js's Anker-Sync und die ICS-UIDs
// (server/services/schedule-ics.js) sind bewusst so gebaut, dass sie das
// verkraften (Selbstheilung beim naechsten Sync-Lauf statt einer Kaskade).
router.put('/patterns/:id/days', (req, res) => {
  const key = id(req.params.id, 'id'); if (key.error) return fail(res, 400, key.error);
  const old = db.get().prepare('SELECT * FROM schedule_patterns WHERE id=?').get(key.value);
  if (!old) return fail(res, 404, 'Pattern not found.'); if (!mineOrAdmin(req, old.user_id)) return fail(res, 403, 'Forbidden.');
  if (!Array.isArray(req.body?.days)) return fail(res, 400, 'days must be an array.');
  const days = [];
  for (const row of req.body.days) {
    const position = num(row?.position, 'position', { required: true }); const shiftType = row?.shift_type_id == null ? null : id(row.shift_type_id, 'shift_type_id');
    if (position.error || !Number.isInteger(position.value) || position.value < 0 || position.value >= old.cycle_length || shiftType?.error) return fail(res, 400, 'Invalid pattern day.');
    if (shiftType && !typeExists(shiftType.value)) return fail(res, 400, 'shift_type_id does not exist.');
    days.push([position.value, shiftType?.value ?? null]);
  }
  db.get().transaction(() => { db.get().prepare('DELETE FROM schedule_pattern_days WHERE pattern_id=?').run(old.id); const add = db.get().prepare('INSERT INTO schedule_pattern_days (pattern_id,position,shift_type_id) VALUES (?,?,?)'); days.forEach((day) => add.run(old.id, ...day)); })();
  return res.json({ data: db.get().prepare('SELECT * FROM schedule_pattern_days WHERE pattern_id=? ORDER BY position').all(old.id) });
});
router.get('/overrides', (req, res) => {
  const user = req.query.user_id == null ? null : id(req.query.user_id, 'user_id'); const from = date(req.query.from, 'from'); const to = date(req.query.to, 'to');
  const errors = collectErrors([user, from, to].filter(Boolean)); if (from.value && to.value && from.value > to.value) errors.push('from must be before to.');
  if (errors.length) return fail(res, 400, errors.join(' ')); if (user && !userExists(user.value)) return fail(res, 404, 'User not found.');
  const where = []; const args = []; if (user) { where.push('user_id=?'); args.push(user.value); } if (from.value) { where.push('date_key>=?'); args.push(from.value); } if (to.value) { where.push('date_key<=?'); args.push(to.value); }
  return res.json({ data: db.get().prepare(`SELECT * FROM schedule_overrides${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY user_id,date_key`).all(...args) });
});
/**
 * Fuellt einen Zeitraum in einem Aufruf statt einem PUT je Tag - fuer eine
 * Abwesenheit (Urlaub, Vertretung), nicht als Ersatz fuer ein Muster (siehe
 * MAX_FILL_DAYS oben). `from`/`to` sind hier PFLICHT: ein unvollstaendiger
 * Bereich soll mit 400 scheitern, nicht mit `dateKeysInRange()`s stillem
 * leeren Array bei einem invertierten Bereich durchrutschen.
 */
router.post('/overrides/fill', (req, res) => {
  const user = id(req.body?.user_id ?? actorId(req), 'user_id');
  const from = date(req.body?.from, 'from', true);
  const to = date(req.body?.to, 'to', true);
  const typeId = req.body?.shift_type_id == null ? null : id(req.body.shift_type_id, 'shift_type_id');
  const note = str(req.body?.note, 'note', { required: false, max: 5000 });
  const errors = collectErrors([user, from, to, typeId, note].filter(Boolean));
  if (from.value && to.value && from.value > to.value) errors.push('from must be before to.');
  if (user.value && !userExists(user.value)) errors.push('user_id does not exist.');
  if (typeId && !typeExists(typeId.value)) errors.push('shift_type_id does not exist.');
  if (!mineOrAdmin(req, user.value)) errors.push('Forbidden.');
  if (errors.length) return res.status(errors.includes('Forbidden.') ? 403 : 400).json({ error: errors.join(' '), code: errors.includes('Forbidden.') ? 403 : 400 });
  const span = daysBetweenDateKeys(from.value, to.value);
  if (span === null || span + 1 > MAX_FILL_DAYS) {
    return fail(res, 400, `The range must not exceed ${MAX_FILL_DAYS} days.`);
  }
  const keys = dateKeysInRange(from.value, to.value);
  // `note = excluded.note` REPLACES an existing note on every day in the
  // range, including one the caller didn't type themselves - a fill sends one
  // note (or none) for the whole span, and a day inside it keeps whatever it
  // had otherwise. Deliberate: the client's confirm dialog already says
  // "replacing any existing entries in that range", and a fill is meant to
  // read as one action overwriting a span, not a merge that could leave a
  // stale note from before the range was last edited (PR #930 review).
  const upsert = db.get().prepare(`INSERT INTO schedule_overrides (user_id, date_key, shift_type_id, note)
    VALUES (?, ?, ?, ?) ON CONFLICT(user_id, date_key) DO UPDATE SET shift_type_id = excluded.shift_type_id, note = excluded.note`);
  db.get().transaction(() => { for (const key of keys) upsert.run(user.value, key, typeId?.value ?? null, note.value); })();
  res.json({ data: { updated: keys.length } });
});

/**
 * Loescht einen Zeitraum in einem Aufruf - das Gegenstueck zu `/overrides/fill`,
 * fuer den Fall, dass eine als Gruppe angezeigte Reihe (Client: `overrideGroups()`)
 * ganz oder in einem Randabschnitt wieder verschwinden soll. Anders als beim
 * Fuellen gilt hier NICHT MAX_FILL_DAYS: ein DELETE ueber `date_key BETWEEN`
 * ist eine einzelne indizierte Anweisung, keine Schleife ueber N Zeilen - die
 * Kosten skalieren nicht mit der Spanne, deshalb der groessere Lese-Deckel.
 */
router.delete('/overrides', (req, res) => {
  const user = id(req.query.user_id ?? actorId(req), 'user_id');
  const from = date(req.query.from, 'from', true);
  const to = date(req.query.to, 'to', true);
  const errors = collectErrors([user, from, to]);
  if (from.value && to.value && from.value > to.value) errors.push('from must be before to.');
  if (user.value && !userExists(user.value)) errors.push('user_id does not exist.');
  if (!mineOrAdmin(req, user.value)) errors.push('Forbidden.');
  if (errors.length) return res.status(errors.includes('Forbidden.') ? 403 : 400).json({ error: errors.join(' '), code: errors.includes('Forbidden.') ? 403 : 400 });
  const span = daysBetweenDateKeys(from.value, to.value);
  if (span === null || span + 1 > MAX_RANGE_DAYS) {
    return fail(res, 400, `The range must not exceed ${MAX_RANGE_DAYS} days.`);
  }
  const result = db.get().prepare('DELETE FROM schedule_overrides WHERE user_id=? AND date_key BETWEEN ? AND ?').run(user.value, from.value, to.value);
  res.json({ data: { deleted: result.changes } });
});

router.delete('/overrides/:dateKey', (req, res) => {
  const key = date(req.params.dateKey, 'date_key', true); const user = id(req.query.user_id ?? actorId(req), 'user_id'); const errors = collectErrors([key, user]);
  if (!mineOrAdmin(req, user.value)) return fail(res, 403, 'Forbidden.'); if (errors.length) return fail(res, 400, errors.join(' '));
  const result = db.get().prepare('DELETE FROM schedule_overrides WHERE user_id=? AND date_key=?').run(user.value, key.value);
  return result.changes ? res.status(204).end() : fail(res, 404, 'Override not found.');
});

export default router;
