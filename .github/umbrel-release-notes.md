<!-- version: 2.68.0 -->
Two things in this release are worth reading before you update, because both change what other people in your household can see.

Reading the calendar no longer reaches the contact book or your connected accounts. An access token scoped to the calendar alone could also list every contact with their birth date, and read the status of your connected CalDAV, Outlook, Google and Apple accounts, including the server address and the last sync error. If you use a token scoped to `calendar:read` or `tasks:read` for an integration that reads one of those, it now needs contact access or write access to that module. In the same vein, the list of reward requests no longer hands every reader of that module all of them: administrators still see all, everyone else sees their own.

Alongside that, a member who is not allowed into a module no longer receives its push notifications. Until now the toast stayed hidden while the push itself still arrived, title, amount and date included.

New this time: Health has a Prevention tab for vaccinations and check-ups, fasting can remind you when you reach your goal and when it is time to start again, and family documents can carry an expiry date with a reminder. A wall tablet can now get an account of its own that only a paired device can use, and from that tablet somebody can tick a task off and ask for a reward without signing in as themselves. Ticking a task off can also name who actually did it, rather than only who tapped the checkbox.

The rest is repair, and a lot of it sits in the calendar: a reminder for a single occurrence of a repeating event now arrives at the time it says, saving a change to one event of a series asks which events you mean, an appointment moved between calendars takes the right person with it, and a series that ends at a set moment no longer shows its last day twice. Notes, Contacts, Birthdays, Tasks, Calendar and Rewards no longer draw buttons a read-only member cannot use. An installation interrupted during its very first start comes back up on its own instead of leaving an empty file behind.

This release applies database migrations. They run by themselves the first time the new version starts, and on a large household that can take a moment.

Full release notes are available at https://github.com/ulsklyc/yuvomi/releases/tag/v2.68.0
