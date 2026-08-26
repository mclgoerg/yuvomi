/** Schedule API: patterns are computed into entries, never calendar events. */
import express from 'express';
import * as db from '../db.js';
import { bool, color, collectErrors, date, id, num, str, time } from '../middleware/validate.js';
import { resolveEntries } from '../services/schedule.js';

const router = express.Router();
const actorId = (req) => req.authUserId || req.session?.userId;
const isAdmin = (req) => req.authRole === 'admin' || req.session?.role === 'admin';
const fail = (res, code, error) => res.status(code).json({ error, code });
const userExists = (value) => !!db.get().prepare('SELECT 1 FROM users WHERE id = ?').get(value);
const typeExists = (value) => !!db.get().prepare('SELECT 1 FROM schedule_shift_types WHERE id = ?').get(value);
const mineOrAdmin = (req, userId) => isAdmin(req) || actorId(req) === userId;
const typeColumns = 'id, name, short_code, start_time, end_time, color, created_by, created_at, updated_at';

function scheduleData(from, to, userId) {
  const database = db.get();
  const condition = userId ? 'AND user_id = ?' : '';
  const patterns = database.prepare(`SELECT * FROM schedule_patterns WHERE is_active = 1
    AND (valid_from IS NULL OR valid_from <= ?) AND (valid_until IS NULL OR valid_until >= ?) ${condition}
    ORDER BY user_id, valid_from DESC, id DESC`).all(...(userId ? [to, from, userId] : [to, from]));
  const patternDays = new Map();
  if (patterns.length) {
    const ids = patterns.map((p) => p.id);
    for (const row of database.prepare(`SELECT * FROM schedule_pattern_days WHERE pattern_id IN (${ids.map(() => '?').join(',')})`).all(...ids)) patternDays.set(`${row.pattern_id}:${row.position}`, row);
  }
  const users = userId ? [userId] : database.prepare('SELECT id FROM users ORDER BY id').all().map((row) => row.id);
  const entries = []; const warnings = [];
  for (const memberId of users) {
    const overrides = database.prepare('SELECT * FROM schedule_overrides WHERE user_id = ? AND date_key BETWEEN ? AND ?').all(memberId, from, to);
    const resolved = resolveEntries({ from, to, userId: memberId, patterns: patterns.filter((p) => p.user_id === memberId), patternDays, overrides });
    entries.push(...resolved.entries); warnings.push(...resolved.warnings);
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
  if (requested && !userExists(requested.value)) return fail(res, 404, 'User not found.');
  try { res.json({ data: scheduleData(from.value, to.value, requested?.value ?? null) }); }
  catch (err) { res.status(500).json({ error: 'Schedule entries could not be resolved.', code: 500 }); }
});

