/**
 * Modul: Inventar - Service-Log und Verlaufs-Ansicht (TÜV, Wartung, ...)
 * Zweck: Helfer-Modul, KEIN Router (gleicher Schnitt wie item-dates.js und
 *        entry-links.js) - die Routen selbst liegen in items.js neben den
 *        bestehenden /:id/entries-Routen.
 *
 * Drei Dinge leben hier:
 *   1. Die "Erledigt"-Aktion (completeTrackedDate): ein Log-Eintrag entsteht,
 *      und je nachdem, ob die Frist ein interval_months traegt, rollt das
 *      Datum weiter (addMonthsClamped, server/utils/interval-date.js) oder die
 *      Frist verschwindet - siehe item-dates.js#rollTrackedDateForward/
 *      removeTrackedDate fuer die Begruendung, warum eine Zeile ihre id
 *      dabei behaelt.
 *   2. Plain CRUD auf inventory_item_service_log.
 *   3. Die Verlaufs-Ansicht (loadHistory): eine REINE Zusammenfuehrung von
 *      Log-Zeilen, verknuepften Buchungen (entry-links.js, Rollen
 *      maintenance/accessory) und verknuepften Dokumenten
 *      (document-links.js) - kein neuer Speicher (DECISIONS.md #6). Beide
 *      bestehenden Sichtbarkeitsregeln (budgetDetailsVisibleWhere ueber
 *      loadLinkedEntries, documentVisibleSql ueber documentLinksFor) laufen
 *      unveraendert mit - keine zweite Kopie (DECISIONS.md #2).
 *
 * Inventar hat kein Sichtbarkeitsmodell je Gegenstand - Gegenstaende sind
 * haushaltweit (items.js Modulkopf). Log-Zeilen sind es deshalb auch: keine
 * neue Sichtbarkeits-Vokabel fuer sie erfinden.
 */
import * as db from '../../db.js';
import {
  str, date, num, collectErrors, MAX_SHORT, MAX_TEXT,
} from '../../middleware/validate.js';
import { addMonthsClamped } from '../../utils/interval-date.js';
import {
  loadTrackedDate, rollTrackedDateForward, removeTrackedDate,
} from './item-dates.js';
import { loadLinkedEntries, computeTotal } from './entry-links.js';
import { documentLinksFor } from '../../services/document-links.js';

/** Rollen, die im Service-Verlauf zaehlen - dieselben, die das Formular unter
 *  "Reparatur/Wartung" bzw. "Zubehoer" anbietet (entry-links.js#ROLES). */
const HISTORY_ENTRY_ROLES = ['maintenance', 'accessory'];
const DOCS = { table: 'inventory_item_documents', ownerColumn: 'item_id' };

function validateServiceLogInput(body) {
  const results = [];
  const vLabel = str(body?.label, 'Bezeichnung', { max: 100 });
  results.push(vLabel);
  const vPerformedOn = date(body?.performed_on, 'Datum', true);
  results.push(vPerformedOn);

  let odometer = null;
  if (body?.odometer !== undefined && body.odometer !== null && body.odometer !== '') {
    const vOdometer = num(body.odometer, 'Kilometerstand');
    results.push(vOdometer);
    if (vOdometer.value !== null && (!Number.isInteger(vOdometer.value) || vOdometer.value < 0)) {
      results.push({ error: 'Kilometerstand darf nicht negativ sein.' });
    } else if (vOdometer.value !== null) {
      odometer = vOdometer.value;
    }
  }

  const vVendor = str(body?.vendor, 'Haendler', { max: MAX_SHORT, required: false });
  results.push(vVendor);
  const vNote = str(body?.note, 'Notiz', { max: MAX_TEXT, required: false });
  results.push(vNote);

  return {
    value: {
      label: vLabel.value, performed_on: vPerformedOn.value, odometer,
      vendor: vVendor.value, note: vNote.value,
    },
    errors: collectErrors(results),
  };
}

/**
 * Wie validateServiceLogInput, aber ohne Bezeichnung - die "Erledigt"-Aktion
 * uebernimmt sie von der getrackten Frist selbst (completeTrackedDate), sie
 * kommt hier nie aus dem Body.
 */
function validateCompletionInput(body) {
  const results = [];
  const vPerformedOn = date(body?.performed_on, 'Datum', true);
  results.push(vPerformedOn);

  let odometer = null;
  if (body?.odometer !== undefined && body.odometer !== null && body.odometer !== '') {
    const vOdometer = num(body.odometer, 'Kilometerstand');
    results.push(vOdometer);
    if (vOdometer.value !== null && (!Number.isInteger(vOdometer.value) || vOdometer.value < 0)) {
      results.push({ error: 'Kilometerstand darf nicht negativ sein.' });
    } else if (vOdometer.value !== null) {
      odometer = vOdometer.value;
    }
  }

  const vVendor = str(body?.vendor, 'Haendler', { max: MAX_SHORT, required: false });
  results.push(vVendor);
  const vNote = str(body?.note, 'Notiz', { max: MAX_TEXT, required: false });
  results.push(vNote);

  return {
    value: { performed_on: vPerformedOn.value, odometer, vendor: vVendor.value, note: vNote.value },
    errors: collectErrors(results),
  };
}

function loadServiceLog(itemId) {
  return db.get().prepare(`
    SELECT id, item_id, item_date_id, label, performed_on, odometer, vendor, note, created_by, created_at
    FROM inventory_item_service_log
    WHERE item_id = ?
    ORDER BY performed_on DESC, id DESC
  `).all(itemId);
}

function loadServiceLogEntry(itemId, logId) {
  return db.get().prepare(`
    SELECT id, item_id, item_date_id, label, performed_on, odometer, vendor, note, created_by, created_at
    FROM inventory_item_service_log
    WHERE id = ? AND item_id = ?
  `).get(logId, itemId);
}

