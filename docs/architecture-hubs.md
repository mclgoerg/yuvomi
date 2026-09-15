# Architektur: God-Nodes - Constraint-Brücken vs. organische Hubs

_Abgeleitet aus einer Wissensgraph-Analyse der Codebase (2026-07-08); die Import-/Aufruf-Zahlen sind per grep-Gegencheck ermittelt und zuletzt am 2026-09-14 aufgefrischt (dieselbe Zählweise wie am 2026-08-05, gegen den damaligen Stand nachgerechnet: `import { … }` je Datei, Aufrufe ohne die Definition, `public/vendor/` ausgenommen). Die Betweenness-Werte stammen aus der Analyse vom Juli und sind als Größenordnung zu lesen; für `toLocalDateKey()` beschreiben sie den Stand vor #829._

Die zentralsten Frontend-/Server-Utilities von Yuvomi ("God-Nodes" im Wissensgraph)
zerfallen in **zwei Klassen**, die der Graph an der Provenienz ihrer Kanten trennt
(`INFERRED calls` vs. `EXTRACTED imports`):

| Node | Klasse | Importe / Aufrufe | Aufrufe/Datei | Betweenness | Getrieben von |
|------|--------|-------------------|---------------|-------------|---------------|
| [`esc()`](../public/utils/html.js) | Constraint-Brücke | 65 / ~2480 | ~38 | 0.260 | `innerHTML`-Verbot (Frontend-Audit) |
| [`toLocalDateKey()`](../public/utils/date.js) | Constraint-Brücke, seit #829 verteilt | 5 / 19 | ~4 | 0.131 (Juli) | `.toISOString().slice(0,10)`-Verbot |
| [`createLogger()`](../server/logger.js) | organischer Hub | 107 / 110 | ~1 | niedrig | freiwillige Zentralisierung |

## Constraint-Brücken (`esc`, `toLocalDateKey`)

Hohe Betweenness, viele `INFERRED calls`, hohe Aufruf-Dichte pro Datei. Ihre Existenz
ist durch ein **Verbot erzwungen** - jedes Modul muss durch sie hindurch:

- `esc()` - das `innerHTML`-Verbot (durchgesetzt vom Frontend-Audit,
  `npm run test:frontend-audit`, Teil von `npm test` und CI) plus das Framework-Verbot
  bedeuten: jedes gerenderte Nutzer-Datum muss manuell durch `esc()`. Es gibt kein
  Auto-Escaping wie in React/Vue. Ergebnis: ~2480 Aufrufe über 65 importierende Dateien
  (am 2026-08-05: ~1570 über 49), topologisch auf dem kürzesten Pfad zwischen fast allen
  Modul-Communities.
- `toLocalDateKey()` - die Konvention "nie `.toISOString().slice(0,10)`" (UTC-Shift
  westlich von UTC) macht diesen Helfer zum Weg, aus einem `Date` ein API-Datum zu erzeugen.
  Das verbotene Anti-Pattern hat im Frontend weiterhin **0 Fundstellen** - lückenlos durchgesetzt.
  Der Node ist die Wurzel einer Helfer-Familie in `public/utils/date.js`: `addLocalDays`,
  `startOfLocalWeekKey` und `monthPeriodKeys` rufen ihn intern, `parseLocalDateKey` ist
  seine Gegenrichtung.

  **Seit #829 (2026-08-23) ist die Brücke verteilt statt verschwunden.** Die Frage nach
  "heute" beantwortet jetzt `todayKey()`: sie folgt der Haushaltszone, während
  `toLocalDateKey()`/`parseLocalDateKey()` ein Konverter-Paar bleiben, das die Zone des
  Browsers liest (Begründung im Kopf von `public/utils/date.js`, abgesichert in
  `test:display-timezone`). Die Aufrufe von `toLocalDateKey()` sind dadurch von 62 auf 19
  gefallen (Importe 15 auf 5), die Dateien, die `date.js` importieren, aber von 19 auf 28
  gestiegen. Stand 2026-09-14: `todayKey` 24 Importe / 81 Aufrufe, `addLocalDays` 16 / 60,
  `parseLocalDateKey` 12 / 34. `todayKey` war in der Juli-Analyse noch nicht vorhanden und
  hat deshalb keinen Betweenness-Wert.

In einer Framework-Codebase (Auto-Escaping im Renderer, Date-Library) wären beide Nodes
unsichtbar. Hier gehörten sie in der Juli-Analyse zu den meistverbundenen Frontend-Utilities -
die graphtheoretische Signatur von "no frameworks, no `innerHTML`, no UTC-slicing".

## Organische Hubs (`createLogger`)

Hoher Degree durch `EXTRACTED imports`, aber nur **~1 Aufruf pro Datei** - das
Modul-Singleton-Muster: jede Server-Datei instanziiert einmal `const log =
createLogger('mod')` am Dateikopf und nutzt danach `log.info(...)`. 107 Importe,
110 Aufrufe (am 2026-08-05: 74 / 76). Keine Regel verbietet `console.log`; die Zentralisierung
([`server/logger.js`](../server/logger.js) - strukturiertes JSON-Logging ohne externe
Dependency, gesteuert per `LOG_LEVEL`) ist ein bewusstes Design, das Entwickler
*freiwillig* wählen. In jeder Codebase zu erwarten. Ein Speichenrad, keine Brücke -
`createLogger` sitzt nicht auf den kürzesten Modul-zu-Modul-Pfaden.

## Messbare Trennlinie

- **Constraint-Brücke:** hohe *Betweenness* + `INFERRED calls` + hohe Aufruf-Dichte pro Datei.
- **Organischer Hub:** hoher *Degree* durch `EXTRACTED imports` + ~1 Aufruf pro Datei.

`createLogger` rangierte in der Juli-Analyse nach reinem Degree auf Platz 3 der God-Nodes, ist
aber trotzdem ein Hub und keine Brücke - Degree allein unterscheidet die Rollen nicht,
Betweenness und Kanten-Provenienz schon.

## Verifikations-Nebenbefund

Die `INFERRED`-Kanten an `esc()`, die der Graph-Report als prüfbedürftig markierte,
sind durch den grep-Gegencheck (Stand 2026-09-14: 65 Importe, ~2480 Aufrufe) als **echt**
bestätigt - keine Halluzination der semantischen Extraktion.
