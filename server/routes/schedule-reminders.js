/**
 * Modul: Schichtplan-Erinnerungen — Einstellung
 * Zweck: Eigener Vorlauf (Minuten vor Schichtbeginn) je Nutzer. Eigene Datei
 *        statt in routes/schedule.js: server/services/schedule-reminders.js
 *        importiert scheduleData aus routes/schedule.js für den Sync - ein
 *        Rückimport hier hätte einen Zyklus ergeben (gleicher Grund wie
 *        routes/schedule-feed.js).
 *
 * Keine Admin-Gate: der Vorlauf hängt an der eigenen users-Zeile, jeder
 * angemeldete Nutzer stellt nur seinen eigenen ein.
 */

import express from 'express';
import * as db from '../db.js';
import { createLogger } from '../logger.js';
import { syncScheduleRemindersForUser } from '../services/schedule-reminders.js';

const log = createLogger('Schedule');
const router = express.Router();

const MAX_OFFSET_MINUTES = 24 * 60;

function getUserId(req) {
  const candidates = [req.authUserId, req.user?.id, req.session?.userId];
  for (const value of candidates) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
}

// GET /api/v1/schedule/reminders → eigener Vorlauf (null = abgeschaltet)
router.get('/', (req, res) => {
  try {
    const row = db.get().prepare('SELECT schedule_reminder_offset_minutes AS m FROM users WHERE id = ?').get(getUserId(req));
    res.json({ data: { offsetMinutes: row?.m ?? null } });
  } catch (err) {
    log.error('GET /schedule/reminders error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// PUT /api/v1/schedule/reminders { offsetMinutes: number|null } → eigenen Vorlauf setzen
router.put('/', (req, res) => {
  try {
    const raw = req.body?.offsetMinutes;
    let offsetMinutes = null;
    if (raw !== null && raw !== undefined) {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0 || n > MAX_OFFSET_MINUTES) {
        return res.status(400).json({ error: `offsetMinutes must be an integer between 0 and ${MAX_OFFSET_MINUTES}, or null.`, code: 400 });
      }
      offsetMinutes = n;
    }
    const userId = getUserId(req);
    db.get().prepare('UPDATE users SET schedule_reminder_offset_minutes = ? WHERE id = ?').run(offsetMinutes, userId);
    // Sofort wirksam statt erst beim naechsten periodischen Lauf - gleiche
    // Erwartung wie beim Vorrat (server/routes/pantry.js ruft die Ein-
    // Artikel-Fassung direkt nach dem Speichern).
    syncScheduleRemindersForUser(db.get(), userId);
    res.json({ data: { offsetMinutes } });
  } catch (err) {
    log.error('PUT /schedule/reminders error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

export default router;
