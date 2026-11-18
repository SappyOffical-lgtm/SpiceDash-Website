# SpiceDash

## Run
Windows (Command Prompt), inside the project folder:
```
set OLA_MAPS_API_KEY=your_key_here
node server.js
```
macOS/Linux:
```
OLA_MAPS_API_KEY=your_key_here node server.js
```
Open http://localhost:3000 (Node 18+, no npm packages). Browser location only works on `localhost` or HTTPS.
Do not put quotes or trailing spaces around the key.

## Ola Maps API key
Sign up at https://maps.olakrutrim.com, create a project and create an API key in its credentials section.
The map, address lookup and drop-off search all use this one key. The key is visible in the browser,
so limit it to your domain in the Ola dashboard if it offers that option.
Without a key the site still works: live location sets pickup/drop-off, the map and address search are just off.

Ola's pricing changes on 1 September 2026 (prepaid credits, with a free allowance). Check the current free
limits on their pricing page before launch.

All Ola-specific details (SDK address, REST paths, map style) are in the `OLA` block at the top of `app.js`.
If Ola's documentation differs from what is there, change it in that one place.

## How pricing works
Everything is in `server.js`: time windows, zone multipliers, distance fee. The browser sends item
quantities and coordinates, and receives only final prices, so the rules never reach the page.
The server recalculates the price on every order and never trusts the browser's number.

To change rules, edit `TIME_WINDOWS`, `ZONES`, and the `FEE_*` constants. Time uses Asia/Kolkata.

Orders are appended to `orders.jsonl`.
