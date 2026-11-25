# Courses table (Google Site embed)

A Google Apps Script web app that shows a table from the monday Courses board (board `7062102645`) inside a
Google Site. It replaces a shared monday view embed. What the table shows is set in a Google Sheet, so editors
never open the script.

Files: `Code.gs` (server), `Index.html` (page). No secrets are stored here.

## Set up
1. script.google.com > New project. Paste `Code.gs` and add an HTML file named `Index` with `Index.html`.
2. Project Settings > Script Properties: add `MONDAY_TOKEN` (a monday personal API token). Its owner must see the
   Courses board and the boards it links to.
3. Run `setupConfig` once from the editor and authorise. It creates the "Courses table settings" sheet, filled with
   the default view, and a daily trigger that refreshes its dropdowns. Share that sheet with the people who edit it.
4. In the sheet, on **Columns!B4**: Data > Data validation > Dropdown (from a range) = `Lists!A2:A300`, tick
   **Allow multiple selections**. Scripts can't create this kind of dropdown, so it is a one-time manual step.
5. Deploy > New deployment > Web app: Execute as **Me**, access **Anyone**. After any code change, Deploy >
   Manage deployments > New version (the URL stays the same).
6. In Google Sites: Embed > Embed code:
   `<iframe src="WEB-APP-URL" width="100%" height="900" style="border:0"></iframe>`

## Settings sheet (what editors change)
- **Columns**: columns to show, in order. The page updates within 5 minutes (cached; the page has a Refresh button).
- **Filters**: Column, Condition, Value. Only monday-native filters: status/dropdown (is, is not), date (in the past,
  today or in the future), text (contains, does not contain), and is empty / is not empty for all four. Two "is" rows
  on one column mean either one; different columns must all match.
- **Sort**: up to three levels. **Group**: group-by column, order, start collapsed.

## The page
Click a column header to sort (ascending, descending, back to default); click a group heading to collapse it;
search; Collapse all / Expand all; Refresh.

## Known requirements
- The script reads monday as the owner of `MONDAY_TOKEN`. That user must be a member of every board a
  connected-boards or mirror column links to. Otherwise monday hides the column from the script: it never appears in
  the sheet's dropdown, and putting its name in **Columns** breaks the page with `Columns: no column called "…"`.
  Fix: add the token's owner to the linked board (the board owner can do it), then add the column in the sheet.
- Hidden this way as of Nov 24, 2026: **Specialization** (links to NEW Specializations) and **App Taxonomy Skill**
  (links to Taxonomy). **Total Contract Amount** and **First Payment Amount** are hidden from that user too, probably
  by monday column permissions.

## Notes
- The page is public to anyone with the link. It returns only the columns chosen in the sheet.
- Filtering is done by monday, so only matching courses are downloaded.
- Changing `BOARD_ID` at the top of `Code.gs` points it at another board.

## Untested
- `setupConfig`, the dropdowns and `onConfigEdit` (Value suggestions after picking a filter column) were only
  checked by hand in one account.
- Sorting/grouping/filter logic was unit-tested with stand-in data; the monday filter rules for the default view were
  checked against the live API (23 courses).
- No test at other boards or other column types (people, numbers, mirror columns display text only).
