/**
 * Modul: Ablauf-Status fuer ein einzelnes Datum (Date status)
 * Zweck: "wie steht dieses Datum zu heute" als EINE Rechnung fuer jedes Modul,
 *        das einen Ablauf-Chip zeigt - vorher nur in
 *        public/utils/inventory-warranty.js, das jetzt eine Fassade darueber
 *        ist, damit bestehende Inventar-Importe unveraendert bleiben.
 * Abhängigkeiten: public/utils/date.js
 */
import { parseLocalDateKey, todayKey as householdToday } from '/utils/date.js';

/** Vorlauf in Tagen, ab dem ein Datum als "läuft bald ab" gilt. */
export const DATE_STATUS_ALERT_DAYS = 30;

/**
 * @param {string|null} dateKey - YYYY-MM-DD, oder null/leer
 * @param {string} [todayKey]
 * @returns {{ state: 'valid'|'expiring'|'expired', endDateKey: string, days: number } | null}
 */
export function dateStatus(dateKey, todayKey = householdToday()) {
  if (!dateKey) return null;
  const days = Math.round((parseLocalDateKey(dateKey) - parseLocalDateKey(todayKey)) / 86_400_000);
  const state = days < 0 ? 'expired' : days <= DATE_STATUS_ALERT_DAYS ? 'expiring' : 'valid';
  return { state, endDateKey: dateKey, days };
}