/**
 * Ein Kilometerstand auf einer Log-Zeile schreibt inventory_items.odometer nur
 * fort, wenn er die neueste Ablesung ist - ein rueckdatierter Reparatur-
 * Eintrag darf den aktuellen Kilometerstand des Fahrzeugs nicht zuruecksetzen.
 */
function maybeAdvanceItemOdometer(itemId, performedOn, odometer) {
  if (odometer == null) return;
  const item = db.get().prepare('SELECT odometer_on FROM inventory_items WHERE id = ?').get(itemId);
  if (!item) return;
  if (item.odometer_on == null || performedOn >= item.odometer_on) {
    db.get().prepare('UPDATE inventory_items SET odometer = ?, odometer_on = ? WHERE id = ?')
      .run(odometer, performedOn, itemId);
  }
}

function createServiceLogEntry({ itemId, values, userId }) {
  const result = db.get().transaction(() => {
    const inserted = db.get().prepare(`
      INSERT INTO inventory_item_service_log (item_id, label, performed_on, odometer, vendor, note, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(itemId, values.label, values.performed_on, values.odometer, values.vendor, values.note, userId);
    maybeAdvanceItemOdometer(itemId, values.performed_on, values.odometer);
    return inserted;
  })();
  return loadServiceLogEntry(itemId, result.lastInsertRowid);
}

function updateServiceLogEntry({ itemId, logId, values }) {
  const existing = loadServiceLogEntry(itemId, logId);
  if (!existing) return null;
  db.get().transaction(() => {
    db.get().prepare(`
      UPDATE inventory_item_service_log
      SET label = ?, performed_on = ?, odometer = ?, vendor = ?, note = ?
      WHERE id = ?
    `).run(values.label, values.performed_on, values.odometer, values.vendor, values.note, logId);
    maybeAdvanceItemOdometer(itemId, values.performed_on, values.odometer);
  })();
  return loadServiceLogEntry(itemId, logId);
}

function deleteServiceLogEntry({ itemId, logId }) {
  return db.get().prepare('DELETE FROM inventory_item_service_log WHERE id = ? AND item_id = ?').run(logId, itemId);
}

/**
 * Die "Erledigt"-Aktion: EINE Transaktion (Log-Zeile schreiben, Frist
 * vorrollen ODER abraeumen, Erinnerung neu synct). Die Erinnerung gehoert
 * item.created_by, nicht der Person, die gerade klickt - identisches Muster
 * wie item-dates.js selbst (Modulkopf) und items.js#syncReminder.
 * @returns {{trackedDate: object|null, logEntry: object}|{error:string, code:number}}
 */
function completeTrackedDate({ item, dateId, values, userId }) {
  const trackedDate = loadTrackedDate(dateId);
  if (!trackedDate || trackedDate.item_id !== item.id) {
    return { error: 'Tracked date not found.', code: 404 };
  }

  const result = db.get().transaction(() => {
    const inserted = db.get().prepare(`
      INSERT INTO inventory_item_service_log
        (item_id, item_date_id, label, performed_on, odometer, vendor, note, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      item.id, trackedDate.id, trackedDate.label, values.performed_on,
      values.odometer, values.vendor, values.note, userId,
    );

    maybeAdvanceItemOdometer(item.id, values.performed_on, values.odometer);

    if (trackedDate.interval_months != null) {
      const nextDate = addMonthsClamped(trackedDate.date, trackedDate.interval_months);
      rollTrackedDateForward(trackedDate, nextDate, item.created_by);
    } else {
      removeTrackedDate(trackedDate.id);
    }

    return inserted;
  })();

  return {
    logEntry: loadServiceLogEntry(item.id, result.lastInsertRowid),
    trackedDate: trackedDate.interval_months != null ? loadTrackedDate(trackedDate.id) : null,
  };
}

/**
 * Die Verlaufs-Ansicht: Log-Zeilen + verknuepfte Buchungen (Rollen
 * maintenance/accessory) + verknuepfte Dokumente, zu EINER nach Datum
 * sortierten Zeitleiste zusammengefuehrt. Reine Aggregation, kein neuer
 * Speicher (DECISIONS.md #6) - beide Sichtbarkeitsregeln laufen ueber ihre
 * bestehenden, einzigen Stellen (DECISIONS.md #2).
 */
function loadHistory(itemId, userId) {
  const logRows = loadServiceLog(itemId).map((row) => ({
    type: 'service_log',
    id: row.id,
    date: row.performed_on,
    label: row.label,
    odometer: row.odometer,
    vendor: row.vendor,
    note: row.note,
  }));

  const bookingLinks = loadLinkedEntries(itemId, userId)
    .filter((link) => HISTORY_ENTRY_ROLES.includes(link.role));
  const bookingRows = bookingLinks.map((link) => ({
    type: 'budget_entry',
    id: link.entry_id,
    date: link.date,
    label: link.title,
    role: link.role,
    amount: link.amount,
  }));

  const documentRows = documentLinksFor(db.get(), { ...DOCS, ownerId: itemId, userId }).map((doc) => ({
    type: 'document',
    id: doc.document_id,
    date: doc.created_at,
    label: doc.name || doc.original_name || '',
  }));

  const timeline = [...logRows, ...bookingRows, ...documentRows]
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  return { timeline, total: computeTotal(bookingLinks) };
}

export {
  HISTORY_ENTRY_ROLES,
  validateServiceLogInput,
  validateCompletionInput,
  loadServiceLog,
  loadServiceLogEntry,
  createServiceLogEntry,
  updateServiceLogEntry,
  deleteServiceLogEntry,
  completeTrackedDate,
  loadHistory,
};