router.get('/shift-types', (_req, res) => res.json({ data: db.get().prepare(`SELECT ${typeColumns} FROM schedule_shift_types ORDER BY name COLLATE NOCASE`).all() }));
router.post('/shift-types', (req, res) => {
  const name = str(req.body?.name, 'name'); const shortCode = str(req.body?.short_code, 'short_code', { required: false, max: 12 });
  const start = time(req.body?.start_time, 'start_time'); const end = time(req.body?.end_time, 'end_time'); const shade = color(req.body?.color || '#6C3AED', 'color');
  const errors = collectErrors([name, shortCode, start, end, shade]);
  if ((start.value == null) !== (end.value == null)) errors.push('start_time and end_time must be provided together.');
  if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });
  const result = db.get().prepare('INSERT INTO schedule_shift_types (name, short_code, start_time, end_time, color, created_by) VALUES (?, ?, ?, ?, ?, ?)').run(name.value, shortCode.value, start.value, end.value, shade.value, actorId(req));
  res.status(201).json({ data: db.get().prepare(`SELECT ${typeColumns} FROM schedule_shift_types WHERE id = ?`).get(result.lastInsertRowid) });
});
router.delete('/shift-types/:id', (req, res) => {
  const shiftType = id(req.params.id, 'id'); if (shiftType.error) return res.status(400).json({ error: shiftType.error, code: 400 });
  try { const result = db.get().prepare('DELETE FROM schedule_shift_types WHERE id = ?').run(shiftType.value); return result.changes ? res.status(204).end() : res.status(404).json({ error: 'Shift type not found.', code: 404 }); }
  catch { return res.status(409).json({ error: 'Shift type is in use.', code: 409 }); }
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
router.put('/patterns/:id/days/:position', (req, res) => {
  const patternId = id(req.params.id, 'pattern_id'); const position = num(req.params.position, 'position', { required: true });
  const typeId = req.body?.shift_type_id == null ? null : id(req.body.shift_type_id, 'shift_type_id');
  const pattern = patternId.value && db.get().prepare('SELECT * FROM schedule_patterns WHERE id = ?').get(patternId.value);
  if (!pattern) return res.status(404).json({ error: 'Pattern not found.', code: 404 }); if (!mineOrAdmin(req, pattern.user_id)) return res.status(403).json({ error: 'Forbidden.', code: 403 });
  if (patternId.error || !Number.isInteger(position.value) || position.value < 0 || position.value >= pattern.cycle_length || typeId?.error) return res.status(400).json({ error: 'Invalid pattern day.', code: 400 });
  if (typeId && !typeExists(typeId.value)) return fail(res, 400, 'shift_type_id does not exist.');
  db.get().prepare('INSERT INTO schedule_pattern_days (pattern_id, position, shift_type_id) VALUES (?, ?, ?) ON CONFLICT(pattern_id, position) DO UPDATE SET shift_type_id = excluded.shift_type_id').run(pattern.id, position.value, typeId?.value ?? null);
  res.json({ data: db.get().prepare('SELECT * FROM schedule_pattern_days WHERE pattern_id = ? AND position = ?').get(pattern.id, position.value) });
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
  const name = req.body?.name === undefined ? { value: old.name } : str(req.body.name, 'name');
  const shortCode = req.body?.short_code === undefined ? { value: old.short_code } : str(req.body.short_code, 'short_code', { required: false, max: 12 });
  const start = req.body?.start_time === undefined ? { value: old.start_time } : time(req.body.start_time, 'start_time');
  const end = req.body?.end_time === undefined ? { value: old.end_time } : time(req.body.end_time, 'end_time');
  const shade = req.body?.color === undefined ? { value: old.color } : color(req.body.color, 'color');
  const errors = collectErrors([name, shortCode, start, end, shade]);
  if ((start.value == null) !== (end.value == null)) errors.push('start_time and end_time must be provided together.');
  if (errors.length) return fail(res, 400, errors.join(' '));
  db.get().prepare('UPDATE schedule_shift_types SET name=?, short_code=?, start_time=?, end_time=?, color=? WHERE id=?').run(name.value, shortCode.value, start.value, end.value, shade.value, key.value);
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
  return res.json({ data: db.get().prepare('SELECT * FROM schedule_pattern_days WHERE pattern_id=? ORDER BY position').all(key.value) });
});
router.put('/patterns/:id/days', (req, res) => {
  const key = id(req.params.id, 'id'); if (key.error) return fail(res, 400, key.error);
  const old = db.get().prepare('SELECT * FROM schedule_patterns WHERE id=?').get(key.value);
  if (!old) return fail(res, 404, 'Pattern not found.'); if (!mineOrAdmin(req, old.user_id)) return fail(res, 403, 'Forbidden.');
  if (!Array.isArray(req.body?.days)) return fail(res, 400, 'days must be an array.');
  const seen = new Set(); const days = [];
  for (const row of req.body.days) {
    const position = num(row?.position, 'position', { required: true }); const shiftType = row?.shift_type_id == null ? null : id(row.shift_type_id, 'shift_type_id');
    if (position.error || !Number.isInteger(position.value) || position.value < 0 || position.value >= old.cycle_length || shiftType?.error || seen.has(position.value)) return fail(res, 400, 'Invalid pattern day.');
    if (shiftType && !typeExists(shiftType.value)) return fail(res, 400, 'shift_type_id does not exist.');
    seen.add(position.value); days.push([position.value, shiftType?.value ?? null]);
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
router.delete('/overrides/:dateKey', (req, res) => {
  const key = date(req.params.dateKey, 'date_key', true); const user = id(req.query.user_id ?? actorId(req), 'user_id'); const errors = collectErrors([key, user]);
  if (!mineOrAdmin(req, user.value)) return fail(res, 403, 'Forbidden.'); if (errors.length) return fail(res, 400, errors.join(' '));
  const result = db.get().prepare('DELETE FROM schedule_overrides WHERE user_id=? AND date_key=?').run(user.value, key.value);
  return result.changes ? res.status(204).end() : fail(res, 404, 'Override not found.');
});

export default router;
