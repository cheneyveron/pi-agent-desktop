# Web profile

`npm run web` starts the dev server on `127.0.0.1` and opens `http://127.0.0.1:<port>` in the desktop browser after Next prints `Ready`. The default port is `30141`.

From WSL, the helper opens the Windows default browser with `powershell.exe -NoProfile -Command Start-Process '<url>'`. On macOS it uses `open`. On other Linux hosts it uses `xdg-open`.

`npm run dev` starts the same loopback server and does not open a browser.

```bash
npm run web
npm run web -- --no-open
npm run web -- -p 8080
npm run web -- --verbose
```

`--no-open` and `PI_WEB_NO_OPEN=1` print the URL and skip the browser. A non-empty `SSH_CONNECTION` or `SSH_TTY` does the same. The server stays up if the browser cannot be opened; the warning repeats the URL.

Production `pi-web` uses the same handoff. The printed URL is always `http://127.0.0.1:<port>`.

The npm package ships `lib/browser-open.js` and no other file from `lib/`.

## Terminal logging

Development request logging is quiet by default. Next's startup, compilation
diagnostics, browser warnings/errors and server warnings/errors remain visible;
routine session-start and skill-install diagnostics are hidden. HTTP access
records, including status-only 4xx/5xx records, are disabled through Next's
logging configuration. File responses, tool results and live UI events are unchanged.
Unknown stdout/stderr is forwarded through the existing launcher without filtering
or line buffering.

Use `npm run web -- --verbose` (or `-v`) to enable request timings and routine
application diagnostics. `PI_WEB_VERBOSE=1 npm run web` is equivalent; the
environment setting also accepts `true`, `yes` and `on` (case-insensitive).
Restart the server after changing it. Direct `npm run dev` also honors the
environment variable; production `pi-web --verbose` enables application diagnostics
but Next only emits access records in development.

Verbose access logs skip requests containing query strings, so query credentials
are not printed. Other request URLs, including file paths, may appear; response
bodies, tool outputs and raw skill-install arguments are never added to diagnostic
logging. Browser forwarding stays at warnings/errors and Server Function argument
logging stays disabled in both modes. Existing extension/dependency diagnostics
continue to pass through.

`PI_WEB_PERF=1` remains the separate opt-in server timing facility; its existing
coarse route names and durations do not include request bodies or file paths.
