import { op, jsonBody, idParam } from '../helpers.js';

export function healthPaths() {
  return {
    '/api/v1/health/vitals': {
      get: op({ summary: 'List vital measurements', tag: 'Health', description: 'Scoped to the viewer; `?user_id=` filters to a family member (only their `family`-visible rows). Optional `type`, `from`, `to` filters.' }),
      post: op({ summary: 'Create a vital measurement', tag: 'Health', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/health/vitals/{id}': {
      patch: op({ summary: 'Update a vital measurement', tag: 'Health', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete a vital measurement', tag: 'Health', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/health/medications': {
      get: op({ summary: 'List medications', tag: 'Health', description: 'Scoped to the viewer; `?user_id=` and `?active=` filters supported.' }),
      post: op({ summary: 'Create a medication', tag: 'Health', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/health/medications/{id}': {
      patch: op({ summary: 'Update a medication', tag: 'Health', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete a medication', tag: 'Health', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/health/medications/{id}/schedules': {
      get: op({ summary: 'List a medication\'s intake schedules', tag: 'Health', params: [idParam()] }),
      post: op({ summary: 'Add an intake schedule to a medication', tag: 'Health', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/health/schedules/{id}': {
      patch: op({ summary: 'Update an intake schedule', tag: 'Health', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete an intake schedule', tag: 'Health', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/health/medications/{id}/logs': {
      get: op({ summary: 'List a medication\'s dose log', tag: 'Health', params: [idParam()], description: 'Optional `from`/`to` filters on `scheduled_at`.' }),
      post: op({ summary: 'Add a dose-log entry', tag: 'Health', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/health/logs/{id}': {
      patch: op({
        summary: 'Correct a dose-log entry',
        tag: 'Health',
        params: [idParam()],
        stateChanging: true,
        requestBody: jsonBody(null),
        description: 'Body: { status?, taken_at?, dose_qty?, note? } (#701). `status: "pending"` undoes a take or a skip. The timestamp travels with the status rather than beside it: anything other than `taken` clears `taken_at`, because a dose that was not taken cannot carry a time it was taken at - and that entry would end up in the CSV export too. Restricted to the owner of the medication.',
      }),
      delete: op({
        summary: 'Delete a dose-log entry',
        tag: 'Health',
        params: [idParam()],
        stateChanging: true,
        description: 'Only for entries without a schedule, so ad-hoc and as-needed doses (#701). A scheduled entry answers `409`: the scheduler would recreate it on its next run, so deleting it would look like a success and be a return on the instalment plan. Undo it with `PATCH { status: "pending" }` instead.',
      }),
    },
    '/api/v1/health/logs/{id}/take': {
      post: op({ summary: 'Mark a dose as taken', tag: 'Health', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/health/logs/{id}/skip': {
      post: op({ summary: 'Mark a dose as skipped', tag: 'Health', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/health/labs': {
      get: op({ summary: 'List lab reports (with results)', tag: 'Health', description: 'Scoped to the viewer; `?user_id=`, `from`, `to` filters supported.' }),
      post: op({ summary: 'Create a lab report with analyte results', tag: 'Health', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/health/labs/{id}': {
      get: op({ summary: 'Get a lab report (with results)', tag: 'Health', params: [idParam()] }),
      patch: op({ summary: 'Update lab report header fields', tag: 'Health', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete a lab report', tag: 'Health', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/health/labs/{id}/results': {
      post: op({ summary: 'Add an analyte result to a lab report', tag: 'Health', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/health/results/{id}': {
      delete: op({ summary: 'Delete an analyte result', tag: 'Health', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/health/activities': {
      get: op({ summary: 'List activities', tag: 'Health', description: 'Scoped to the viewer; `?user_id=`, `type`, `from`, `to` filters supported.' }),
      post: op({ summary: 'Create an activity', tag: 'Health', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/health/activities/{id}': {
      patch: op({ summary: 'Update an activity', tag: 'Health', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete an activity', tag: 'Health', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/health/export/vitals': {
      get: op({ summary: 'Export vital measurements as CSV', tag: 'Health', description: 'Scoped to the viewer; `?user_id=`, `from`, `to` filters supported. Returns `text/csv`.' }),
    },
    '/api/v1/health/export/activities': {
      get: op({ summary: 'Export activities as CSV', tag: 'Health', description: 'Scoped to the viewer; `?user_id=`, `from`, `to` filters supported. Returns `text/csv`.' }),
    },
    '/api/v1/health/export/labs': {
      get: op({ summary: 'Export lab reports (one row per analyte) as CSV', tag: 'Health', description: 'Scoped to the viewer; `?user_id=`, `from`, `to` filters supported. Returns `text/csv`.' }),
    },
    '/api/v1/health/export/meds-logs': {
      get: op({ summary: 'Export medication dose logs as CSV', tag: 'Health', description: 'Scoped to the viewer; `?user_id=`, `from`, `to` filters supported. Returns `text/csv`.' }),
    },
    '/api/v1/health/cycle/periods': {
      get: op({ summary: 'List menstrual period episodes', tag: 'Health', description: 'Scoped to the viewer; `?user_id=`, `from`, `to` filters supported.' }),
      post: op({ summary: 'Log a menstrual period episode', tag: 'Health', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/health/cycle/periods/{id}': {
      patch: op({ summary: 'Update a period episode', tag: 'Health', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete a period episode', tag: 'Health', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/health/cycle/logs': {
      get: op({
        summary: 'List cycle day logs (flow, symptoms, feelings, mucus, tests)',
        tag: 'Health',
        description: 'Scoped to the viewer; `?user_id=`, `from`, `to` filters supported. Each row also carries `cervix_mucus`, `lh_test`, `pregnancy_test` (all nullable enums, see the POST body) and `feelings` (array of mood keys, from the normalized `cycle_day_log_feelings` table). The legacy scalar `mood` is still returned for backward compatibility but no longer written. `intimacy` is included ONLY when the caller is the row\'s own owner - stripped from every other read regardless of the row\'s `visibility`, since sharing a day does not imply sharing its sex-life entry.',
      }),
      post: op({
        summary: 'Upsert a cycle day log (one per person and day)',
        tag: 'Health',
        stateChanging: true,
        requestBody: jsonBody(null),
        description: 'Body: { log_date, flow?, note?, visibility?, symptoms?, basal_temp?, basal_temp_unit?, cervix_mucus?, lh_test?, pregnancy_test?, intimacy?, feelings? }. `cervix_mucus` ∈ dry/sticky/creamy/watery/eggwhite; `lh_test`/`pregnancy_test` ∈ negative/positive; `intimacy` ∈ protected/unprotected/solo. `feelings` is an array of mood keys (same set as the frontend\'s MOOD_TYPES); the legacy single-value `mood` is still accepted and treated as `feelings: [mood]` when `feelings` is absent, but the `mood` column itself is never written again (frozen, like the old symptoms CSV column).',
      }),
    },
    '/api/v1/health/cycle/logs/{id}': {
      delete: op({ summary: 'Delete a cycle day log', tag: 'Health', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/health/cycle/settings': {
      get: op({
        summary: 'Get the viewer\'s cycle prediction settings',
        tag: 'Health',
        description: 'Includes `contraception`, `perimenopause_mode`, `show_pms`, `notify_partner_user_id` and `notify_partner_days_before` alongside the existing prediction settings.',
      }),
      put: op({
        summary: 'Update the viewer\'s cycle prediction settings',
        tag: 'Health',
        stateChanging: true,
        requestBody: jsonBody(null),
        description: 'Full-replace semantics like every other field on this route: an omitted field resets to its default rather than leaving the stored value untouched. `contraception` ∈ none/pill/hormonal_iud/copper_iud/implant/injection/patch/ring/condom/other; hormonal methods auto-disable fertile-window prediction client-side. `perimenopause_mode`/`show_pms` are booleans. `notify_partner_user_id` (opt-in partner notification, D-15) must be an existing household member and must not be the caller themselves - 400 otherwise; empty/absent clears it. `notify_partner_days_before` is an integer 0-14.',
      }),
    },
    '/api/v1/health/cycle/feed': {
      get: op({ summary: 'Get own predicted-cycle ICS feed status', tag: 'Health' }),
      delete: op({ summary: 'Disable own predicted-cycle ICS feed', tag: 'Health', stateChanging: true }),
    },
    '/api/v1/health/cycle/feed/regenerate': {
      post: op({ summary: 'Regenerate own predicted-cycle ICS feed token', tag: 'Health', stateChanging: true }),
    },
    '/api/v1/health/export/cycle': {
      get: op({ summary: 'Export period history as CSV', tag: 'Health', description: 'Scoped to the viewer; `?user_id=`, `from`, `to` filters supported. Returns `text/csv`.' }),
    },
    '/api/v1/health/cycle/import': {
      post: op({
        summary: 'Import period history from CSV (D-13)',
        tag: 'Health',
        stateChanging: true,
        requestBody: jsonBody(null),
        description: 'Body: { csv: string }. Header-tolerant CSV in the export\'s own column order (`start_date`, `end_date` first - see GET /export/cycle); extra columns are ignored. Accepts both comma and semicolon separators (German Excel exports use `;`) and both `YYYY-MM-DD` and `DD.MM.YYYY` dates (again a German-export accommodation). All-or-nothing: any invalid row rejects the whole import with 400 and up to the first 10 row errors, nothing is inserted. A row whose `start_date` matches an existing period of the caller is skipped (counted, not an error); other overlaps are allowed. Rejects with 400 if the payload exceeds 100 KB or 500 data rows. New periods take the caller\'s `default_visibility` from `/cycle/settings` (falls back to `private`). Response: `{ imported, skipped, errors: [] }`. Re-syncs the caller\'s cycle reminders once after commit.',
      }),
    },
    '/api/v1/health/caregivers/me': {
      get: op({ summary: 'List who the caller may record health data for', tag: 'Health', description: 'Open to every member: it is the answer about their own rights, not about anyone else\'s data.' }),
    },
    '/api/v1/health/caregivers': {
      get: op({ summary: 'List all caregiver relationships', tag: 'Health', admin: true, description: 'Returns `{ subject_id: [caregiver_id, ...] }` for the admin rights matrix.' }),
    },
    '/api/v1/health/caregivers/{subjectId}': {
      put: op({ summary: 'Set who may record health data for one person', tag: 'Health', admin: true, stateChanging: true, params: [idParam('subjectId', 'The person being cared for')], requestBody: jsonBody(null), description: 'Sets the caregivers to exactly the list given. An empty array withdraws care, so removing is the same path as changing and needs no route of its own.' }),
    },
    '/api/v1/health/cycle/visibility': {
      patch: op({ summary: 'Set the visibility of all own cycle entries at once', tag: 'Health', stateChanging: true, requestBody: jsonBody(null), description: 'Applies one visibility to every period and daily log of the CALLER. Other people\'s entries are untouched, and periods and logs move together in one transaction - either both or neither. Never exposes `intimacy` to anyone else even when logs move to `family`: that field is stripped from every non-owner read regardless of visibility (see GET /cycle/logs).' }),
    },
    '/api/v1/health/visibility-defaults': {
      get: op({ summary: 'Get the caller\'s default visibility per health area', tag: 'Health', description: 'Returns only the deviations as `{ scope_key: visibility }`; a missing key means `private`, the shipped value. Scope keys are `vital:<type>` per metric plus `meds`, `labs` and `activities`. The cycle tab keeps its own setting under `/health/cycle/settings`.' }),
      put: op({ summary: 'Set the caller\'s default visibility for one or more areas', tag: 'Health', stateChanging: true, requestBody: jsonBody(null), description: 'Body `{ defaults: { "vital:bp": "family", ... } }`. Named keys are replaced, unnamed ones stay. Setting `private` DELETES the row rather than storing it, so "no row" remains the only spelling of the default. Affects new entries only; a value given on the entry itself always wins.' }),
    },
    '/api/v1/health/visibility-defaults/apply': {
      patch: op({ summary: 'Move existing entries of one area to a visibility', tag: 'Health', stateChanging: true, requestBody: jsonBody(null), description: 'Body `{ scope, visibility }`. Touches the CALLER\'s own rows only, and only in the named area - a caregiver may tend individual entries but not relabel somebody else\'s history in one move. The target comes from the request rather than from the stored default, because `private` is not stored at all.' }),
    },
  };
}
