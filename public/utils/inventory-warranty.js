/**
 * Modul: Inventar-Garantiestatus (Inventory warranty status)
 * Zweck: warranty_end (Kaufdatum + Garantiemonate) rein clientseitig ableiten -
 *        analog public/utils/pantry-status.js. Kein Server-Roundtrip, keine
 *        neuen API-Felder.
 * Abhängigkeiten: public/utils/date.js
 */

// `todayKey` heisst hier schon ein Parameter (bzw. eine lokale Bindung), der den
// Bezugstag traegt - der Import kommt deshalb unter eigenem Namen herein.
import { parseLocalDateKey, todayKey as householdToday } from '/utils/date.js';
// dateStatus() und ihr Schwellenwert leben jetzt in einer neutralen Datei, weil
// Dokumente (und spaeter Health) denselben Chip brauchen. Re-exportiert, damit
// jeder bestehende Inventar-Import unveraendert bleibt - der alte Name
// WARRANTY_ALERT_DAYS bleibt hier als Alias, "Garantie" waere unter dem neuen,
// neutralen Namen in date-status.js selbst irrefuehrend.
import { DATE_STATUS_ALERT_DAYS, dateStatus } from './date-status.js';

const WARRANTY_ALERT_DAYS = DATE_STATUS_ALERT_DAYS;
export { WARRANTY_ALERT_DAYS, dateStatus };

function pad(n) { return String(n).padStart(2, '0'); }

/**
 * @param {object} item - Inventar-Gegenstand aus der API
 * @returns {string|null} YYYY-MM-DD, oder null wenn Kaufdatum/Garantiemonate fehlen
 */
export function warrantyEndDateKey(item) {
  const purchaseDate = item?.purchase_date;
  const months = item?.warranty_months;
  if (!purchaseDate || months == null) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(purchaseDate);
  if (!match) return null;
  const day = Number(match[3]);
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
  date.setUTCMonth(date.getUTCMonth() + Number(months));
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/**
 * @param {object} item
 * @param {string} [todayKey] - lokaler Tagesschlüssel (YYYY-MM-DD)
 * @returns {{ state: 'valid'|'expiring'|'expired', endDateKey: string, days: number } | null}
 */
export function warrantyStatus(item, todayKey = householdToday()) {
  const endDateKey = warrantyEndDateKey(item);
  if (!endDateKey) return null;
  const days = Math.round((parseLocalDateKey(endDateKey) - parseLocalDateKey(todayKey)) / 86_400_000);
  const state = days < 0 ? 'expired' : days <= DATE_STATUS_ALERT_DAYS ? 'expiring' : 'valid';
  return { state, endDateKey, days };
}

/** Trifft der Listen-Hinweis zu (läuft bald ab ODER bereits abgelaufen)? */
export function hasWarrantyAlert(item, todayKey = householdToday()) {
  const status = warrantyStatus(item, todayKey);
  return !!status && status.state !== 'valid';
}

/** Trifft der Listen-Hinweis zu - Garantie ODER irgendeine getrackte Frist
 *  laeuft bald ab/ist abgelaufen? Ein Icon fuer beide Quellen (Design-Doc). */
export function hasUpcomingDeadline(item, todayKey = householdToday()) {
  if (hasWarrantyAlert(item, todayKey)) return true;
  const trackedDates = item?.tracked_dates || [];
  return trackedDates.some((d) => {
    const status = dateStatus(d.date, todayKey);
    return !!status && status.state !== 'valid';
  });
}

/** Wie viele Items haben eine bald ablaufende/abgelaufene Garantie oder
 *  getrackte Frist? Fuer die Kennzahl-Karte und das Nav-Badge (Design-Doc §4). */
export function countUpcomingDeadlines(items, todayKey = householdToday()) {
  return items.filter((item) => hasUpcomingDeadline(item, todayKey)).length;
}
